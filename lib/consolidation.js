/**
 * Curator 合并执行器（Consolidation）
 *
 * 移植自 Hermes `agent/curator.py` 的 LLM 合并 pass。
 *
 * 与 `usage.js` 的分工：
 *   - `usage.js` 做**确定性**状态转换（active/stale/archived），不需要模型
 *   - 本模块做 **LLM 驱动**的建伞合并，需要模型判断
 *
 * Hermes 的核心洞察（写在 CURATOR_REVIEW_PROMPT 里）：
 *   几百个各捕获一次会话 bug 的窄技能是**失败**，不是特性。
 *   一个带小节的宽伞技能在可发现性上胜过五个窄兄弟。
 *
 * 不变量（全部来自 Hermes）：
 *   1. 永不删除，只归档
 *   2. pinned / protected 技能完全跳过
 *   3. 归档必须带 `absorbedInto`（吸收目标），无目标的归档属于确定性修剪，不归这里
 *   4. 每次操作都走账本，可回滚
 *   5. 包完整性：有 support 文件的技能不能只搬 SKILL.md
 */

import fs from "node:fs/promises";
import path from "node:path";

import { captureSnapshot, appendEntry } from "./ledger.js";
import { parseSkillMarkdown, renderSkillMarkdown, gate, validateSkillName } from "./gatekeeper.js";
import { listSkills, readExistingSkill } from "./applier.js";
import { archiveSkill, loadUsage, entryOf, PROTECTED_SKILLS } from "./usage.js";
import { buildCuratorPrompt } from "./prompts.js";
import { extractJsonBlock } from "./synthesizer.js";

/** 从模型输出里抽结构化合并结果。 */
export function extractCuratorOps(text) {
  const parsed = extractJsonBlock(text);
  if (!parsed) return { ok: false, error: "no JSON block in curator output", ops: [], summary: "" };
  const ops = Array.isArray(parsed.operations) ? parsed.operations : [];
  return { ok: true, ops, summary: String(parsed.summary ?? "") };
}

/** 列出可参与合并的候选技能（已过滤 pinned / protected，并附上完整正文供 Curator LLM 蒸馏合并）。 */
export async function listConsolidationCandidates(skillsRoot) {
  const skills = await listSkills(skillsRoot);
  const usage = await loadUsage(skillsRoot);
  const out = [];
  for (const s of skills) {
    const u = entryOf(usage, s.name);
    if (u.pinned || PROTECTED_SKILLS.has(s.name)) continue;
    const raw = await readExistingSkill(skillsRoot, s.name);
    const parsed = raw ? parseSkillMarkdown(raw) : null;
    out.push({
      ...s,
      useCount: u.useCount,
      state: u.state,
      pinned: u.pinned,
      body: (parsed?.body ?? "").slice(0, 4000),
    });
  }
  return out;
}

/**
 * 校验一组合并操作是否安全可执行。
 * 这是"闸门"——任何一条不合规，整批拒绝（原子性）。
 *
 * @returns {{ok: boolean, errors: string[], normalized: object[]}}
 */
