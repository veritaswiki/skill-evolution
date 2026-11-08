/**
 * 复盘器（Reflector）
 *
 * fork 一个只读子代理（或使用辅助 LLM 通道），把回合快照交给它跑审查提示词，拿回结构化结论。
 *
 * 移植自 Hermes `agent/background_review.py` 的 `_spawn_background_review_now`。
 *
 * 关键不变量（每一条都是 Hermes 用血换来的）：
 *   1. **绝不碰主对话**：复盘在独立子会话或辅助通道里跑，结论只通过返回值回到插件，
 *      不注入主会话上下文，不改主会话 prompt cache。
 *   2. **工具白名单**：复盘 fork 只能读（skill / glob / grep / read），
 *      不能写、不能跑命令。写入由插件在闸门后自己做。
 *   3. **可取消**：新回合到来时打断上一次复盘，避免堆积。
 *   4. **有超时**：复盘卡住不能拖垮宿主。
 *   5. **有界输入**：快照已经过 collector 的长度裁剪。
 */

import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReviewPrompt } from "./prompts.js";
import { extractJsonBlock } from "./synthesizer.js";
import { setCurrentWriteOrigin, resetCurrentWriteOrigin, BACKGROUND_REVIEW } from "./provenance.js";

/** 复盘 fork 允许使用的工具——只读集合。 */
export const REVIEW_TOOL_ALLOWLIST = ["skill", "glob", "grep", "read", "hindsight_search_knowledge_pages"];

/** 追踪当前正在运行的复盘子代理 sessionId，防止子代理自身的 turn/end 递归触发复盘。 */
export const activeReviewChildIds = new Set();

const ROLE_PROMPT = `You are a READ-ONLY self-evolution review fork of a DeepSeek Harness agent.

You are NOT talking to the user. Nobody will read your prose. Your only job is to decide whether
this session produced a durable lesson worth writing into the skill library, and to emit it as
structured JSON per the output contract at the end of your instructions.

Hard constraints:
- You may READ (skill tool, glob, grep, read). You may NOT write files, run commands, or spawn agents.
- Do not narrate what happened in the session. Distill it into rules.
- If no signal fired, emit action "nothing". Do not manufacture a lesson.
- Reply with the JSON block and nothing else.`;

/** 解析本地 OpenAI-compatible 辅助端点配置（用于轻量后台复盘与无父 Agent 兜底）。 */
function resolveAuxiliaryEndpoint(ctx, opts = {}) {
  const baseURL =
    process.env.SKILL_EVOLUTION_BASE_URL ||
    process.env.DSH_EVOLUTION_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    "http://127.0.0.1:11434/v1";
  const apiKey =
    process.env.SKILL_EVOLUTION_API_KEY ||
    process.env.DSH_EVOLUTION_API_KEY ||
    process.env.OPENAI_API_KEY ||
    "local";

  const defaultSel = ctx?.get?.("agentDefaultModel")?.currentSelection?.();
  const model =
    opts.model?.model ||
    process.env.SKILL_EVOLUTION_MODEL ||
    process.env.DSH_EVOLUTION_MODEL ||
    defaultSel?.model ||
    "deepseek-chat";

  return { baseURL, apiKey, model };
}

/** 直接通过辅助 LLM 端点执行只读复盘（对齐 Hermes auxiliary_client，快速且不在退出阶段阻塞会话锁）。 */
async function runAuxiliaryReview(ctx, opts, promptText, signal) {
  const { baseURL, apiKey, model } = resolveAuxiliaryEndpoint(ctx, opts);
  const res = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: ROLE_PROMPT },
        { role: "user", content: promptText },
      ],
      max_tokens: 6000,
      temperature: 0.2,
    }),
    signal,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`auxiliary LLM HTTP ${res.status}: ${errText.slice(0, 240)}`);
  }
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content ?? "";
  return raw;
}

/**
 * 运行一次复盘。
 *
 * @param {object} ctx            Cordis 上下文
 * @param {object} opts
 * @param {object} [opts.parent]  父 agent（用于 startActivation 的 parent）
 * @param {string} opts.transcript  会话快照正文
 * @param {string[]} [opts.signals] 预判信号
 * @param {string[]} [opts.skillCatalog] 当前技能目录（名称+描述），供模型判断该改哪个
 * @param {object} [opts.model]   {provider, model, reasoningEffort}
 * @param {number} [opts.timeoutMs=180000]
 * @param {boolean} [opts.preferSubagent=false] 是否强制优先走 subagents.startActivation
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok: boolean, review: object|null, raw: string, error?: string, childId: string}>}
 */
