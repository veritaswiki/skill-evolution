/**
 * 应用层（Applier）
 *
 * 把 Synthesizer 产出的文件内容安全落盘。
 *
 * 这是整条链路唯一碰磁盘的地方，也是所有护栏的汇合点：
 *   - 先过 provenance 归属检查（用户技能不许自动改）
 *   - 再捕获 before 快照（回滚依据）
 *   - 写入（create 走 staging → 提升；patch 走原地替换）
 *   - 最后记账
 *
 * 默认模式是 `draft`：只写 `.staging/`，不碰正式技能目录。
 * 这是专家团终裁明确要求的保守默认值。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { captureSnapshot, appendEntry } from "./ledger.js";
import { parseSkillMarkdown } from "./gatekeeper.js";
import { getCurrentWriteOrigin, mayAutoModify } from "./provenance.js";
import { bumpUsage } from "./usage.js";

export const STAGING_DIRNAME = ".staging";

/** 读一个技能的现有 SKILL.md；不存在返回 null。 */
export async function readExistingSkill(skillsRoot, name) {
  try {
    return await fs.readFile(path.join(skillsRoot, name, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

/** 列出技能根目录下所有技能目录（跳过隐藏目录）。 */
export async function listSkills(skillsRoot) {
  let entries;
  try {
    entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const text = await readExistingSkill(skillsRoot, e.name);
    if (!text) continue;
    const parsed = parseSkillMarkdown(text);
    out.push({
      name: e.name,
      description: parsed?.frontmatter?.description ?? "",
      createdBy: parsed?.frontmatter?.metadata?.createdBy ?? null,
    });
  }
  return out;
}

/**
 * 落盘一个候选产物。
 *
 * @param {string} skillsRoot
 * @param {object} synthesized  synthesize() 的结果
 * @param {object} opts
 * @param {"draft"|"apply"} [opts.mode="draft"]
 * @param {string} [opts.actor="curator"]
 * @param {object} [opts.extra]  写进账本的额外元数据
 * @returns {Promise<{ok: boolean, mode: string, written: string[], errors: string[], entryId?: string}>}
 */
export async function applySynthesis(skillsRoot, synthesized, opts = {}) {
  const mode = opts.mode === "apply" ? "apply" : "draft";
  const actor = opts.actor ?? "curator";
  const errors = [];
  const written = [];

  if (!synthesized?.ok) {
    return { ok: false, mode, written, errors: synthesized?.errors ?? ["synthesis failed"] };
  }
  if (synthesized.action === "nothing") {
    return { ok: true, mode, written, errors: [] };
  }

  const target = synthesized.meta?.target;
  if (!target) return { ok: false, mode, written, errors: ["no target skill"] };

  const existingText = await readExistingSkill(skillsRoot, target);
  const existingParsed = existingText ? parseSkillMarkdown(existingText) : null;

  // 护栏：自动复盘不得改写用户手写的技能（除非它自己创建的）
  if (existingText) {
    const meta = {
      createdBy: existingParsed?.frontmatter?.metadata?.createdBy ?? null,
    };
    if (!mayAutoModify(meta)) {
      return {
        ok: false,
        mode,
        written,
        errors: [
          `refusing to auto-modify "${target}": it was not created by the evolution loop ` +
            `(no metadata.createdBy: agent). User-authored skills belong to the user.`,
        ],
      };
    }
  }

  const before = existingText ? await captureSnapshot(skillsRoot, path.join(skillsRoot, target)) : null;

  const baseDir = mode === "draft" ? path.join(skillsRoot, STAGING_DIRNAME) : skillsRoot;

  try {
    for (const file of synthesized.files) {
      const dest = path.join(baseDir, file.path);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, file.content, "utf8");
      written.push(path.relative(skillsRoot, dest));
    }

    if (synthesized.meta?.briefing) {
      const briefPath = path.join(baseDir, target, ".briefing.json");
      await fs.mkdir(path.dirname(briefPath), { recursive: true });
      await fs.writeFile(briefPath, JSON.stringify(synthesized.meta.briefing, null, 2), "utf8");
    }

    const after = await captureSnapshot(baseDir, path.join(baseDir, target));

    const entryId = await appendEntry(skillsRoot, {
      action: mode === "draft" ? `draft_${synthesized.action}` : synthesized.action,
      target,
      actor,
      before,
      after,
      extra: {
        origin: getCurrentWriteOrigin(),
        rationale: synthesized.meta?.rationale,
        signals: synthesized.meta?.signals,
        confidence: synthesized.meta?.confidence,
        warnings: synthesized.warnings,
        ...(opts.extra ?? {}),
      },
    });

    // 只有真正落盘到正式目录才计入使用遥测
    if (mode === "apply") {
      await bumpUsage(skillsRoot, target, { createdBy: "agent" });
    }

    return { ok: true, mode, written, errors: [], entryId };
  } catch (error) {
    errors.push(String(error?.message ?? error));
    return { ok: false, mode, written, errors };
  }
}

/**
 * 把一个已审阅的草稿从 .staging/ 提升到正式技能目录。
 *
 * 这是"人工审阅后放行"的入口——也是 Phase 1 的收尾动作。
 */
export async function promoteDraft(skillsRoot, name, { actor = "user", comment = "", aiAnalysis = "", refinedContent = null } = {}) {
  const stagingSkill = path.join(skillsRoot, STAGING_DIRNAME, name);
  const finalSkill = path.join(skillsRoot, name);

  let files;
  try {
    files = await fs.readdir(stagingSkill, { recursive: true, withFileTypes: true });
  } catch (error) {
    return { ok: false, error: `no draft at ${stagingSkill}: ${error?.message ?? error}` };
  }

  const before = await captureSnapshot(skillsRoot, finalSkill);
  try {
    await fs.mkdir(finalSkill, { recursive: true });
    for (const f of files) {
      if (!f.isFile()) continue;
      const rel = path.relative(stagingSkill, path.join(f.parentPath ?? f.path, f.name));
      const src = path.join(stagingSkill, rel);
      const dest = path.join(finalSkill, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
    }
    if (typeof refinedContent === "string" && refinedContent.trim()) {
      await fs.writeFile(path.join(finalSkill, "SKILL.md"), refinedContent, "utf8");
    }
    const after = await captureSnapshot(skillsRoot, finalSkill);
    const entryId = await appendEntry(skillsRoot, {
      action: "promote",
      target: name,
      actor,
      before,
      after,
      extra: {
        from: STAGING_DIRNAME,
        ...(comment ? { userComment: comment } : {}),
        ...(aiAnalysis ? { aiAnalysis } : {}),
      },
    });
    await fs.rm(stagingSkill, { recursive: true, force: true });
    await bumpUsage(skillsRoot, name, { createdBy: "agent" });
    return { ok: true, entryId, aiAnalysis };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 列出待审阅的草稿。 */
export async function listDrafts(skillsRoot) {
  const staging = path.join(skillsRoot, STAGING_DIRNAME);
  let entries;
  try {
    entries = await fs.readdir(staging, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const text = await readExistingSkill(staging, e.name);
    const parsed = text ? parseSkillMarkdown(text) : null;
    out.push({ name: e.name, description: parsed?.frontmatter?.description ?? "", path: path.join(staging, e.name) });
  }
  return out;
}
