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

/**
 * 转义字符串字面量里未转义的控制字符（真实换行/制表符会让 JSON.parse 直接失败）。
 * 模型产出长中文 body 时经常漏转义 `\n`，这是 `no JSON in output` 的另一大来源。
 */
function escapeControlCharsInStrings(src) {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (!inStr) {
      if (c === '"') inStr = true;
      out += c;
      continue;
    }
    if (esc) {
      out += c;
      esc = false;
      continue;
    }
    if (c === "\\") {
      out += c;
      esc = true;
      continue;
    }
    if (c === '"') {
      out += c;
      inStr = false;
      continue;
    }
    const code = c.charCodeAt(0);
    if (code < 0x20) {
      if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else out += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * 把一段可能被截断的 JSON 补齐到可解析状态。
 *
 * 复盘模型产出长中文 Markdown 时很容易撞上输出 token 上限，导致围栏闭合符、
 * 结尾的 `"` 与 `}` 全部缺失。此时直接 JSON.parse 必然失败，整轮复盘成果被丢弃
 * （线上表现就是 `status: error / no JSON in output`）。这里按字符状态机补全。
 */
function closeJsonString(src) {
  let s = String(src);
  if (!s.startsWith("{")) {
    const i = s.indexOf("{");
    if (i < 0) return null;
    s = s.slice(i);
  }

  // 扫一遍，记录最后一个“安全截断点”（闭合字符串之后 / 闭合容器之后 / 逗号处）
  const safePoints = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') {
        inStr = false;
        safePoints.push(i + 1);
      }
    } else if (c === '"') inStr = true;
    else if (c === "}" || c === "]") safePoints.push(i + 1);
    else if (c === ",") safePoints.push(i);
  }

  const tryClose = (head) => {
    let body = head.replace(/[,\s]+$/, "");
    // 去掉尾部悬空的 `"key":` 或 `"key": ` 片段
    body = body.replace(/,\s*"[^"\\]*"\s*:\s*$/, "").replace(/,\s*$/, "");

    let openString = false;
    let backslash = false;
    const stack = [];
    for (let i = 0; i < body.length; i += 1) {
      const c = body[i];
      if (openString) {
        if (backslash) backslash = false;
        else if (c === "\\") backslash = true;
        else if (c === '"') openString = false;
      } else if (c === '"') openString = true;
      else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
      else if (c === "}" || c === "]") {
        const want = stack.pop();
        if (!want || want !== c) return null;
      }
    }
    let out = body;
    if (openString) out += '"';
    while (stack.length) out += stack.pop();
    return escapeControlCharsInStrings(out);
  };

  // 优先补全整段（保留 body 等长字段的已产出部分），补不齐再逐级回退截断
  const attempts = [tryClose(s)];
  for (let k = safePoints.length - 1; k >= 0 && k >= safePoints.length - 60; k -= 1) {
    attempts.push(tryClose(s.slice(0, safePoints[k])));
  }
  return attempts;
}

/** 从模型输出里抽出那个 fenced JSON 块（容忍围栏缺失与输出截断）。 */
export function extractJsonBlock(text) {
  if (typeof text !== "string") return null;

  const candidates = [];
  // 1. 已闭合的围栏
  const closed = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  if (closed) candidates.push(closed[1]);
  // 2. 未闭合的围栏（输出被截断）
  const open = /```(?:json)?\s*\n([\s\S]*)$/i.exec(text);
  if (open) candidates.push(open[1]);
  // 3. 首尾大括号
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0) {
    if (lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));
    candidates.push(text.slice(firstBrace));
  }

  const accept = (raw) => {
    try {
      const parsed = JSON.parse(String(raw).trim());
      if (parsed && typeof parsed === "object" && ("action" in parsed || "operations" in parsed)) return parsed;
    } catch {
      /* 试下一个 */
    }
    return null;
  };

  // 第一轮：原文直接解析
  for (const raw of candidates) {
    const hit = accept(raw);
    if (hit) return hit;
  }
  // 第二轮：截断修复后解析
  for (const raw of candidates) {
    for (const repaired of closeJsonString(raw) ?? []) {
      if (!repaired) continue;
      const hit = accept(repaired);
      if (hit) return hit;
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