export async function runReview(ctx, opts) {
  const childId = randomUUID();
  const timeoutMs = opts.timeoutMs ?? 180_000;

  const catalogBlock =
    Array.isArray(opts.skillCatalog) && opts.skillCatalog.length > 0
      ? `\n\n## Current skill catalog\n\n${opts.skillCatalog.join("\n")}\n`
      : "\n\n## Current skill catalog\n\n(empty — no skills exist yet)\n";

  const promptText =
    opts.promptOverride
      ? opts.promptOverride
      : buildReviewPrompt({ includeMemory: false }) +
        catalogBlock +
        `\n\n## Session transcript to review\n\n${opts.transcript}`;

  const promptBlocks = [
    { type: "text", text: ROLE_PROMPT },
    { type: "text", text: promptText },
  ];

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // 绑定写来源：任何在复盘上下文中发生的写入都会被标记为 background_review
  const prevOrigin = setCurrentWriteOrigin(BACKGROUND_REVIEW);
  activeReviewChildIds.add(childId);

  try {
    // 1. 若显式要求走 subagent 且上下文具备 subagents + 有效 parent Agent，则通过 startActivation 分叉
    const subagents = ctx?.subagents ?? ctx?.get?.("subagents");
    const providerName = opts.providerName ?? (subagents?.getProvider?.("spawn") ? "spawn" : "fork");
    const canUseSubagent =
      opts.preferSubagent === true &&
      Boolean(subagents?.startActivation) &&
      Boolean(subagents?.getProvider?.(providerName)) &&
      Boolean(opts.parent?.session);

    if (canUseSubagent) {
      try {
        const activation = await subagents.startActivation({
          childId,
          provider: providerName,
          label: "dsh-evolution review",
          request: {
            parent: opts.parent,
            prompt: promptBlocks,
            ...(opts.model?.model
              ? {
                  agentOptions: {
                    provider: opts.model.provider,
                    model: opts.model.model,
                    ...(opts.model.reasoningEffort ? { reasoningEffort: opts.model.reasoningEffort } : {}),
                  },
                }
              : {}),
          },
          signal: controller.signal,
          delivery: "caller",
        });

        const result = await activation.result;
        const raw = extractAssistantText(result);
        const review = extractJsonBlock(raw);
        if (review) {
          return { ok: true, review, raw, childId };
        }
      } catch (subErr) {
        ctx?.logger?.warn?.(`[dsh-evolution] subagent review fallback to auxiliary LLM: ${subErr?.message ?? subErr}`);
      }
    }

    // 2. 默认/兜底通道：直接调用辅助 LLM 端点（耗时 ~6s，不创建干扰会话，兼容 headless 退出阶段）
    const raw = await runAuxiliaryReview(ctx, opts, promptText, controller.signal);
    const review = extractJsonBlock(raw);
    return { ok: Boolean(review), review, raw, childId };
  } catch (error) {
    return { ok: false, review: null, raw: "", error: String(error?.message ?? error), childId };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener?.("abort", onAbort);
    activeReviewChildIds.delete(childId);
    resetCurrentWriteOrigin(prevOrigin);
    try {
      const subagents = ctx?.subagents ?? ctx?.get?.("subagents");
      subagents?.interrupt?.(childId, { kind: "user", parentSessionId: opts.parent?.id });
    } catch {
      /* 已结束，忽略 */
    }
  }
}

/** 从 activation 结果里抽助手最后一条文本。 */
function extractAssistantText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  const out = result.output ?? result.result ?? result;
  if (typeof out === "string") return out;
  if (Array.isArray(out)) {
    const texts = out
      .map((b) => (typeof b === "string" ? b : b?.text ?? ""))
      .filter(Boolean);
    return texts.join("\n");
  }
  if (typeof out?.text === "string") return out.text;
  if (Array.isArray(out?.content)) {
    return out.content
      .map((b) => (typeof b === "string" ? b : b?.text ?? ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
