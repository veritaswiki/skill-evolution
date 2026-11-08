/**
 * HTTP API —— 给 UI 提供真实数据
 *
 * 路由前缀 `/dsh-evolution/api/`：
 *   GET  status        整体状态（技能数、草稿数含全文与中文简报、账本数含 before/after SHA、lastReview、throttle、配置）
 *   GET  skills        技能列表（含生命周期状态、使用次数、是否 agent 创建、是否 adopted）
 *   GET  drafts        待审阅草稿（含完整 SKILL.md 内容与中文简报 briefing）
 *   GET  ledger        账本记录（分页）
 *   GET  ledger/:id    单条记录详情（含文件清单）
 *   GET  skill/:name   单个正式技能详情（含完整 SKILL.md 正文与 resources）
 *   GET  candidates    可参与建伞合并的候选技能
 *   POST refine-draft  根据用户的强制批示（comment），让 AI 分析并修订草稿与中文简报
 *   POST promote       带用户批示提升草稿 → 正式技能目录（支持先融合批示再落盘，并清理 .staging 草稿）
 *   POST discard       带用户批示丢弃草稿（记入账本防止重复踩坑）
 *   POST rollback      回滚某条账本记录
 *   POST pin           固定 / 取消固定技能
 *   POST adopt         纳管无 provenance 标记的技能
 *   POST disown        取消纳管技能
 *   POST consolidate   执行 LLM 建伞合并（dryRun: true 预览计划 / dryRun: false 实际执行）
 *   POST review        手动触发一次复盘（对当前会话）
 *   POST config        保存配置
 */

