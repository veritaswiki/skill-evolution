/**
 * 闸门（Gatekeeper）
 *
 * 技能是 Markdown 提示词，**没有可执行的单元测试**——所以"沙箱跑测试"这种
 * 闸门在这里不成立。真正的闸门是四道：
 *
 *   1. 结构校验：frontmatter 合法（name kebab-case、description 非空）
 *   2. 命名校验：类级别命名，拒绝会话产物（fix-X / debug-Y / PR 号 / 日期）
 *   3. 禁词表：移植 Hermes `_DO_NOT_CAPTURE_BLOCK` 的负面断言与环境依赖失败
 *   4. 干跑：写入 .staging/ 后用技能加载器验证可读，再决定是否落盘
 *
 * 第 3 道是整条链路里最重要的护栏。没有它，agent 会把自己写的
 * "X 工具不能用" 硬化成引用几个月的拒绝理由。
 */

/** 技能名必须是 kebab-case。 */
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * 会话产物式命名——这些名字只能描述"今天这件事"，不能描述"一类任务"。
 * 命中即拒绝（对应提示词 rule 4）。
 */
const SESSION_ARTIFACT_PATTERNS = [
  /^(fix|debug|audit|patch|repair|hotfix)-/i,
  /-(today|now|this-session|tmp|temp|wip)$/i,
  /#?\d{3,}/, // PR / issue 号
  /\b20\d{2}[-_]?\d{2}[-_]?\d{2}\b/, // 日期
  /^(pr|issue|ticket|bug)[-_]?\d+/i,
];

/** 这些词单独出现说明名字是库名/工具名而非任务类别。 */
const LIBRARY_ONLY_HINTS = new Set([
  "react", "vue", "python", "node", "npm", "git", "docker", "bash", "zsh", "curl", "jq", "yaml", "json",
]);

/**
 * 负面断言禁词表（移植 `_DO_NOT_CAPTURE_BLOCK` 第 2 条）。
 *
 * 这些句子一旦写进技能，会变成 agent 自我施加的永久约束。
 * 注意：这里只匹配"对工具/功能的否定断言"，不匹配正常的技术描述。
 */