export function validateCuratorOps(ops, { existingNames = new Set(), protectedNames = new Set() } = {}) {
  const errors = [];
  const normalized = [];
  const willCreate = new Set();

  for (const raw of ops) {
    if (!raw || typeof raw !== "object") {
      errors.push("operation is not an object");
      continue;
    }
    const op = String(raw.op ?? "").trim();

    if (op === "archive") {
      const target = String(raw.target ?? "").trim();
      const absorbedInto = String(raw.absorbedInto ?? raw.absorbed_into ?? "").trim();
      if (!target) errors.push("archive: missing target");
      if (protectedNames.has(target) || PROTECTED_SKILLS.has(target)) {
        errors.push(`archive: "${target}" is protected and must never be archived`);
        continue;
      }
      if (!absorbedInto) {
        errors.push(
          `archive "${target}": missing absorbedInto — archiving without an absorption target is the ` +
            `deterministic staleness pass's job, not the curator's`,
        );
        continue;
      }
      if (!existingNames.has(absorbedInto) && !willCreate.has(absorbedInto)) {
        errors.push(`archive "${target}": absorbedInto "${absorbedInto}" does not exist and is not created in this batch`);
        continue;
      }
      if (target === absorbedInto) {
        errors.push(`archive "${target}": absorbedInto is itself`);
        continue;
      }
      normalized.push({ op: "archive", target, absorbedInto, reason: String(raw.reason ?? "") });
      continue;
    }

    if (op === "create") {
      const target = String(raw.target ?? "").trim();
      const nameCheck = validateSkillName(target);
      if (!nameCheck.ok) {
        errors.push(`create: ${nameCheck.error}`);
        continue;
      }
      const g = gate({
        action: "create",
        target,
        frontmatter: raw.frontmatter ?? { name: target, description: "" },
        body: String(raw.body ?? ""),
      });
      if (!g.ok) {
        errors.push(`create "${target}": ${g.errors.join("; ")}`);
        continue;
      }
      willCreate.add(target);
      normalized.push({
        op: "create",
        target,
        frontmatter: raw.frontmatter ?? { name: target },
        body: String(raw.body ?? ""),
      });
      continue;
    }

    if (op === "patch") {
      const target = String(raw.target ?? "").trim();
      if (!existingNames.has(target)) {
        errors.push(`patch "${target}": skill does not exist`);
        continue;
      }
      if (protectedNames.has(target) || PROTECTED_SKILLS.has(target)) {
        errors.push(`patch "${target}": protected skill`);
        continue;
      }
      const body = String(raw.body ?? "");
      if (!body.trim()) {
        errors.push(`patch "${target}": empty body`);
        continue;
      }
      if (body.length > 24000) {
        errors.push(`patch "${target}": body ${body.length} chars over 24000 limit`);
        continue;
      }
      normalized.push({ op: "patch", target, body });
      continue;
    }

    if (op === "write_file") {
      const target = String(raw.target ?? "").trim();
      const filePath = String(raw.filePath ?? raw.file_path ?? "").trim();
      if (!existingNames.has(target) && !willCreate.has(target)) {
        errors.push(`write_file "${target}": skill does not exist`);
        continue;
      }
      if (!/^(references|templates|scripts|assets)\/[a-z0-9][a-z0-9._-]*\.[a-z0-9]+$/i.test(filePath)) {
        errors.push(`write_file "${target}": filePath must be references|templates|scripts|assets/<name>.<ext>, got "${filePath}"`);
        continue;
      }
      if (!String(raw.body ?? "").trim()) {
        errors.push(`write_file "${target}": empty body`);
        continue;
      }
      normalized.push({ op: "write_file", target, filePath, body: String(raw.body ?? "") });
      continue;
    }

    errors.push(`unknown operation "${op}"`);
  }

  return { ok: errors.length === 0, errors, normalized };
}

/**
 * 执行一批合并操作。
 *
 * 顺序很重要：create → patch → write_file → archive。
 * 归档放最后，确保吸收目标已经存在。
 */