import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { readEntries, rollbackEntry, appendEntry, captureSnapshot } from "./ledger.js";
import { listSkills, listDrafts, promoteDraft, STAGING_DIRNAME } from "./applier.js";
import { loadUsage, entryOf, setUsageFlag, PROTECTED_SKILLS, adoptSkill, disownSkill, listUnmanaged } from "./usage.js";
import { runConsolidation, listConsolidationCandidates } from "./consolidation.js";
import { parseSkillMarkdown, renderSkillMarkdown } from "./gatekeeper.js";
import { extractJsonBlock } from "./synthesizer.js";

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req, limitBytes = 512 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readJsonFileSafe(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 从 Markdown 正文提取前几条要点，供无 .briefing.json 的旧草稿自动生成可读简报。 */
function buildFallbackBriefing(name, description, body, isPatch = false) {
  const lines = String(body || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(\d+\.|[-*•])\s+/.test(l))
    .slice(0, 4)
    .map((l) => l.replace(/^(\d+\.|[-*•])\s+/, "").replace(/\*\*/g, "").slice(0, 140));

  return {
    titleZh: `${name}（${isPatch ? "现有技能升级补丁" : "新蒸馏类级技能"}）`,
    whatItIs:
      description ||
      `从最近会话中自动提炼出的「${name}」标准化操作流程与防坑规则。`,
    keyRules: lines.length ? lines : ["按标准排查步骤顺序执行，避免盲目试错", "记录已验证的根因与修复命令"],
    ifApprove: isPatch
      ? `将更新正式技能库中的「${name}」（保留原版快照供随时回滚），后续遇到同类任务时 AI 会按升级后的流程执行。`
      : `将在正式技能库新增「${name}」并立即通过 DSH 热更新生效，后续遇到同类任务时 AI 会自动加载这套规则。`,
    ifReject: `将销毁该草稿并将您的驳回批示记入账本，不会改动现有正式技能库。`,
  };
}

/** 读一个技能的完整 SKILL.md、资源清单与中文简报。 */
async function readSkillDetail(skillsRoot, name, baseDir = skillsRoot, existingSkillNames = new Set()) {
  const dir = path.join(baseDir, name);
  const text = await fs.readFile(path.join(dir, "SKILL.md"), "utf8").catch(() => null);
  if (text === null) return null;
  const parsed = parseSkillMarkdown(text);
  const resources = [];
  for (const kind of ["references", "templates", "scripts", "assets"]) {
    const files = await fs.readdir(path.join(dir, kind)).catch(() => []);
    for (const f of files) resources.push(`${kind}/${f}`);
  }
  const savedBriefing = await readJsonFileSafe(path.join(dir, ".briefing.json"));
  const isPatch = existingSkillNames.has(name);
  const briefing =
    savedBriefing && typeof savedBriefing === "object"
      ? savedBriefing
      : buildFallbackBriefing(name, parsed?.frontmatter?.description ?? "", parsed?.body ?? "", isPatch);

  return {
    name,
    description: parsed?.frontmatter?.description ?? "",
    body: parsed?.body ?? "",
    frontmatter: parsed?.frontmatter ?? {},
    resources,
    briefing,
    isPatch,
    raw: text,
    path: dir,
  };
}

/** 构建完整状态快照（一次性给齐前端 5 个标签页所需的全部核心数据）。 */
export async function buildSnapshot(skillsRoot, config) {
  const [skills, rawDrafts, ledger, usage, lastReview, throttleState] = await Promise.all([
    listSkills(skillsRoot),
    listDrafts(skillsRoot),
    readEntries(skillsRoot),
    loadUsage(skillsRoot),
    readJsonFileSafe(path.join(skillsRoot, ".last_review.json")),
    readJsonFileSafe(path.join(skillsRoot, ".throttle.json")),
  ]);

  const existingSkillNames = new Set(skills.map((s) => s.name));

  // 为每个草稿附上完整 body / frontmatter / resources / briefing
  const drafts = [];
  for (const d of rawDrafts) {
    const detail = await readSkillDetail(
      skillsRoot,
      d.name,
      path.join(skillsRoot, STAGING_DIRNAME),
      existingSkillNames,
    );
    drafts.push(detail ? { ...d, ...detail } : d);
  }

  // 为每个正式技能附上 usage、生命周期、adopted 标记及完整 body/resources
  const enriched = [];
  for (const s of skills) {
    const u = entryOf(usage, s.name);
    const rawUsage = usage[s.name] ?? {};
    const detail = await readSkillDetail(skillsRoot, s.name, skillsRoot, existingSkillNames);
    enriched.push({
      ...s,
      state: u.state,
      pinned: u.pinned,
      useCount: u.useCount,
      lastUsedAt: u.lastUsedAt,
      createdAt: u.createdAt,
      adopted: Boolean(rawUsage.adopted),
      protected: PROTECTED_SKILLS.has(s.name),
      body: detail?.body ?? "",
      resources: detail?.resources ?? [],
      frontmatter: detail?.frontmatter ?? {},
      briefing: detail?.briefing ?? null,
    });
  }

  const byState = { active: 0, stale: 0, archived: 0 };
  for (const s of enriched) byState[s.state] = (byState[s.state] ?? 0) + 1;

  const agentCreated = enriched.filter((s) => s.createdBy === "agent").length;
  const unmanaged = await listUnmanaged(
    skillsRoot,
    skills.map((s) => s.name),
  );
  const candidates = enriched.filter((s) => !s.pinned && !s.protected);

  return {
    config: {
      enabled: config.enabled,
      mode: config.mode,
      skillsRoot,
      minTurnsBetween: config.minTurnsBetween,
      minMinutesBetween: config.minMinutesBetween,
      maxMessages: config.maxMessages,
      maxChars: config.maxChars,
      reviewTimeoutSeconds: config.reviewTimeoutSeconds,
      curatorEnabled: config.curatorEnabled,
      consolidate: config.consolidate,
      consolidateDryRun: config.consolidateDryRun,
      staleAfterDays: config.staleAfterDays,
      archiveAfterDays: config.archiveAfterDays,
      reviewModel: config.reviewModel,
    },
    stats: {
      skills: enriched.length,
      agentCreated,
      drafts: drafts.length,
      ledger: ledger.length,
      unmanaged: unmanaged.length,
      candidates: candidates.length,
      byState,
    },
    lastReview: lastReview ?? null,
    throttle: throttleState ?? { turnCount: 0, lastRunAt: 0 },
    unmanaged,
    skills: enriched,
    drafts,
    recentLedger: ledger
      .slice(-50)
      .reverse()
      .map((e) => ({
        id: e.id,
        ts: e.ts,
        action: e.action,
        target: e.target,
        actor: e.actor,
        rationale: e.extra?.rationale ?? e.extra?.reason ?? "",
        userComment: e.extra?.userComment ?? "",
        aiAnalysis: e.extra?.aiAnalysis ?? "",
        signals: e.extra?.signals ?? [],
        confidence: e.extra?.confidence ?? "",
        absorbedInto: e.extra?.absorbedInto ?? "",
        before: e.before ?? null,
        after: e.after ?? null,
        extra: e.extra ?? {},
        files: e.after?.files?.length ?? e.before?.files?.length ?? 0,
      })),
  };
}

/**
 * 根据用户的强制批示（comment），调用 AI 分析并修订草稿。
 */
export async function refineDraftWithComment(skillsRoot, name, comment, runFork) {
  const stagingDir = path.join(skillsRoot, STAGING_DIRNAME, name);
  const rawMd = await fs.readFile(path.join(stagingDir, "SKILL.md"), "utf8").catch(() => null);
  if (!rawMd) return { ok: false, error: `草稿 "${name}" 不存在` };

  const parsed = parseSkillMarkdown(rawMd);
  const oldBriefing = await readJsonFileSafe(path.join(stagingDir, ".briefing.json"));

  if (typeof runFork !== "function") {
    return { ok: false, error: "AI 复盘通道未就绪" };
  }

  const prompt = `你现在是 DSH 自进化引擎的「用户批示融合器」。
用户审阅了待审技能草稿 \`${name}\`，并下达了如下强制批示（用户的想法/修改意见）：

【用户批示】：
${comment}

【当前草稿 frontmatter】：
${JSON.stringify(parsed?.frontmatter ?? { name }, null, 2)}

【当前草稿正文】：
${parsed?.body ?? rawMd}

请你严格按照【用户批示】对这份技能草稿进行进化修订：
1. 如果原草稿是英文或可读性不佳，请将其重写为清晰、专业、可直接执行的简体中文（保留命令、路径与标识符）；
2. 将用户的批示要求、补充约束或修正意见无缝融入步骤（Procedure）与防坑规则（Pitfalls）中；
3. 输出一段中文「aiAnalysis」（向用户汇报你是如何理解并落实他的这条批示、如何通过这次自进化的）；
4. 只输出一个 fenced JSON 块，格式如下：

\`\`\`json
{
  "action": "patch",
  "aiAnalysis": "<向用户汇报：如何根据您的批示完成了本次自进化修订（2-4句中文）>",
  "frontmatter": {
    "name": "${name}",
    "description": "<修订后的一句话中文描述>"
  },
  "body": "<修订后的完整中文 Markdown 技能正文>",
  "briefing": {
    "titleZh": "<修订后的简短中文标题>",
    "whatItIs": "<用大白话中文总结这份技能的核心作用（已融合用户批示）>",
    "keyRules": ["<核心规则1>", "<核心规则2>", "<核心规则3>"],
    "ifApprove": "<同意采纳后的效果说明>",
    "ifReject": "<不同意驳回后的效果说明>"
  }
}
\`\`\``;

  const before = await captureSnapshot(path.join(skillsRoot, STAGING_DIRNAME), stagingDir);
  const rawOut = await runFork(prompt);
  const block = extractJsonBlock(rawOut);
  if (!block || !block.body) {
    return { ok: false, error: "AI 未能返回合法的修订 JSON" };
  }

  const nextFm = {
    ...(parsed?.frontmatter ?? {}),
    name,
    description: block.frontmatter?.description || parsed?.frontmatter?.description || "",
    metadata: {
      ...(parsed?.frontmatter?.metadata ?? {}),
      createdBy: "agent",
      lastUserDirective: comment,
    },
  };
  const nextMd = renderSkillMarkdown(nextFm, block.body);
  await fs.writeFile(path.join(stagingDir, "SKILL.md"), nextMd, "utf8");

  const nextBriefing = {
    ...(oldBriefing ?? {}),
    ...(block.briefing ?? {}),
    lastUserComment: comment,
    aiAnalysis: block.aiAnalysis || "已根据您的批示完成技能规则修订。",
  };
  await fs.writeFile(path.join(stagingDir, ".briefing.json"), JSON.stringify(nextBriefing, null, 2), "utf8");

  const after = await captureSnapshot(path.join(skillsRoot, STAGING_DIRNAME), stagingDir);
  await appendEntry(skillsRoot, {
    action: "draft_refine",
    target: name,
    actor: "user",
    before,
    after,
    extra: {
      userComment: comment,
      aiAnalysis: nextBriefing.aiAnalysis,
      rationale: `用户批示修订：${comment}`,
    },
  });

  return {
    ok: true,
    name,
    aiAnalysis: nextBriefing.aiAnalysis,
    briefing: nextBriefing,
    refinedContent: nextMd,
  };
}

/**
 * 注册 HTTP 路由。
 *
 * @param {object} ctx
 * @param {object} deps { config, skillsRoot, saveConfig, triggerReview, runConsolidation, runFork }
 */
const MOBILE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <title>DSH 自进化 · 手机审批台</title>
  <style>
    :root {
      --bg: #09090b; --card: #18181b; --layer: #27272a; --border: #3f3f46;
      --text: #f4f4f5; --sub: #a1a1aa; --brand: #8b7cf6; --ok: #34d399; --warn: #fbbf24; --err: #f87171;
    }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    body {
      margin: 0; background: var(--bg); color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
      font-size: 14px; line-height: 1.55;
      padding: calc(12px + env(safe-area-inset-top, 0px)) 14px calc(78px + env(safe-area-inset-bottom, 0px));
    }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
    .title { font-size: 18px; font-weight: 700; margin: 0; }
    .sub { font-size: 12px; color: var(--sub); margin-top: 2px; }
    .chip {
      display: inline-flex; align-items: center; gap: 4px; border-radius: 999px;
      padding: 3px 10px; font-size: 11px; font-weight: 600;
      border: 1px solid var(--border); background: var(--layer); color: var(--sub);
    }
    .chip-ok { color: #6ee7b7; border-color: rgba(52,211,153,.4); background: rgba(52,211,153,.12); }
    .chip-warn { color: #fde68a; border-color: rgba(251,191,36,.4); background: rgba(251,191,36,.12); }
    .chip-brand { color: #ddd6fe; border-color: rgba(139,124,246,.45); background: rgba(139,124,246,.16); }
    .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 9px; margin-bottom: 14px; }
    .stat { background: var(--card); border: 1px solid rgba(63,63,70,.7); border-radius: 12px; padding: 12px; }
    .stat-v { font-size: 20px; font-weight: 700; }
    .stat-l { font-size: 11.5px; color: var(--sub); }
    .card {
      background: var(--card); border: 1px solid rgba(63,63,70,.75);
      border-radius: 14px; padding: 14px; margin-bottom: 12px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .card-draft { border-left: 3px solid var(--warn); }
    .code-badge {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
      color: #c4b5fd; background: rgba(139,124,246,.16); padding: 2px 8px; border-radius: 6px;
    }
    .sec { background: rgba(139,124,246,.08); border: 1px solid rgba(139,124,246,.28); border-radius: 10px; padding: 10px 12px; }
    .sec-title { font-size: 12px; font-weight: 700; color: #ddd6fe; margin-bottom: 4px; }
    .impact-ok { background: rgba(52,211,153,.09); border: 1px solid rgba(52,211,153,.32); border-radius: 10px; padding: 10px 12px; }
    .impact-err { background: rgba(248,113,113,.09); border: 1px solid rgba(248,113,113,.32); border-radius: 10px; padding: 10px 12px; }
    ul { margin: 6px 0 0; padding-left: 18px; color: #d4d4d8; font-size: 12.5px; }
    textarea, input {
      width: 100%; border-radius: 10px; border: 1px solid var(--border);
      background: var(--layer); color: var(--text); padding: 10px 12px;
      font-size: 16px; font-family: inherit; outline: none;
    }
    textarea:focus, input:focus { border-color: var(--brand); }
    .quick-list { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; }
    .quick-btn {
      flex-shrink: 0; border-radius: 999px; border: 1px solid var(--border);
      background: var(--layer); color: #d4d4d8; padding: 5px 11px; font-size: 11.5px;
    }
    .btn-col { display: flex; flex-direction: column; gap: 8px; }
    .btn {
      width: 100%; min-height: 42px; border-radius: 10px; border: 1px solid var(--border);
      background: var(--layer); color: var(--text); font-size: 13.5px; font-weight: 600;
      display: flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer;
    }
    .btn:disabled { opacity: .42; }
    .btn-pri { background: rgba(139,124,246,.28); border-color: rgba(139,124,246,.55); color: #ede9fe; }
    .btn-dan { color: #fca5a5; border-color: rgba(248,113,113,.4); }
    .tabbar {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 100;
      background: rgba(24,24,27,.94); backdrop-filter: blur(12px);
      border-top: 1px solid var(--border);
      display: grid; grid-template-columns: repeat(4, 1fr);
      padding: 6px 8px calc(6px + env(safe-area-inset-bottom, 0px));
    }
    .tab-btn {
      border: none; background: transparent; color: var(--sub);
      padding: 6px 4px; font-size: 11.5px; font-weight: 600; border-radius: 8px;
    }
    .tab-btn.on { color: #ddd6fe; background: rgba(139,124,246,.2); }
    .toast {
      position: fixed; top: calc(14px + env(safe-area-inset-top, 0px)); left: 14px; right: 14px;
      z-index: 999; padding: 11px 14px; border-radius: 10px; background: #18181b;
      border: 1px solid var(--ok); color: #6ee7b7; font-size: 13px; font-weight: 600;
      box-shadow: 0 8px 24px rgba(0,0,0,.5);
    }
    pre {
      margin: 0; padding: 10px; border-radius: 8px; background: #000; color: #d4d4d8;
      font-size: 11.5px; overflow-x: auto; white-space: pre-wrap; word-break: break-word;
    }
  </style>
</head>
<body>
  <div id="app">正在加载 DSH 自进化手机审批台…</div>
  <script>
    const API = '/dsh-evolution/api';
    let state = { data: null, tab: 'drafts', busy: null, toast: null, comments: {}, previewOpen: {} };
    const QUICKS = [
      '同意采纳：请将技能正文全部转化为清晰易读的中文规范后正式入库',
      '同意采纳：提炼的排查顺序与防坑规则准确，直接按此入库',
      '同意但需补充：请在步骤开头加入“修改前必须先备份原文件/配置”的硬性要求',
      '不同意驳回：这属于单次特定环境偶发问题，不应固化为全局技能'
    ];

    async function callApi(path, opts) {
      const r = await fetch(API + path, { headers: { 'content-type': 'application/json' }, ...opts });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      return d;
    }

    function showToast(msg) {
      state.toast = msg;
      render();
      setTimeout(() => { state.toast = null; render(); }, 3200);
    }

    async function load() {
      try {
        state.data = await callApi('/status');
        render();
      } catch (e) {
        document.getElementById('app').innerText = '加载失败：' + e.message;
      }
    }

    async function act(key, fn, msg) {
      state.busy = key; render();
      try {
        const r = await fn();
        showToast(typeof msg === 'function' ? msg(r) : msg);
        await load();
      } catch (e) {
        showToast('失败：' + e.message);
      } finally {
        state.busy = null; render();
      }
    }

    window.setTab = (t) => { state.tab = t; render(); };
    window.setComment = (name, val) => { state.comments[name] = val; render(); };
    window.togglePreview = (name) => { state.previewOpen[name] = !state.previewOpen[name]; render(); };
    window.doRefine = (name) => {
      const c = (state.comments[name] || '').trim();
      if (!c) return;
      act('d:' + name, () => callApi('/refine-draft', { method: 'POST', body: JSON.stringify({ name, comment: c }) }), (r) => 'AI 已按批示修订：' + (r.aiAnalysis || name));
    };
    window.doPromote = (name) => {
      const c = (state.comments[name] || '').trim();
      if (!c) return;
      act('d:' + name, () => callApi('/promote', { method: 'POST', body: JSON.stringify({ name, comment: c, evolveWithComment: true }) }), '已按批示进化并采纳进正式库');
    };
    window.doDiscard = (name) => {
      const c = (state.comments[name] || '').trim();
      if (!c) return;
      act('d:' + name, () => callApi('/discard', { method: 'POST', body: JSON.stringify({ name, comment: c }) }), '已按批示驳回');
    };
    window.doRollback = (id, target) => {
      act('r:' + id, () => callApi('/rollback', { method: 'POST', body: JSON.stringify({ id }) }), '已回滚 ' + target);
    };

    function esc(s) {
      return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function render() {
      const d = state.data;
      if (!d) return;
      const st = d.stats || {};
      const drafts = d.drafts || [];
      const skills = d.skills || [];
      const ledger = d.recentLedger || [];

      let bodyHtml = '';
      if (state.tab === 'drafts') {
        if (!drafts.length) {
          bodyHtml = '<div class="card"><div style="text-align:center;color:var(--sub);padding:20px 0">当前没有待审阅的技能草稿</div></div>';
        } else {
          bodyHtml = drafts.map((dr) => {
            const b = dr.briefing || {};
            const rules = Array.isArray(b.keyRules) ? b.keyRules : [];
            const c = state.comments[dr.name] || '';
            const busy = state.busy === ('d:' + dr.name);
            const showPre = !!state.previewOpen[dr.name];
            return '<div class="card card-draft">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">' +
                '<span class="code-badge">' + esc(dr.name) + '</span>' +
                '<span class="chip ' + (dr.isPatch ? 'chip-ok' : 'chip-warn') + '">' + (dr.isPatch ? '现有技能升级补丁' : '新蒸馏技能') + '</span>' +
              '</div>' +
              '<div style="font-size:15.5px;font-weight:700">' + esc(b.titleZh || dr.name) + '</div>' +
              '<div class="sec"><div class="sec-title">💡 这是个什么东西</div><div>' + esc(b.whatItIs || dr.description) + '</div>' +
                (rules.length ? '<ul>' + rules.map(r => '<li>' + esc(r) + '</li>').join('') + '</ul>' : '') +
              '</div>' +
              '<div class="impact-ok"><div style="color:#6ee7b7;font-weight:700;font-size:12px">✅ 如果同意采纳会如何</div><div style="font-size:12.5px;margin-top:3px">' + esc(b.ifApprove) + '</div></div>' +
              '<div class="impact-err"><div style="color:#fca5a5;font-weight:700;font-size:12px">🚫 如果不同意驳回会如何</div><div style="font-size:12.5px;margin-top:3px">' + esc(b.ifReject) + '</div></div>' +
              (b.aiAnalysis ? '<div class="impact-ok"><div style="color:#6ee7b7;font-weight:700;font-size:12px">🤖 AI 批示融合汇报</div><div style="font-size:12.5px;margin-top:3px">' + esc(b.aiAnalysis) + '</div></div>' : '') +
              '<button class="btn" onclick="togglePreview(\\'' + esc(dr.name) + '\\')">' + (showPre ? '收起 SKILL.md 源码' : '📄 查看 SKILL.md 源码全文') + '</button>' +
              (showPre ? '<pre>' + esc(dr.body) + '</pre>' : '') +
              '<div style="font-size:12.5px;font-weight:700;margin-top:4px">✍️ 您的强制批示（必填，填完解锁按钮）：</div>' +
              '<div class="quick-list">' + QUICKS.map(q => '<button class="quick-btn" onclick="setComment(\\'' + esc(dr.name) + '\\', \\'' + esc(q) + '\\')">+ ' + esc(q.slice(0, 18)) + '…</button>').join('') + '</div>' +
              '<textarea rows="3" placeholder="输入您的想法或修改指示…" oninput="state.comments[\\'' + esc(dr.name) + '\\']=this.value;document.getElementById(\\'btns-' + esc(dr.name) + '\\').querySelectorAll(\\'button\\').forEach(b=>b.disabled=!this.value.trim())">' + esc(c) + '</textarea>' +
              '<div class="btn-col" id="btns-' + esc(dr.name) + '">' +
                '<button class="btn" ' + (!c.trim() || busy ? 'disabled' : '') + ' onclick="doRefine(\\'' + esc(dr.name) + '\\')">' + (busy ? 'AI 正在处理…' : '🤖 1. AI 按批示修订草稿（先看效果）') + '</button>' +
                '<button class="btn btn-pri" ' + (!c.trim() || busy ? 'disabled' : '') + ' onclick="doPromote(\\'' + esc(dr.name) + '\\')">' + (busy ? '处理中…' : '✅ 2. 按批示进化并采纳进正式库') + '</button>' +
                '<button class="btn btn-dan" ' + (!c.trim() || busy ? 'disabled' : '') + ' onclick="doDiscard(\\'' + esc(dr.name) + '\\')">✕ 按批示驳回 (Discard)</button>' +
              '</div>' +
            '</div>';
          }).join('');
        }
      } else if (state.tab === 'skills') {
        bodyHtml = skills.map(s =>
          '<div class="card">' +
            '<div style="display:flex;justify-content:space-between;align-items:center">' +
              '<span class="code-badge">' + esc(s.name) + '</span>' +
              '<span class="chip chip-ok">' + esc(s.state) + ' · 用 ' + (s.useCount || 0) + ' 次</span>' +
            '</div>' +
            '<div style="font-size:13px;color:#d4d4d8">' + esc(s.description) + '</div>' +
          '</div>'
        ).join('') || '<div class="card">暂无正式技能</div>';
      } else if (state.tab === 'ledger') {
        bodyHtml = ledger.slice(0, 20).map(e =>
          '<div class="card">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">' +
              '<span class="chip chip-brand">' + esc(e.action) + '</span>' +
              '<span class="code-badge">' + esc(e.target) + '</span>' +
              '<span style="font-size:11px;color:var(--sub)">' + new Date(e.ts).toLocaleString('zh-CN', { hour12: false }) + '</span>' +
            '</div>' +
            (e.rationale ? '<div style="font-size:12.5px;color:#d4d4d8">' + esc(e.rationale) + '</div>' : '') +
            (e.userComment ? '<div style="font-size:12px;color:#6ee7b7">✍️ 批示：' + esc(e.userComment) + '</div>' : '') +
            (e.before && e.before.files ? '<button class="btn btn-dan" onclick="doRollback(\\'' + esc(e.id) + '\\',\\'' + esc(e.target) + '\\')">↩ 回滚到此版本</button>' : '') +
          '</div>'
        ).join('') || '<div class="card">暂无账本记录</div>';
      } else {
        bodyHtml = '<div class="card"><div style="font-weight:700">引擎状态</div>' +
          '<div style="font-size:13px;color:var(--sub)">模式：' + esc(d.config?.mode) + ' · 节流：' + (d.throttle?.turnCount || 0) + '/' + (d.config?.minTurnsBetween || 3) + ' 回合</div>' +
          '<div style="font-size:12.5px;color:var(--sub)">技能根目录：' + esc(d.config?.skillsRoot) + '</div></div>';
      }

      document.getElementById('app').innerHTML =
        (state.toast ? '<div class="toast">' + esc(state.toast) + '</div>' : '') +
        '<div class="head"><div><h1 class="title">🧬 DSH 自进化手机台</h1><div class="sub">中文简报 · 强制批示 · AI 融合进化</div></div>' +
          '<span class="chip ' + (d.config?.enabled ? 'chip-ok' : '') + '">' + (d.config?.enabled ? '运行中' : '已停用') + '</span></div>' +
        '<div class="stats">' +
          '<div class="stat" onclick="setTab(\\'drafts\\')"><div class="stat-v" style="color:var(--warn)">' + (st.drafts || 0) + '</div><div class="stat-l">待审草稿</div></div>' +
          '<div class="stat" onclick="setTab(\\'skills\\')"><div class="stat-v" style="color:var(--ok)">' + (st.skills || 0) + '</div><div class="stat-l">正式技能</div></div>' +
        '</div>' +
        bodyHtml +
        '<div class="tabbar">' +
          '<button class="tab-btn ' + (state.tab === 'drafts' ? 'on' : '') + '" onclick="setTab(\\'drafts\\')">📋 待审 (' + (st.drafts || 0) + ')</button>' +
          '<button class="tab-btn ' + (state.tab === 'skills' ? 'on' : '') + '" onclick="setTab(\\'skills\\')">📚 技能 (' + (st.skills || 0) + ')</button>' +
          '<button class="tab-btn ' + (state.tab === 'ledger' ? 'on' : '') + '" onclick="setTab(\\'ledger\\')">🕒 账本 (' + (st.ledger || 0) + ')</button>' +
          '<button class="tab-btn ' + (state.tab === 'info' ? 'on' : '') + '" onclick="setTab(\\'info\\')">⚙️ 状态</button>' +
        '</div>';
    }
    load();
  </script>
</body>
</html>`;

export function registerEvolutionHttp(ctx, deps) {
  const handleRequest = async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (
      req.method === "GET" &&
      (url.pathname === "/" ||
        url.pathname === "/dsh-evolution" ||
        url.pathname === "/dsh-evolution/" ||
        url.pathname === "/dsh-evolution/mobile" ||
        url.pathname === "/dsh-evolution/mobile/")
    ) {
      const buf = Buffer.from(MOBILE_HTML, "utf8");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-length": buf.length,
      });
      res.end(buf);
      return;
    }
    const prefix = "/dsh-evolution/api/";
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const action = url.pathname.slice(prefix.length).replace(/\/$/, "");
    const { config, skillsRoot } = deps;

    try {
      // ---- GET ----
      if (req.method === "GET" && action === "status") {
        sendJson(res, 200, await buildSnapshot(skillsRoot, config));
        return;
      }

      if (req.method === "GET" && action === "skills") {
        const snap = await buildSnapshot(skillsRoot, config);
        sendJson(res, 200, { skills: snap.skills });
        return;
      }

      if (req.method === "GET" && action === "drafts") {
        const snap = await buildSnapshot(skillsRoot, config);
        sendJson(res, 200, { drafts: snap.drafts });
        return;
      }

      if (req.method === "GET" && action === "ledger") {
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const entries = await readEntries(skillsRoot, { limit });
        sendJson(res, 200, { entries: entries.reverse() });
        return;
      }

      if (req.method === "GET" && action.startsWith("ledger/")) {
        const id = action.slice("ledger/".length);
        const entries = await readEntries(skillsRoot);
        const entry = entries.find((e) => e.id === id);
        if (!entry) {
          sendJson(res, 404, { ok: false, error: "ledger entry not found" });
          return;
        }
        sendJson(res, 200, { entry });
        return;
      }

      if (req.method === "GET" && action.startsWith("skill/")) {
        const name = decodeURIComponent(action.slice("skill/".length));
        const detail = await readSkillDetail(skillsRoot, name);
        if (!detail) {
          sendJson(res, 404, { ok: false, error: "skill not found" });
          return;
        }
        sendJson(res, 200, { skill: detail });
        return;
      }

      // ---- POST ----
      if (req.method === "POST" && action === "refine-draft") {
        const { name, comment } = await readJsonBody(req);
        if (!name) {
          sendJson(res, 400, { ok: false, error: "name is required" });
          return;
        }
        if (!comment || !String(comment).trim()) {
          sendJson(res, 400, { ok: false, error: "请先填写您的审阅批示（想法或修改要求）" });
          return;
        }
        const r = await refineDraftWithComment(skillsRoot, name, String(comment).trim(), deps.runFork);
        sendJson(res, r.ok ? 200 : 400, r);
        return;
      }

      if (req.method === "POST" && action === "promote") {
        const { name, comment, evolveWithComment } = await readJsonBody(req);
        if (!name) {
          sendJson(res, 400, { ok: false, error: "name is required" });
          return;
        }
        const trimmedComment = String(comment ?? "").trim();
        let aiAnalysis = "";
        let refinedContent = null;

        if (evolveWithComment && trimmedComment && typeof deps.runFork === "function") {
          const refined = await refineDraftWithComment(skillsRoot, name, trimmedComment, deps.runFork);
          if (refined.ok) {
            aiAnalysis = refined.aiAnalysis;
            refinedContent = refined.refinedContent;
          }
        }

        const r = await promoteDraft(skillsRoot, name, {
          actor: "user",
          comment: trimmedComment,
          aiAnalysis,
          refinedContent,
        });
        sendJson(res, r.ok ? 200 : 400, { ...r, aiAnalysis });
        return;
      }

      if (req.method === "POST" && action === "discard") {
        const { name, comment } = await readJsonBody(req);
        if (!name || /[\\/]|\.\./.test(String(name))) {
          sendJson(res, 400, { ok: false, error: "valid skill name is required" });
          return;
        }
        const stagingRoot = path.resolve(path.join(skillsRoot, STAGING_DIRNAME));
        const dir = path.resolve(path.join(stagingRoot, String(name)));
        if (!dir.startsWith(stagingRoot + path.sep)) {
          sendJson(res, 400, { ok: false, error: "invalid draft path" });
          return;
        }
        const before = await captureSnapshot(stagingRoot, dir);
        await fs.rm(dir, { recursive: true, force: true });
        await appendEntry(skillsRoot, {
          action: "discard",
          target: String(name),
          actor: "user",
          before,
          after: null,
          extra: {
            userComment: String(comment ?? "").trim(),
            rationale: comment ? `用户批示驳回：${String(comment).trim()}` : "用户丢弃草稿",
          },
        });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && action === "rollback") {
        const { id } = await readJsonBody(req);
        if (!id) {
          sendJson(res, 400, { ok: false, error: "id is required" });
          return;
        }
        const r = await rollbackEntry(skillsRoot, id);
        sendJson(res, r.ok ? 200 : 400, r);
        return;
      }

      if (req.method === "POST" && action === "pin") {
        const { name, pinned } = await readJsonBody(req);
        if (!name) {
          sendJson(res, 400, { ok: false, error: "name is required" });
          return;
        }
        const r = await setUsageFlag(skillsRoot, name, { pinned: Boolean(pinned) });
        sendJson(res, 200, { ok: true, usage: r });
        return;
      }

      if (req.method === "POST" && action === "adopt") {
        const { name } = await readJsonBody(req);
        if (!name) {
          sendJson(res, 400, { ok: false, error: "name is required" });
          return;
        }
        const r = await adoptSkill(skillsRoot, name);
        sendJson(res, r.ok ? 200 : 400, r);
        return;
      }

      if (req.method === "POST" && action === "disown") {
        const { name } = await readJsonBody(req);
        if (!name) {
          sendJson(res, 400, { ok: false, error: "name is required" });
          return;
        }
        const r = await disownSkill(skillsRoot, name);
        sendJson(res, r.ok ? 200 : 400, r);
        return;
      }

      if (req.method === "POST" && action === "consolidate") {
        const body = await readJsonBody(req);
        const dryRun = body.dryRun !== false;
        const r = await deps.runConsolidation({ dryRun });
        sendJson(res, r.ok ? 200 : 400, r);
        return;
      }

      if (req.method === "GET" && action === "candidates") {
        const c = await listConsolidationCandidates(skillsRoot);
        sendJson(res, 200, { candidates: c });
        return;
      }

      if (req.method === "POST" && action === "config") {
        const patch = await readJsonBody(req);
        deps.saveConfig(patch);
        sendJson(res, 200, { ok: true, config: (await buildSnapshot(skillsRoot, config)).config });
        return;
      }

      if (req.method === "POST" && action === "review") {
        const r = await deps.triggerReview();
        sendJson(res, r.ok ? 200 : 400, r);
        return;
      }

      sendJson(res, 404, { ok: false, error: `unknown action: ${action}` });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  };

  // 1. 挂载到 DSH 主 WebServer
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: "prefix",
        path: "/dsh-evolution",
        handler: handleRequest,
      }),
    );
  });

  // 2. 同时在固定端口 18890 提供独立服务（供 DSH Go 的 Loopback 端口预览或 Tailscale 手机直连，不随 Desktop 随机端口变化）
  ctx.effect(() => {
    const fixedPort = Number(process.env.DSH_EVOLUTION_PORT || 18890);
    const srv = http.createServer((req, res) => {
      void handleRequest(req, res);
    });
    srv.on("error", () => {
      /* 若端口已被其他 profile 占用则静默忽略 */
    });
    srv.listen(fixedPort, "0.0.0.0");
    srv.unref?.();
    return () => {
      try {
        srv.close();
      } catch {
        /* ignore */
      }
    };
  });
}
