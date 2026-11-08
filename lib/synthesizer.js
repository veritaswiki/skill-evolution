/**
 * 蒸馏器（Synthesizer）
 *
 * 把复盘 fork 输出的结构化 JSON 转成可落盘的技能产物。
 *
 * 职责边界（刻意保持窄）：
 *   - 只做"JSON → 文件内容"的转换与结构校验
 *   - 不做安全检查（那是 gatekeeper 的事）
 *   - 不做落盘（那是应用层/审批层的事）
 *
 * 这样 Synthesizer 是纯函数，可以单独测试，也不会绕过闸门。
 */

import { gate, renderSkillMarkdown, parseSkillMarkdown, MAX_SKILL_BODY_CHARS } from "./gatekeeper.js";

/** 从模型输出里抽出那个 fenced JSON 块。 */
export function extractJsonBlock(text) {
  if (typeof text !== "string") return null;
  // 优先找 ```json 围栏
  const fenced = /```json\s*\n([\s\S]*?)```/i.exec(text);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  // 退路：找最后一个平衡的 {...}
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));

  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw.trim());
      if (parsed && typeof parsed === "object" && ("action" in parsed || "operations" in parsed)) return parsed;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/** 归一化模型给的 action，容忍常见拼写差异。 */
function normalizeAction(action) {
  const a = String(action ?? "").trim().toLowerCase();
  if (["create", "patch", "add_reference", "nothing"].includes(a)) return a;
  if (a === "update" || a === "edit") return "patch";
  if (a === "add-reference" || a === "reference") return "add_reference";
  if (a === "none" || a === "noop" || a === "no-op") return "nothing";
  return null;
}

/**
 * 把复盘输出转成候选产物。
 *
 * @param {object|null} review  extractJsonBlock 的结果
 * @param {object} [opts]
 * @param {boolean} [opts.existingSkill]  目标技能是否已存在（决定 create/patch 是否合理）
 * @returns {{ok: boolean, action: string, files: {path: string, content: string}[], errors: string[], warnings: string[], meta: object}}
 */
export function synthesize(review, opts = {}) {
  const empty = { ok: false, action: "nothing", files: [], errors: [], warnings: [], meta: {} };

  if (!review || typeof review !== "object") {
    return { ...empty, errors: ["no structured JSON block found in review output"] };
  }

  const action = normalizeAction(review.action);
  if (!action) {
    return { ...empty, errors: [`unknown action "${review.action}"`] };
  }
  if (action === "nothing") {
    return {
      ok: true,
      action: "nothing",
      files: [],
      errors: [],
      warnings: [],
      meta: { rationale: review.rationale ?? "", confidence: review.confidence ?? "high" },
    };
  }

  const target = String(review.target ?? "").trim();
  const body = typeof review.body === "string" ? review.body : "";

  // create / patch 需要 frontmatter；add_reference 不需要
  let frontmatter = review.frontmatter;
  if (action !== "add_reference") {
    if (!frontmatter || typeof frontmatter !== "object") {
      frontmatter = { name: target, description: "" };
    }
    // 容忍模型把 frontmatter 塞进 body 里
    if (body.startsWith("---")) {
      const parsed = parseSkillMarkdown(body);
      if (parsed) {
        frontmatter = { ...parsed.frontmatter, ...frontmatter };
        review = { ...review, body: parsed.body };
      }
    }
  }

  const candidate = {
    action,
    target,
    frontmatter,
    body: review.body ?? "",
    filePath: review.filePath,
  };

  const verdict = gate(candidate);
  const files = [];
  if (verdict.ok) {
    if (action === "add_reference") {
      files.push({ path: `${target}/${candidate.filePath}`, content: candidate.body.trim() + "\n" });
    } else {
      files.push({
        path: `${target}/SKILL.md`,
        content: renderSkillMarkdown(
          {
            name: frontmatter.name ?? target,
            description: frontmatter.description,
            ...(frontmatter.whenToUse ? { whenToUse: frontmatter.whenToUse } : {}),
            metadata: { createdBy: "agent", ...(frontmatter.metadata ?? {}) },
          },
          candidate.body,
        ),
      });
    }
  }

  const warnings = [...verdict.warnings];
  if (action === "create" && opts.existingSkill) {
    warnings.push(`action=create but skill "${target}" already exists — it will be treated as a patch`);
  }
  if (action === "patch" && opts.existingSkill === false) {
    warnings.push(`action=patch but skill "${target}" does not exist — it will be treated as a create`);
  }

  return {
    ok: verdict.ok,
    action,
    files,
    errors: verdict.errors,
    warnings,
    meta: {
      target,
      rationale: review.rationale ?? "",
      briefing: review.briefing && typeof review.briefing === "object" ? review.briefing : null,
      signals: Array.isArray(review.signals) ? review.signals : [],
      confidence: review.confidence ?? "medium",
    },
  };
}

/** 校验一个已存在的 SKILL.md 是否还能被安全 patch（长度不超限）。 */
export function canPatchExisting(existingText) {
  const parsed = parseSkillMarkdown(existingText);
  if (!parsed) return { ok: false, error: "existing SKILL.md has no parsable frontmatter" };
  if (parsed.body.length > MAX_SKILL_BODY_CHARS) {
    return {
      ok: false,
      error: `existing SKILL.md body is already ${parsed.body.length} chars (limit ${MAX_SKILL_BODY_CHARS}); consolidate before patching`,
    };
  }
  return { ok: true, parsed };
}
