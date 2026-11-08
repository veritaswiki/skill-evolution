/**
 * 采集器（Collector）
 *
 * 订阅 DSH 会话生命周期事件，在回合结束时提取一份"可复盘快照"。
 *
 * 设计要点（全部来自 Hermes background_review 的实战约束）：
 *   1. **节流**：不是每个回合都值得复盘。纯问答轮次（无工具调用、无用户纠正）直接跳过。
 *   2. **有界**：快照必须有长度上限，否则一次长会话的复盘成本会失控。
 *   3. **不阻塞**：采集只做内存操作，绝不在事件回调里做 I/O 或 await 长任务。
 *   4. **可取消**：新回合到来时，未完成的复盘应被放弃（由 reflector 负责）。
 *
 * 触发信号判定（与提示词里的 signals 对应）：
 *   - 有复杂工具调用 → 可能产生"新技术/新调试路径"
 *   - 用户消息含纠正性措辞 → "user-correction"
 *   - 本次加载过技能（skill 工具被调用）→ 技能可能被证明是错的
 */

import fsSync from "node:fs";
import pathSync from "node:path";

/** 用户纠正性措辞（中英双语）。命中任一即视为一等技能信号。 */
const CORRECTION_PATTERNS = [
  /stop\s+doing/i,
  /too\s+verbose/i,
  /don'?t\s+(format|do|write)\s+like/i,
  /why\s+are\s+you\s+explaining/i,
  /just\s+(give\s+me|the)\s+(the\s+)?answer/i,
  /you\s+always\s+/i,
  /i\s+hate\s+(when|it|that)/i,
  /remember\s+this/i,
  /from\s+now\s+on/i,
  /不要这样/,
  /别这样/,
  /太啰嗦/,
  /太长了/,
  /你总是/,
  /我说过/,
  /记住/,
  /以后都/,
  /改成/,
  /应该是/,
  /不对/,
  /错了/,
  /改错了/,
  /不要解释/,
  /直接给/,
];

/** DSH 注入到 user/message 中的系统上下文块前缀（不应算作用户本人发言）。 */
const SYSTEM_INJECTION_MARKERS = [
  "Current runtime context. This snapshot supersedes",
  "<system-reminder>",
  "<available_skills>",
  "<hindsight_knowledge>",
  "<hindsight_memory>",
  "Nowledge Mem Context Bundle for this DSH session",
  "Nowledge Mem recall for this DSH turn",
  "Time sampled while preparing turn",
];

export function isSystemInjectedUserText(text) {
  if (typeof text !== "string" || !text) return false;
  const trimmed = text.trim();
  return SYSTEM_INJECTION_MARKERS.some((marker) => trimmed.startsWith(marker));
}

export function looksLikeCorrection(text) {
  if (typeof text !== "string" || !text) return false;
  if (isSystemInjectedUserText(text)) return false;
  return CORRECTION_PATTERNS.some((re) => re.test(text));
}

/** 从消息块里抽纯文本（兼容纯字符串、DSH ContentBlock 数组与对象）。 */
export function textOf(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object") {
          if (b.type === "tool-call") return "";
          if (typeof b.text === "string") return b.text;
          if (typeof b.content === "string") return b.content;
        }
        return "";
      })
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text.trim();
  }
  return "";
}

/** 解析工具参数（兼容对象与 JSON 字符串）。 */
function parseToolArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : { value: raw };
    } catch {
      return { value: raw };
    }
  }
  return {};
}

/**
 * 判断一个回合是否值得复盘。
 * 返回 { worth: boolean, signals: string[], reason: string }
 */
