/**
 * DSH 自进化（@local/dsh-evolution）
 *
 * 让 DSH 拥有 Hermes 的 closed learning loop：
 *   回合结束 → 采集快照 → fork 只读复盘 → 蒸馏成技能 → 闸门校验 → 落盘草稿 → 记账
 *
 * 设计原则：
 *   1. 不侵入 DSH 内核 —— 纯 @local 插件
 *   2. 复用而非重造 —— 技能格式/注册表/热更新全部复用 DSH 现有能力
 *   3. 默认保守 —— 只产草稿到 .staging/，不自动落盘
 *   4. 可回滚 —— 每次变更记账，支持单条回滚
 *   5. 不污染 —— 绝不自动写权威记忆层
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import z from "@deepseek-ai/schemastery";

import { buildSnapshot, Throttle } from "./lib/collector.js";
import { runReview, activeReviewChildIds } from "./lib/reflector.js";
import { synthesize } from "./lib/synthesizer.js";
import { applySynthesis, listDrafts, promoteDraft, listSkills } from "./lib/applier.js";
import { readEntries, rollbackEntry, maybeRotateLedger, gcBlobs } from "./lib/ledger.js";
import { applyAutomaticTransitions, adoptSkill, disownSkill } from "./lib/usage.js";
import { registerEvolutionHttp, buildSnapshot as buildHttpSnapshot, refineDraftWithComment } from "./lib/http-api.js";
import { runConsolidation } from "./lib/consolidation.js";

export const name = "skill-evolution";
export const inject = ["agents", "subagents", "commands", "tools"];

export const Config = z.object({
  enabled: z.boolean().default(true).description("是否启用 DSH 自进化复盘"),

  skillsRoot: z
    .string()
    .default("")
    .description("技能根目录（留空则用 ~/.dsh/skills）；账本、草稿、遥测都放这里"),

  mode: z
    .union(["draft", "apply"])
    .default("draft")
    .description("draft=只写 .staging/ 等人工审阅（推荐）；apply=通过闸门后直接落盘"),

  minTurnsBetween: z.number().default(3).description("两次复盘之间至少间隔多少个值得复盘的回合"),
  minMinutesBetween: z.number().default(5).description("两次复盘之间至少间隔多少分钟"),

  maxMessages: z.number().default(24).description("快照保留的最近消息条数"),
  maxChars: z.number().default(24000).description("快照总字符上限"),

  reviewTimeoutSeconds: z.number().default(180).description("单次复盘超时（秒）"),

  reviewModel: z
    .object({
      provider: z.string().default(""),
      model: z.string().default(""),
      reasoningEffort: z.string().default(""),
    })
    .default({ provider: "", model: "", reasoningEffort: "" })
    .description("复盘专用模型；留空则继承当前会话模型"),

  curatorEnabled: z.boolean().default(true).description("是否启用技能生命周期维护（active/stale/archived）"),
  consolidate: z.boolean().default(false).description("是否启用 LLM 建伞合并（把多个窄技能合并成类级别伞技能）"),
  consolidateDryRun: z.boolean().default(true).description("合并时只分析不执行（默认 true，确认无误后再关掉）"),
  staleAfterDays: z.number().default(14).description("多少天未使用标记为 stale"),
  archiveAfterDays: z.number().default(30).description("多少天未使用归档（永不删除）"),
});

function resolveSkillsRoot(config) {
  if (config.skillsRoot && config.skillsRoot.trim()) return path.resolve(config.skillsRoot.trim());
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(dshHome, "skills");
}

/** 从 DSH state 目录读回 UI 保存过的配置。 */
function loadPersistedSettings(config) {
  try {
    const stateDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "state");
    const file = path.join(stateDir, "dsh-evolution-settings.json");
    if (!fs.existsSync(file)) return;
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!saved || typeof saved !== "object") return;
    for (const key of [
      "enabled",
      "mode",
      "minTurnsBetween",
      "minMinutesBetween",
      "maxMessages",
      "maxChars",
      "reviewTimeoutSeconds",
      "curatorEnabled",
      "consolidate",
      "consolidateDryRun",
      "staleAfterDays",
      "archiveAfterDays",
    ]) {
      if (saved[key] !== undefined) config[key] = saved[key];
    }
    if (saved.reviewModel && typeof saved.reviewModel === "object") {
      config.reviewModel = { ...config.reviewModel, ...saved.reviewModel };
    }
  } catch {
    /* 损坏的配置文件忽略 */
  }
}