const NEGATIVE_CLAIM_PATTERNS = [
  /\b\w+\s+(tool|tools|feature|command|api|plugin)s?\s+(does\s+not|doesn'?t|do\s+not|don'?t)\s+work/i,
  /\b(cannot|can'?t|unable\s+to)\s+(use|run|call|invoke)\s+\w+\s+(tool|feature|command|plugin)\b/i,
  /\b(tool|tools|feature|plugin)\s+is\s+(broken|unusable|not\s+working|buggy)\b/i,
  /\bnever\s+works?\b/i,
  /工具.{0,6}(不能用|不可用|坏了|有\s*bug)/,
  /无法(使用|调用|运行)\s*\w+工具/,
];

/**
 * 环境依赖失败禁词表（移植 `_DO_NOT_CAPTURE_BLOCK` 第 1 条）。
 *
 * 这类失败用户自己能修，写进技能就是噪音。
 */
const ENV_FAILURE_PATTERNS = [
  /command\s+not\s+found/i,
  /no\s+such\s+file\s+or\s+directory/i,
  /permission\s+denied/i,
  /(not|isn'?t)\s+installed\b/i,
  /\bunconfigured\b/i,
  /\bmissing\s+(binary|dependency|package|credential)s?\b/i,
  /找不到命令/,
  /没有安装/,
  /未配置/,
];

/** 一次性任务叙事（移植 `_DO_NOT_CAPTURE_BLOCK` 第 4 条）。 */
const ONE_OFF_PATTERNS = [
  /\b(summari[sz]e|analy[sz]e)\s+(today'?s|this|the)\s+(market|pr|report|data)\b/i,
  /总结(今天|本次|这个)/,
];

/**
 * 校验技能名。
 * @returns {{ok: boolean, error?: string}}
 */
export function validateSkillName(name) {
  if (typeof name !== "string" || !name.trim()) {
    return { ok: false, error: "skill name is empty" };
  }
  const n = name.trim();
  if (!KEBAB.test(n)) {
    return { ok: false, error: `skill name "${n}" is not kebab-case (lowercase letters, digits, single hyphens)` };
  }
  if (n.length > 64) {
    return { ok: false, error: `skill name "${n}" is too long (max 64 chars)` };
  }
  for (const re of SESSION_ARTIFACT_PATTERNS) {
    if (re.test(n)) {
      return {
        ok: false,
        error:
          `skill name "${n}" looks like a session artifact, not a class of task. ` +
          `Names must be class-level (e.g. "cordis-plugin-development"), never fix-X / debug-Y / PR numbers / dates.`,
      };
    }
  }
  if (LIBRARY_ONLY_HINTS.has(n)) {
    return { ok: false, error: `skill name "${n}" is a bare library name; name the class of task instead` };
  }
  return { ok: true };
}

/**
 * 扫描正文里的禁词。返回命中列表。
 * @returns {{ok: boolean, violations: {kind: string, match: string}[]}}
 */
export function scanForbiddenContent(text) {
  const violations = [];
  if (typeof text !== "string") return { ok: true, violations };
  const checks = [
    ["negative-claim", NEGATIVE_CLAIM_PATTERNS],
    ["env-failure", ENV_FAILURE_PATTERNS],
    ["one-off-narrative", ONE_OFF_PATTERNS],
  ];
  for (const [kind, patterns] of checks) {
    for (const re of patterns) {
      const m = re.exec(text);
      if (m) violations.push({ kind, match: m[0] });
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * 校验 frontmatter 对象。
 * @returns {{ok: boolean, error?: string}}
 */
export function validateFrontmatter(fm) {
  if (!fm || typeof fm !== "object") return { ok: false, error: "frontmatter missing" };
  const nameCheck = validateSkillName(fm.name);
  if (!nameCheck.ok) return nameCheck;
  if (typeof fm.description !== "string" || !fm.description.trim()) {
    return { ok: false, error: "frontmatter.description is required and must be non-empty" };
  }
  if (fm.description.length > 500) {
    return { ok: false, error: `frontmatter.description is too long (${fm.description.length} > 500 chars)` };
  }
  return { ok: true };
}

/** SKILL.md 正文长度上限。超过即拒绝——防止长引用让下次会话的 context 爆炸。 */
export const MAX_SKILL_BODY_CHARS = 24000;

/**
 * 完整闸门：对一个候选产物做全部静态检查。
 *
 * @param {object} candidate
 * @param {"create"|"patch"|"add_reference"} candidate.action
 * @param {string} candidate.target
 * @param {object} [candidate.frontmatter]
 * @param {string} candidate.body
 * @param {string} [candidate.filePath]
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function gate(candidate) {
  const errors = [];
  const warnings = [];

  const nameCheck = validateSkillName(candidate.target);
  if (!nameCheck.ok) errors.push(nameCheck.error);

  if (candidate.action === "add_reference") {
    const fp = candidate.filePath ?? "";
    if (!/^references\/[a-z0-9][a-z0-9._-]*\.md$/.test(fp)) {
      errors.push(`add_reference filePath must match references/<topic>.md, got "${fp}"`);
    }
    if (/\d{4}-\d{2}-\d{2}/.test(fp)) {
      errors.push(`reference filename must be topical, never date-stamped: "${fp}"`);
    }
  } else {
    const fmCheck = validateFrontmatter(candidate.frontmatter);
    if (!fmCheck.ok) errors.push(fmCheck.error);
    if (candidate.frontmatter?.name && candidate.frontmatter.name !== candidate.target) {
      errors.push(`frontmatter.name "${candidate.frontmatter.name}" != target "${candidate.target}"`);
    }
  }

  if (typeof candidate.body !== "string" || !candidate.body.trim()) {
    errors.push("body is empty");
  } else {
    if (candidate.body.length > MAX_SKILL_BODY_CHARS) {
      errors.push(
        `body is ${candidate.body.length} chars, over the ${MAX_SKILL_BODY_CHARS} limit — ` +
          `split depth into references/ instead of growing SKILL.md`,
      );
    }
    const scan = scanForbiddenContent(candidate.body);
    for (const v of scan.violations) {
      errors.push(
        `forbidden content (${v.kind}): "${v.match}" — ` +
          (v.kind === "negative-claim"
            ? "negative claims about tools harden into refusals the agent cites against itself for months"
            : v.kind === "env-failure"
              ? "environment-dependent failures are fixable by the user, not durable rules"
              : "one-off task narratives are not a class of work"),
      );
    }
    // 软检查：追加式修补是坏味道
    if (/\bUPDATE:\s*(actually|correction)/i.test(candidate.body)) {
      warnings.push("body contains 'UPDATE: actually...' — fix the misleading sentence in place instead of appending");
    }
    if (/^#\s+.*\b(v\d+|version)\b/im.test(candidate.body)) {
      warnings.push("body appears to embed a version header; skills should not carry version numbers");
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 把 frontmatter 对象 + body 组装成完整 SKILL.md 文本。 */
export function renderSkillMarkdown(frontmatter, body) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "object") {
      lines.push(`${k}:`);
      for (const [sk, sv] of Object.entries(v)) lines.push(`  ${sk}: ${JSON.stringify(sv)}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push("---", "", body.trim(), "");
  return lines.join("\n");
}

/** 从 SKILL.md 文本里解析 frontmatter（极简 YAML 子集，够用即可）。 */
export function parseSkillMarkdown(text) {
  if (typeof text !== "string") return null;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const fm = {};
  let nestedKey = null;
  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;

    // 缩进行 = 上一层 key 的子键（只支持一层嵌套，够 renderSkillMarkdown 用）
    const indented = /^\s+\S/.test(raw);
    if (indented && nestedKey) {
      const sub = raw.trim();
      const sIdx = sub.indexOf(":");
      if (sIdx < 0) continue;
      const sk = sub.slice(0, sIdx).trim();
      let sv = sub.slice(sIdx + 1).trim();
      if (sv.startsWith('"') && sv.endsWith('"')) {
        try {
          sv = JSON.parse(sv);
        } catch {
          sv = sv.slice(1, -1);
        }
      }
      if (sk && typeof fm[nestedKey] === "object" && fm[nestedKey] !== null) fm[nestedKey][sk] = sv;
      continue;
    }

    const line = raw.trimEnd();
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (!key) continue;
    if (value === "") {
      // 可能是嵌套块的开始
      fm[key] = {};
      nestedKey = key;
      continue;
    }
    nestedKey = null;
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    }
    fm[key] = value;
  }
  // 空对象没有子键 → 还原成空字符串，保持与旧行为一致
  for (const [k, v] of Object.entries(fm)) {
    if (v && typeof v === "object" && Object.keys(v).length === 0) fm[k] = "";
  }
  return { frontmatter: fm, body: m[2] ?? "" };
}