export function assessTurn({ userTexts, toolCalls, skillsLoaded }) {
  const signals = [];
  let worth = false;
  const reasons = [];

  // 用户纠正 → 一等信号，永远值得复盘
  const corrected = userTexts.some((t) => looksLikeCorrection(t));
  if (corrected) {
    signals.push("user-correction");
    worth = true;
    reasons.push("user correction detected");
  }

  // 加载过技能 → 技能可能被证明是错的
  if (skillsLoaded.length > 0) {
    signals.push("skill-was-wrong");
    worth = true;
    reasons.push(`skill(s) consulted: ${skillsLoaded.join(", ")}`);
  }

  // 工具调用：只有"复杂"才算新技术。
  // 单次 mv/cat/ls 这类原子操作不产生可复用教训——Hermes 的
  // "一次性任务叙事不是一类工作" 规则在这里落地。
  const validTools = toolCalls.filter((t) => t && t !== "?");
  const distinctTools = new Set(validTools);
  const complex = validTools.length >= 3 || distinctTools.size >= 2;
  if (complex) {
    signals.push("new-technique");
    worth = true;
    reasons.push(`${validTools.length} tool call(s) across ${distinctTools.size} tool(s)`);
  }

  if (!worth) {
    return {
      worth: false,
      signals: [],
      reason: validTools.length
        ? `${validTools.length} trivial tool call(s) — no reusable lesson`
        : "no tool calls, no correction, no skill consulted",
    };
  }
  return { worth: true, signals: [...new Set(signals)], reason: reasons.join("; ") };
}

/**
 * 从会话事件流构建一份有界快照。
 * 同时兼容：
 *   - 真实 DSH SessionEvent（字段在 `ev.data` / `ev.data.message` 下）
 *   - 单元测试简化事件（字段直接在 `ev` 顶层）
 *
 * @param {object[]} events  会话事件数组（按时间顺序）
 * @param {object} opts
 * @param {number} [opts.maxMessages=24]   保留的最近消息条数（对应 Hermes 的 tail=24）
 * @param {number} [opts.maxChars=24000]   快照总字符上限
 * @param {number} [opts.digestHead=300]   更早轮次压成摘要时每条保留的字符数
 */
export function buildSnapshot(events, opts = {}) {
  const maxMessages = opts.maxMessages ?? 24;
  const maxChars = opts.maxChars ?? 24000;
  const digestHead = opts.digestHead ?? 300;

  const messages = []; // { role, text, toolName? }
  const toolCalls = [];
  const skillsLoaded = [];
  const userTexts = [];

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const type = ev.type ?? ev.kind;
    const data = ev.data && typeof ev.data === "object" ? ev.data : ev;

    switch (type) {
      case "user/message": {
        const rawContent = data.content ?? data.message?.content ?? ev.content ?? ev.text;
        const text = textOf(rawContent);
        if (!text) break;
        // 跳过 DSH 自动注入的系统上下文块（如 runtime context / available_skills / memory recall）
        if (isSystemInjectedUserText(text)) break;
        messages.push({ role: "user", text });
        userTexts.push(text);
        break;
      }
      case "assistant/message": {
        const rawContent = data.message?.content ?? data.content ?? ev.content ?? ev.text;
        const text = textOf(rawContent);
        if (text) messages.push({ role: "assistant", text });
        break;
      }
      case "tool/call": {
        const toolName = data.name ?? data.toolName ?? ev.toolName ?? ev.name ?? ev.tool ?? "?";
        toolCalls.push(toolName);
        const argObj = parseToolArgs(data.arguments ?? data.args ?? data.input ?? ev.arguments ?? ev.args ?? ev.input);
        const argSummary = JSON.stringify(argObj).slice(0, 240);
        messages.push({ role: "assistant", text: `[tool_call: ${toolName}(${argSummary})]` });
        if (toolName === "skill") {
          const skillName = argObj?.name ?? argObj?.skill ?? (typeof argObj?.value === "string" ? argObj.value : "");
          if (skillName) skillsLoaded.push(String(skillName));
        }
        break;
      }
      case "tool/result": {
        const rawContent = data.message?.content ?? data.content ?? data.result ?? ev.content ?? ev.text ?? ev.result;
        const text = textOf(rawContent);
        if (text) messages.push({ role: "tool", text: text.slice(0, 1500) });
        break;
      }
      default:
        break;
    }
  }

  const assessment = assessTurn({ userTexts, toolCalls, skillsLoaded });

  // 有界化：保留最近 maxMessages 条原文，更早的压成摘要（对应 _digest_history）
  let kept = messages;
  let digest = "";
  if (messages.length > maxMessages) {
    let tail = maxMessages;
    // 保证保留段不以 tool 结果开头（否则模型看到孤立的工具输出）
    while (tail < messages.length && messages[messages.length - tail]?.role === "tool") tail += 1;
    kept = messages.slice(messages.length - tail);
    const older = messages.slice(0, messages.length - tail);
    const lines = [];
    for (const m of older) {
      const t = m.text.replace(/\s+/g, " ").slice(0, digestHead);
      if (m.role === "user") lines.push(`USER: ${t}`);
      else if (m.role === "assistant") lines.push(`ASSISTANT: ${t}`);
      else if (m.role === "tool") lines.push(`TOOL: ${t}`);
    }
    digest =
      "[Earlier conversation digest — older turns summarised to bound the review's cost. " +
      "Recent turns follow verbatim below.]\n" +
      lines.join("\n");
  }

  // 总字符上限：从尾部往前累加，超了就截断
  const parts = [];
  for (const m of kept) {
    const label = m.role === "user" ? "USER" : m.role === "assistant" ? "ASSISTANT" : "TOOL";
    parts.push(`${label}: ${m.text}`);
  }
  let body = parts.join("\n\n");
  if (digest) body = digest + "\n\n---\n\n" + body;
  if (body.length > maxChars) {
    body = "…[truncated to fit review budget]…\n\n" + body.slice(body.length - maxChars);
  }

  return {
    ...assessment,
    transcript: body,
    stats: {
      messages: messages.length,
      keptMessages: kept.length,
      toolCalls: toolCalls.filter((t) => t && t !== "?").length,
      skillsLoaded: [...new Set(skillsLoaded)],
      chars: body.length,
    },
  };
}