export async function applyCuratorOps(skillsRoot, normalized, { actor = "curator" } = {}) {
  const done = [];
  const errors = [];

  const order = { create: 0, patch: 1, write_file: 2, archive: 3 };
  const sorted = [...normalized].sort((a, b) => (order[a.op] ?? 9) - (order[b.op] ?? 9));

  for (const op of sorted) {
    try {
      if (op.op === "create") {
        const dir = path.join(skillsRoot, op.target);
        const before = await captureSnapshot(skillsRoot, dir);
        await fs.mkdir(dir, { recursive: true });
        const md = renderSkillMarkdown(
          {
            name: op.frontmatter.name ?? op.target,
            description: op.frontmatter.description ?? "",
            metadata: { createdBy: "agent", ...(op.frontmatter.metadata ?? {}) },
          },
          op.body,
        );
        await fs.writeFile(path.join(dir, "SKILL.md"), md, "utf8");
        const after = await captureSnapshot(skillsRoot, dir);
        await appendEntry(skillsRoot, { action: "curator_create", target: op.target, actor, before, after });
        done.push(`create ${op.target}`);
        continue;
      }

      if (op.op === "patch") {
        const dir = path.join(skillsRoot, op.target);
        const existing = await readExistingSkill(skillsRoot, op.target);
        if (!existing) {
          errors.push(`patch ${op.target}: vanished`);
          continue;
        }
        const parsed = parseSkillMarkdown(existing);
        const before = await captureSnapshot(skillsRoot, dir);
        const md = renderSkillMarkdown(
          { ...(parsed?.frontmatter ?? { name: op.target }), metadata: { ...(parsed?.frontmatter?.metadata ?? {}), createdBy: "agent" } },
          op.body,
        );
        await fs.writeFile(path.join(dir, "SKILL.md"), md, "utf8");
        const after = await captureSnapshot(skillsRoot, dir);
        await appendEntry(skillsRoot, { action: "curator_patch", target: op.target, actor, before, after });
        done.push(`patch ${op.target}`);
        continue;
      }

      if (op.op === "write_file") {
        const dir = path.join(skillsRoot, op.target);
        const dest = path.join(dir, op.filePath);
        const before = await captureSnapshot(skillsRoot, dir);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, op.body.trim() + "\n", "utf8");
        const after = await captureSnapshot(skillsRoot, dir);
        await appendEntry(skillsRoot, {
          action: "curator_write_file",
          target: op.target,
          actor,
          before,
          after,
          extra: { filePath: op.filePath },
        });
        done.push(`write_file ${op.target}/${op.filePath}`);
        continue;
      }

      if (op.op === "archive") {
        const dir = path.join(skillsRoot, op.target);
        const before = await captureSnapshot(skillsRoot, dir);
        const r = await archiveSkill(skillsRoot, op.target);
        if (!r.moved) {
          errors.push(`archive ${op.target}: ${r.error}`);
          continue;
        }
        await appendEntry(skillsRoot, {
          action: "curator_archive",
          target: op.target,
          actor,
          before,
          after: null,
          extra: { absorbedInto: op.absorbedInto, reason: op.reason, archivedTo: r.to },
        });
        done.push(`archive ${op.target} → ${op.absorbedInto}`);
        continue;
      }
    } catch (error) {
      errors.push(`${op.op} ${op.target}: ${error?.message ?? error}`);
    }
  }

  return { ok: errors.length === 0, done, errors };
}

/**
 * 运行一次完整的合并 pass。
 *
 * @param {string} skillsRoot
 * @param {object} ctx  Cordis 上下文（用于 fork 子代理）
 * @param {object} opts
 * @param {object} opts.parent        父 agent
 * @param {Function} opts.runFork      (prompt) => Promise<string>  执行只读 fork 并返回文本
 * @param {boolean} [opts.dryRun=true] 只分析不执行
 */
export async function runConsolidation(skillsRoot, opts = {}) {
  const candidates = await listConsolidationCandidates(skillsRoot);
  if (candidates.length < 2) {
    return { ok: true, skipped: true, reason: `only ${candidates.length} candidate(s); nothing to consolidate`, done: [], errors: [] };
  }

  const prompt = buildCuratorPrompt({
    candidates,
    protectedNames: [...PROTECTED_SKILLS],
  });

  if (typeof opts.runFork !== "function") {
    return { ok: false, error: "runFork is required", done: [], errors: ["no fork runner"] };
  }

  let raw;
  try {
    raw = await opts.runFork(prompt);
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), done: [], errors: [] };
  }

  const extracted = extractCuratorOps(raw);
  if (!extracted.ok) {
    return { ok: false, error: extracted.error, done: [], errors: [] };
  }
  if (extracted.ops.length === 0) {
    return { ok: true, skipped: true, reason: extracted.summary || "curator found nothing to merge", done: [], errors: [] };
  }

  const existingNames = new Set((await listSkills(skillsRoot)).map((s) => s.name));
  const verdict = validateCuratorOps(extracted.ops, {
    existingNames,
    protectedNames: PROTECTED_SKILLS,
  });

  if (!verdict.ok) {
    return { ok: false, error: "validation failed", errors: verdict.errors, done: [], summary: extracted.summary };
  }

  if (opts.dryRun !== false) {
    return {
      ok: true,
      dryRun: true,
      summary: extracted.summary,
      planned: verdict.normalized.map((o) => `${o.op} ${o.target}${o.absorbedInto ? " → " + o.absorbedInto : ""}`),
      done: [],
      errors: [],
    };
  }

  const applied = await applyCuratorOps(skillsRoot, verdict.normalized);
  return { ok: applied.ok, summary: extracted.summary, done: applied.done, errors: applied.errors };
}