/** 从 live Session 读取持久化的相关事件（当内存缓冲为空时兜底）。 */
function extractSessionEvents(session) {
  if (!session || typeof session.seq !== "number" || typeof session.eventAt !== "function") return [];
  const out = [];
  const start = Math.max(0, session.seq - 240);
  for (let seq = start; seq < session.seq; seq += 1) {
    try {
      const ev = session.eventAt(seq);
      if (!ev) continue;
      const t = ev.type ?? ev.kind;
      if (t === "user/message" || t === "assistant/message" || t === "tool/call" || t === "tool/result") {
        out.push(ev);
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}


function writeLastReviewState(skillsRoot, data) {
  try {
    fs.mkdirSync(skillsRoot, { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, ".last_review.json"), JSON.stringify({ ts: new Date().toISOString(), ...data }, null, 2), "utf8");
  } catch {
    /* ignore */
  }
}

function collectTurnEvents(events, session) {
  if (Array.isArray(events) && events.length > 0) return events;
  return extractSessionEvents(session);
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...Config(rawConfig) };
  loadPersistedSettings(config);

  const skillsRoot = resolveSkillsRoot(config);
  const throttle = new Throttle({
    minTurnsBetween: config.minTurnsBetween,
    minMinutesBetween: config.minMinutesBetween,
    persistPath: path.join(skillsRoot, ".throttle.json"),
  });

  /** 每个会话的事件缓冲：sessionId -> events[] */
  const buffers = new Map();
  /** 每个会话正在跑的复盘：sessionId -> AbortController */
  const inflight = new Map();
  /** 每个会话正在跑的复盘 Promise（供 session/flush 在进程退出前等待）：sessionId -> Promise */
  const inflightPromises = new Map();

  ctx.logger?.info?.(`[dsh-evolution] loaded · enabled=${config.enabled} · skillsRoot=${skillsRoot} · mode=${config.mode}`);

  // ---- 1. 采集：订阅会话事件，缓冲到回合结束 ----
  const offEvent = ctx.on("session/event", (session, event) => {
    if (!config.enabled) return;
    if (!session?.id || !event) return;
    // 子代理会话（含复盘 fork 自身）绝不触发复盘，防止无限递归
    if (session.header?.origin === "subagent" || activeReviewChildIds.has(session.id)) return;

    const type = event.type ?? event.kind;
    if (!type) return;

    if (type === "turn/start") {
      if (!buffers.has(session.id)) buffers.set(session.id, []);
      // 新回合到来时打断同一会话上一次未完成的复盘
      inflight.get(session.id)?.abort();
      return;
    }

    let buf = buffers.get(session.id);
    if (!buf) {
      buf = [];
      buffers.set(session.id, buf);
    }

    if (type === "turn/end") {
      const snapshotEvents = [...buf];
      const p = handleTurnEnd(session, snapshotEvents, ctx, {
        config,
        skillsRoot,
        throttle,
        inflight,
        bypassThrottle: false,
      }).finally(() => {
        if (inflightPromises.get(session.id) === p) inflightPromises.delete(session.id);
      });
      inflightPromises.set(session.id, p);
      return;
    }

    // 只缓冲我们关心的类型，避免内存膨胀
    if (
      type === "user/message" ||
      type === "assistant/message" ||
      type === "tool/call" ||
      type === "tool/result"
    ) {
      buf.push(event);
      // 硬上限：单会话最多缓冲 500 条
      if (buf.length > 500) buf.splice(0, buf.length - 500);
    }
  });

  // ---- 1b. Flush 屏障：保证 headless 等短生命周期进程在退出前等待正在进行的复盘落盘 ----
  const offFlush = ctx.on("session/flush", async (session) => {
    if (!session?.id) return;
    const pending = inflightPromises.get(session.id);
    if (pending) {
      try {
        await pending;
      } catch {
        /* 复盘内部已自行捕获，不阻塞 session flush */
      }
    }
  });

  // ---- 2. 会话销毁时清理 ----
  const offDisposed = ctx.on("session/disposed", (session) => {
    if (!session?.id) return;
    buffers.delete(session.id);
    inflight.get(session.id)?.abort();
    inflight.delete(session.id);
    inflightPromises.delete(session.id);
  });

  // ---- 3. 定时 curator：生命周期维护 + LLM 建伞合并 + 账本轮转 + blob GC ----
  let curatorTimer;
  if (config.curatorEnabled) {
    const runCurator = async () => {
      try {
        // 3a. 确定性状态转换（不需要模型）
        const counts = await applyAutomaticTransitions(skillsRoot, {
          staleAfterDays: config.staleAfterDays,
          archiveAfterDays: config.archiveAfterDays,
        });
        if (counts.marked_stale || counts.archived || counts.reactivated) {
          ctx.logger?.info?.(
            `[dsh-evolution] curator: stale=${counts.marked_stale} archived=${counts.archived} reactivated=${counts.reactivated}`,
          );
        }

        // 3b. LLM 建伞合并（需要模型，可关闭）
        if (config.consolidate) {
          const agents = ctx.agents?.list?.() ?? [];
          const host = agents.find((a) => a?.session?.id) ?? null;
          const result = await runConsolidation(skillsRoot, {
            dryRun: config.consolidateDryRun,
            runFork: async (prompt) => {
              const r = await runReview(ctx, {
                parent: host ?? null,
                transcript: "",
                promptOverride: prompt,
                timeoutMs: config.reviewTimeoutSeconds * 1000,
              });
              return r.raw ?? "";
            },
          });
          if (result.done?.length) {
            ctx.logger?.info?.(`[dsh-evolution] curator consolidated: ${result.done.join("; ")}`);
          } else if (result.planned?.length) {
            ctx.logger?.info?.(`[dsh-evolution] curator (dry-run) planned: ${result.planned.join("; ")}`);
          } else if (result.skipped) {
            ctx.logger?.info?.(`[dsh-evolution] curator: ${result.reason}`);
          } else if (result.errors?.length) {
            ctx.logger?.warn?.(`[dsh-evolution] curator consolidation rejected: ${result.errors.join("; ")}`);
          }
        }

        // 3c. 账本维护
        await maybeRotateLedger(skillsRoot);
        await gcBlobs(skillsRoot);
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-evolution] curator failed: ${error?.message ?? error}`);
      }
    };
    // 启动 60 秒后跑一次，之后每 6 小时一次
    curatorTimer = setTimeout(() => {
      void runCurator();
      curatorTimer = setInterval(() => void runCurator(), 6 * 3600 * 1000);
      curatorTimer?.unref?.();
    }, 60_000);
    curatorTimer?.unref?.();
  }

  /** 手动触发一次复盘：用指定或当前活跃会话的最近事件。 */
  const triggerReview = async (targetAgent = null) => {
    const agents = ctx.agents?.list?.() ?? [];
    const rootAgents = agents.filter((a) => a?.session?.id && a.session.header?.origin !== "subagent");
    const agent = targetAgent ?? rootAgents[rootAgents.length - 1] ?? agents.find((a) => a?.session?.id) ?? null;
    if (!agent?.session) return { ok: false, error: "没有活跃会话可供复盘" };
    const events = collectTurnEvents(buffers.get(agent.session.id), agent.session);
    if (!events.length) return { ok: false, error: "当前会话没有可复盘的回合事件（需要至少一个含工具调用或纠正的回合）" };
    throttle.force();
    const res = await handleTurnEnd(agent.session, events, ctx, {
      config,
      skillsRoot,
      throttle,
      inflight,
      bypassThrottle: true,
    });
    return {
      ok: true,
      message: res?.written?.length
        ? `复盘完成：${res.action} "${res.target}" → ${res.written.join(", ")}`
        : `复盘完成：${res?.action ?? "nothing"}（${res?.reason ?? "无新增技能"}）`,
      detail: res,
    };
  };

  /** 供 UI / 命令手动触发的合并 pass。 */
  const triggerConsolidation = async ({ dryRun = true } = {}) => {
    const agents = ctx.agents?.list?.() ?? [];
    const host = agents.find((a) => a?.session?.id) ?? null;
    return runConsolidation(skillsRoot, {
      dryRun,
      runFork: async (prompt) => {
        const r = await runReview(ctx, {
          parent: host ?? null,
          transcript: "",
          promptOverride: prompt,
          timeoutMs: config.reviewTimeoutSeconds * 1000,
        });
        return r.raw ?? "";
      },
    });
  };

  // ---- 4. 注册用户命令：/evolution ----
  ctx.commands?.register?.({
    name: "evolution",
    description: "DSH 自进化：手机/聊天端中文简报审阅、带批示进化采纳、账本回滚与建伞合并",
    input: {
      hint: "brief [name] | approve <name> <批示> | refine <name> <批示> | reject <name> <批示> | status | drafts | skills | ledger | review | consolidate [--apply] | rollback <id>",
    },
    async handler(invocation) {
      const raw = String(invocation?.rawInput ?? "").trim();
      const parts = raw.split(/\s+/).filter(Boolean);
      const sub = parts[0] || "status";
      const ok = (text) => ({ kind: "success", text });
      const fail = (text) => ({ kind: "error", text });
      try {
        switch (sub) {
          case "brief":
          case "drafts": {
            const snap = await buildHttpSnapshot(skillsRoot, config);
            const targetName = parts[1];
            const list = targetName ? snap.drafts.filter((d) => d.name === targetName) : snap.drafts;
            if (!list.length) return ok("当前没有待审阅的技能草稿。");
            const blocks = list.map((d, i) => {
              const b = d.briefing || {};
              const rules = Array.isArray(b.keyRules) ? b.keyRules.map((r) => `  • ${r}`).join("\n") : "";
              return [
                `### 📋 待审草稿 #${i + 1}：\`${d.name}\` — ${b.titleZh || d.name}`,
                `- **类型**：${d.isPatch ? "现有技能升级补丁" : "新蒸馏类级技能"}`,
                `- **💡 这是什么**：${b.whatItIs || d.description || "(无描述)"}`,
                rules ? `- **📌 核心规则**：\n${rules}` : null,
                `- **✅ 同意后果**：${b.ifApprove || "升入正式技能库并立即生效"}`,
                `- **🚫 驳回后果**：${b.ifReject || "销毁草稿并记录驳回原因"}`,
                b.aiAnalysis ? `- **🤖 AI 批示融合汇报**：${b.aiAnalysis}` : null,
                `- **📱 手机/命令快捷批示**：`,
                `  - 修订预览：\`/evolution refine ${d.name} <您的批示想法>\``,
                `  - 进化采纳：\`/evolution approve ${d.name} <您的批示想法>\``,
                `  - 批示驳回：\`/evolution reject ${d.name} <您的驳回理由>\``,
              ]
                .filter(Boolean)
                .join("\n");
            });
            return ok(blocks.join("\n\n---\n\n"));
          }
          case "refine": {
            const target = parts[1];
            const comment = parts.slice(2).join(" ").trim();
            if (!target || !comment) return fail("用法：/evolution refine <skill-name> <您的批示/修改意见>");
            const r = await refineDraftWithComment(skillsRoot, target, comment, runPromptFork);
            if (!r.ok) return fail(`批示修订失败：${r.error}`);
            return ok(`🤖 AI 已根据您的批示修订草稿 "${target}"：\n\n${r.aiAnalysis}`);
          }
          case "approve":
          case "promote": {
            const target = parts[1];
            const comment = parts.slice(2).join(" ").trim();
            if (!target) return fail("用法：/evolution approve <skill-name> <您的批示>");
            if (!comment) return fail("请附上您的强制批示，例如：/evolution approve " + target + " 同意，按此规则入库");
            const refined = await refineDraftWithComment(skillsRoot, target, comment, runPromptFork);
            const r = await promoteDraft(skillsRoot, target, {
              actor: "user",
              comment,
              aiAnalysis: refined.ok ? refined.aiAnalysis : "",
              refinedContent: refined.ok ? refined.refinedContent : null,
            });
            if (!r.ok) return fail(`采纳失败：${r.error}`);
            return ok(
              `✅ 已按您的批示进化并采纳 "${target}" 到正式技能库！\n` +
                (refined.ok ? `\n🤖 AI 进化汇报：${refined.aiAnalysis}` : ""),
            );
          }
          case "reject":
          case "discard": {
            const target = parts[1];
            const comment = parts.slice(2).join(" ").trim();
            if (!target || !comment) return fail("用法：/evolution reject <skill-name> <您的驳回理由>");
            const stagingDir = path.join(skillsRoot, ".staging", target);
            fs.rmSync(stagingDir, { recursive: true, force: true });
            return ok(`🚫 已按您的批示驳回并销毁草稿 "${target}"（批示：${comment}）。`);
          }
          case "ledger": {
            const entries = await readEntries(skillsRoot, { limit: 20 });
            if (!entries.length) return ok("账本为空。");
            return ok(
              "最近账本记录：\n" +
                entries.map((e) => `- ${e.ts} ${e.action} ${e.target} (${e.actor}) id=${e.id}`).join("\n"),
            );
          }
          case "skills": {
            const skills = await listSkills(skillsRoot);
            if (!skills.length) return ok(`技能根目录为空：${skillsRoot}`);
            return ok(
              `技能（${skills.length}）：\n` +
                skills.map((s) => `- ${s.name}${s.createdBy === "agent" ? " [agent]" : ""} — ${s.description}`).join("\n"),
            );
          }
          case "promote": {
            const target = parts[1];
            if (!target) return fail("用法：/evolution promote <skill-name>");
            const r = await promoteDraft(skillsRoot, target);
            return r.ok ? ok(`已提升草稿 "${target}" 到正式技能目录。`) : fail(`提升失败：${r.error}`);
          }
          case "adopt": {
            const target = parts[1];
            if (!target) return fail("用法：/evolution adopt <skill-name>");
            const r = await adoptSkill(skillsRoot, target);
            return r.ok ? ok(`已接管技能 "${target}"。`) : fail(`接管失败：${r.error}`);
          }
          case "disown": {
            const target = parts[1];
            if (!target) return fail("用法：/evolution disown <skill-name>");
            const r = await disownSkill(skillsRoot, target);
            return r.ok ? ok(`已取消接管技能 "${target}"。`) : fail(`操作失败：${r.error}`);
          }
          case "rollback": {
            const id = parts[1];
            if (!id) return fail("用法：/evolution rollback <ledger-entry-id>");
            const r = await rollbackEntry(skillsRoot, id);
            return r.ok ? ok(`已回滚 ${r.restored} 个文件。`) : fail(`回滚失败：${r.error}`);
          }
          case "review": {
            const r = await triggerReview(invocation?.agent ?? null);
            return r.ok ? ok(r.message) : fail(r.error);
          }
          case "consolidate": {
            const applyFlag = parts.includes("--apply");
            const r = await triggerConsolidation({ dryRun: !applyFlag });
            if (!r.ok) return fail(`合并失败：${(r.errors || [r.error]).join("; ")}`);
            if (r.skipped) return ok(`合并跳过：${r.reason}`);
            if (r.dryRun) return ok(`合并预览（dry-run）：\n${(r.planned || []).map((x) => `- ${x}`).join("\n")}\n\n摘要：${r.summary}`);
            return ok(`合并已执行：\n${(r.done || []).map((x) => `- ${x}`).join("\n")}\n\n摘要：${r.summary}`);
          }
          case "status":
          default: {
            const drafts = await listDrafts(skillsRoot);
            const entries = await readEntries(skillsRoot);
            const skills = await listSkills(skillsRoot);
            return ok(
              [
                "DSH 自进化状态",
                `- 技能根目录：${skillsRoot}`,
                `- 模式：${config.mode}${config.mode === "draft" ? "（只产草稿，需人工审阅）" : "（自动落盘）"}`,
                `- 技能数：${skills.length}（其中 agent 创建：${skills.filter((s) => s.createdBy === "agent").length}）`,
                `- 待审阅草稿：${drafts.length}`,
                `- 账本记录：${entries.length}`,
                `- 节流：每 ${config.minTurnsBetween} 回合 / ${config.minMinutesBetween} 分钟最多一次`,
              ].join("\n"),
            );
          }
        }
      } catch (error) {
        return fail(`自进化命令失败：${error?.message ?? error}`);
      }
    },
  });

  // ---- 4b. 注册面向 DSH Go / 移动端的原生交互式工具：evolution_review_center ----
  const offTool = ctx.tools?.register?.({
    name: "evolution_review_center",
    description:
      "DSH 自进化移动端/DSH Go 审阅与批示中心。当用户在 DSH Go 手机端或聊天中询问“看看自进化待审稿”、“审阅自进化草稿”、“通过/驳回某个自进化技能”时调用。支持输出中文简报、弹出 DSH Go 原生交互式批示卡片（ask_user_question），并根据用户的批示由 AI 二次修订后升入正式技能库。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["brief", "interactive_review", "refine", "approve", "reject"],
          description:
            "brief=仅查看中文简报；interactive_review=弹出 DSH Go 原生问答卡片让用户点选或输入批示并自动执行（默认）；refine=按批示修订草稿；approve=按批示进化并采纳；reject=按批示驳回",
        },
        target: {
          type: "string",
          description: "目标草稿技能名（kebab-case）；留空则默认取第一个待审草稿或列出全部",
        },
        comment: {
          type: "string",
          description: "用户的审阅批示/想法（在 refine/approve/reject 时必填）",
        },
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value ?? "") }],
    },
    presentCall(args) {
      return {
        card: "generic",
        title: `🧬 自进化审阅中心 · ${args?.target || "待审草稿"}`,
        kind: "other",
      };
    },
    presentResult(_args, result) {
      return {
        card: "generic",
        title: "🧬 自进化审阅与批示结果",
        content: result.content,
      };
    },
    async execute(args, toolCtx) {
      const action = args?.action || "interactive_review";
      const snap = await buildHttpSnapshot(skillsRoot, config);
      const drafts = snap.drafts || [];
      if (!drafts.length) {
        return "当前没有待审阅的自进化技能草稿（正式技能库已有 " + (snap.stats?.skills || 0) + " 个技能）。";
      }

      const targetDraft = args?.target ? drafts.find((d) => d.name === args.target) : drafts[0];
      if (args?.target && !targetDraft) {
        return `未找到名为 "${args.target}" 的待审草稿。当前待审草稿有：${drafts.map((d) => d.name).join(", ")}`;
      }

      const formatBriefMarkdown = (d, idx = 0) => {
        const b = d.briefing || {};
        const rules = Array.isArray(b.keyRules) ? b.keyRules.map((r) => `  - ${r}`).join("\n") : "";
        return [
          `### 📋 待审草稿 #${idx + 1}：\`${d.name}\` — ${b.titleZh || d.name}`,
          `- **类型**：${d.isPatch ? "现有技能升级补丁" : "新蒸馏类级技能"}`,
          `- **💡 这是什么**：${b.whatItIs || d.description || "(无描述)"}`,
          rules ? `- **📌 提炼出的核心铁律**：\n${rules}` : null,
          `- **✅ 如果同意采纳**：${b.ifApprove || "升入正式技能库并立即生效"}`,
          `- **🚫 如果不同意驳回**：${b.ifReject || "销毁草稿并记录驳回原因"}`,
          b.aiAnalysis ? `- **🤖 AI 上次批示融合汇报**：${b.aiAnalysis}` : null,
        ]
          .filter(Boolean)
          .join("\n");
      };

      if (action === "brief") {
        return drafts.map((d, i) => formatBriefMarkdown(d, i)).join("\n\n---\n\n");
      }

      let comment = String(args?.comment ?? "").trim();
      let chosenAction = action;

      // DSH Go 原生交互卡片模式：通过 ctx.userQuestions.ask 在手机端弹出可点选/可输入自定义批示的原生卡片
      if (action === "interactive_review") {
        const userQuestions = ctx.get?.("userQuestions");
        const b = targetDraft.briefing || {};
        if (userQuestions?.ask && toolCtx?.agent) {
          const ans = await userQuestions.ask({
            agent: toolCtx.agent,
            questions: [
              {
                id: "directive",
                header: `审阅 ${targetDraft.name}`,
                question:
                  `【${b.titleZh || targetDraft.name}】\n` +
                  `💡 作用：${b.whatItIs || targetDraft.description}\n` +
                  `✅ 同意后果：${b.ifApprove}\n` +
                  `🚫 驳回后果：${b.ifReject}\n\n` +
                  `请选择预设批示，或在下方输入框直接填写您的自定义批示想法：`,
                options: [
                  {
                    label: "同意：转全中文规范后入库 (Recommended)",
                    description: "让 AI 将技能正文整理为清晰易读的中文规范，融合后升入正式技能库",
                  },
                  {
                    label: "同意：按当前提炼规则直接入库",
                    description: "认可当前提炼的步骤与防坑规则，直接升入正式技能库",
                  },
                  {
                    label: "仅修订草稿：先加上备份与安全检查要求",
                    description: "让 AI 先按批示改写草稿并汇报分析，暂不入库",
                  },
                  {
                    label: "不同意驳回：属于一次性偶发问题",
                    description: "销毁该草稿并将驳回原因记入账本",
                  },
                ],
              },
            ],
          });
          const item = ans?.answers?.find?.((a) => a.id === "directive") ?? ans?.answers?.[0];
          const customText = String(item?.custom ?? "").trim();
          const selectedText = Array.isArray(item?.selected) ? item.selected[0] || "" : "";
          comment = customText || selectedText;
          if (!comment) {
            return formatBriefMarkdown(targetDraft, 0) + "\n\n（您跳过了本次批示卡片，草稿保持待审状态。）";
          }
          if (comment.startsWith("不同意") || comment.startsWith("驳回")) {
            chosenAction = "reject";
          } else if (comment.startsWith("仅修订")) {
            chosenAction = "refine";
          } else {
            chosenAction = "approve";
          }
        } else {
          return (
            formatBriefMarkdown(targetDraft, 0) +
            `\n\n请直接回复您的批示（例如：“同意 ${targetDraft.name}，请转成中文后入库” 或 “驳回 ${targetDraft.name}，理由是…”）。`
          );
        }
      }

      if (!comment) {
        return `请提供您的强制批示（comment）后再执行 ${chosenAction}。`;
      }

      if (chosenAction === "refine") {
        const r = await refineDraftWithComment(skillsRoot, targetDraft.name, comment, runPromptFork);
        if (!r.ok) return `批示修订失败：${r.error}`;
        return `🤖 **AI 已根据您的批示修订草稿 \`${targetDraft.name}\`**\n\n- **您的批示**：${comment}\n- **AI 进化分析**：${r.aiAnalysis}`;
      }

      if (chosenAction === "reject") {
        const stagingDir = path.join(skillsRoot, ".staging", targetDraft.name);
        fs.rmSync(stagingDir, { recursive: true, force: true });
        return `🚫 **已按您的批示驳回并销毁草稿 \`${targetDraft.name}\`**\n- **驳回批示**：${comment}`;
      }

      // approve
      const refined = await refineDraftWithComment(skillsRoot, targetDraft.name, comment, runPromptFork);
      const r = await promoteDraft(skillsRoot, targetDraft.name, {
        actor: "user",
        comment,
        aiAnalysis: refined.ok ? refined.aiAnalysis : "",
        refinedContent: refined.ok ? refined.refinedContent : null,
      });
      if (!r.ok) return `采纳失败：${r.error}`;
      return (
        `✅ **已按您的批示完成自进化并升入正式技能库：\`${targetDraft.name}\`**\n\n` +
        `- **您的批示**：${comment}\n` +
        (refined.ok ? `- **🤖 AI 批示融合分析**：${refined.aiAnalysis}\n` : "") +
        `- **账本记录 ID**：\`${r.entryId}\``
      );
    },
  });

  // ---- 5. HTTP API（供 UI 读取真实数据）----
  const saveConfig = (patch) => {
    if (!patch || typeof patch !== "object") return;
    for (const key of [
      "enabled",
      "mode",
      "minTurnsBetween",
      "minMinutesBetween",
      "maxMessages",
      "maxChars",
      "reviewTimeoutSeconds",
      "curatorEnabled",
      "consolidate",
      "consolidateDryRun",
      "staleAfterDays",
      "archiveAfterDays",
    ]) {
      if (patch[key] !== undefined) config[key] = patch[key];
    }
    if (patch.reviewModel && typeof patch.reviewModel === "object") {
      config.reviewModel = { ...config.reviewModel, ...patch.reviewModel };
    }
    try {
      const stateDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "state");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "dsh-evolution-settings.json"),
        JSON.stringify(config, null, 2),
        "utf8",
      );
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-evolution] failed to persist settings: ${error?.message ?? error}`);
    }
  };

  const runPromptFork = async (prompt) => {
    const agents = ctx.agents?.list?.() ?? [];
    const host = agents.find((a) => a?.session?.id) ?? null;
    const r = await runReview(ctx, {
      parent: host ?? null,
      transcript: "",
      promptOverride: prompt,
      timeoutMs: config.reviewTimeoutSeconds * 1000,
    });
    return r.raw ?? "";
  };

  registerEvolutionHttp(ctx, {
    config,
    skillsRoot,
    saveConfig,
    triggerReview: () => triggerReview(null),
    runConsolidation: triggerConsolidation,
    runFork: runPromptFork,
  });

  // 清理
  return () => {
    offEvent?.();
    offFlush?.();
    offDisposed?.();
    offTool?.();
    if (curatorTimer) clearTimeout(curatorTimer);
    for (const c of inflight.values()) c.abort();
    inflight.clear();
    inflightPromises.clear();
    buffers.clear();
  };
}

/**
 * 回合结束处理：判定 → 节流 → 复盘 → 蒸馏 → 落盘。
 * 全程异步，绝不阻塞主对话；在 session/flush 时由 flush 屏障等待落盘完成。
 */
async function handleTurnEnd(session, events, ctx, { config, skillsRoot, throttle, inflight, bypassThrottle = false }) {
  try {
    const snapshot = buildSnapshot(collectTurnEvents(events, session), {
      maxMessages: config.maxMessages,
      maxChars: config.maxChars,
    });

    if (!snapshot.worth) {
      return { ok: true, action: "skipped", reason: snapshot.reason };
    }
    if (!bypassThrottle && !throttle.tick({ worth: true })) {
      return { ok: true, action: "throttled", reason: "throttled by turn/time window" };
    }

    writeLastReviewState(skillsRoot, { status: "running", sessionId: session.id, signals: snapshot.signals, chars: snapshot.stats.chars });
    // 新回合到来时放弃上一次未完成的复盘
    inflight.get(session.id)?.abort();
    const controller = new AbortController();
    inflight.set(session.id, controller);

    const skills = await listSkills(skillsRoot);
    const skillCatalog = skills.map((s) => `- ${s.name}: ${s.description}`);

    const reviewModel = config.reviewModel?.model
      ? {
          provider: config.reviewModel.provider,
          model: config.reviewModel.model,
          reasoningEffort: config.reviewModel.reasoningEffort || undefined,
        }
      : null;

    const parentAgent = ctx.agents?.get?.(session.id) ?? null;

    const result = await runReview(ctx, {
      parent: parentAgent,
      transcript: snapshot.transcript,
      signals: snapshot.signals,
      skillCatalog,
      model: reviewModel,
      timeoutMs: config.reviewTimeoutSeconds * 1000,
      signal: controller.signal,
    });

    if (controller.signal.aborted) {
      return { ok: false, action: "aborted", reason: "aborted by newer turn" };
    }
    if (!result.ok) {
      writeLastReviewState(skillsRoot, { status: "error", sessionId: session.id, error: result.error ?? "no JSON in output", rawPreview: (result.raw || "").slice(0, 400) });
      ctx.logger?.warn?.(`[dsh-evolution] review failed: ${result.error ?? "no JSON in output"}`);
      return { ok: false, action: "error", reason: result.error ?? "no JSON in output" };
    }

    const existingNames = new Set(skills.map((s) => s.name));
    const target = String(result.review?.target ?? "").trim();
    const synthesized = synthesize(result.review, {
      existingSkill: target ? existingNames.has(target) : undefined,
    });

    if (!synthesized.ok) {
      writeLastReviewState(skillsRoot, { status: "rejected", sessionId: session.id, errors: synthesized.errors, review: result.review });
      ctx.logger?.warn?.(`[dsh-evolution] gate rejected: ${synthesized.errors.join("; ")}`);
      return { ok: false, action: "rejected", reason: synthesized.errors.join("; ") };
    }
    if (synthesized.action === "nothing") {
      writeLastReviewState(skillsRoot, { status: "nothing", sessionId: session.id, rationale: synthesized.meta?.rationale || "nothing to save" });
      ctx.logger?.info?.("[dsh-evolution] review found nothing to save");
      return { ok: true, action: "nothing", reason: synthesized.meta?.rationale || "nothing to save" };
    }

    const applied = await applySynthesis(skillsRoot, synthesized, {
      mode: config.mode,
      actor: "curator",
      extra: { signals: snapshot.signals, sessionId: session.id },
    });

    if (applied.ok) {
      writeLastReviewState(skillsRoot, { status: "saved", sessionId: session.id, mode: applied.mode, action: synthesized.action, target: synthesized.meta.target, written: applied.written, entryId: applied.entryId, rationale: synthesized.meta.rationale });
      ctx.logger?.info?.(
        `[dsh-evolution] ${applied.mode} ${synthesized.action} "${synthesized.meta.target}" → ${applied.written.join(", ")}`,
      );
      return {
        ok: true,
        action: `${applied.mode}_${synthesized.action}`,
        target: synthesized.meta.target,
        written: applied.written,
        entryId: applied.entryId,
      };
    }
    ctx.logger?.warn?.(`[dsh-evolution] apply failed: ${applied.errors.join("; ")}`);
    return { ok: false, action: "apply_failed", reason: applied.errors.join("; ") };
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-evolution] turn-end handling failed: ${error?.message ?? error}`);
    return { ok: false, action: "exception", reason: String(error?.message ?? error) };
  } finally {
    inflight.delete(session.id);
  }
}