/**
 * 节流器：控制复盘频率，防止成本失控。
 *
 * 与 Hermes Curator 的 `interval_hours` / `min_idle_hours` 同构，
 * 但作用在"每次复盘"这一级而不是"每次 curator 运行"。
 */
export class Throttle {
  constructor({ minTurnsBetween = 3, minMinutesBetween = 5, persistPath = null } = {}) {
    this.minTurnsBetween = minTurnsBetween;
    this.minMsBetween = minMinutesBetween * 60 * 1000;
    this.persistPath = persistPath;
    this.turnCount = 0;
    this.lastRunAt = 0;
    this._load();
  }

  _load() {
    if (!this.persistPath) return;
    try {
      const raw = fsSync.readFileSync(this.persistPath, "utf8");
      const s = JSON.parse(raw);
      if (Number.isFinite(s.turnCount)) this.turnCount = s.turnCount;
      if (Number.isFinite(s.lastRunAt)) this.lastRunAt = s.lastRunAt;
    } catch {
      /* 首次运行或文件损坏：用默认值 */
    }
  }

  _save() {
    if (!this.persistPath) return;
    try {
      fsSync.mkdirSync(pathSync.dirname(this.persistPath), { recursive: true });
      fsSync.writeFileSync(
        this.persistPath,
        JSON.stringify({ turnCount: this.turnCount, lastRunAt: this.lastRunAt }),
        "utf8",
      );
    } catch {
      /* 遥测失败不阻断 */
    }
  }

  /** 记一个回合，返回该回合是否允许触发复盘。 */
  tick({ worth }) {
    this._load();
    this.turnCount += 1;
    if (!worth) {
      this._save();
      return false;
    }
    if (this.turnCount < this.minTurnsBetween) {
      this._save();
      return false;
    }
    const now = Date.now();
    if (now - this.lastRunAt < this.minMsBetween) {
      this._save();
      return false;
    }
    this.turnCount = 0;
    this.lastRunAt = now;
    this._save();
    return true;
  }

  /** 手动放行（用户显式触发时用）。 */
  force() {
    this.turnCount = 0;
    this.lastRunAt = Date.now();
    this._save();
  }
}
