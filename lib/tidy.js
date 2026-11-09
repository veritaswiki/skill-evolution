/**
 * 整理器（Tidy）
 *
 * 解决「待审草稿堆积到看不过来」的问题。核心判断：
 *
 *   审阅疲劳的根因不是"草稿多"，而是"把每份草稿都当成同等重要的独立决策平铺展示"。
 *   真正需要人做判断的只有两类：① 跨领域的新增（要不要这门手艺）
 *   ② 同域多份的合并方式。其余都是低风险机械动作。
 *
 * 因此按风险从低到高分三档，只有第三档需要人看：
 *   Tier 0 · 清理损坏草稿      —— 零风险，直接移入 .archive/corrupt-*
 *   Tier 1 · 采纳同名/同类补丁 —— 低风险，有 SHA-256 账本可一键回滚
 *   Tier 2 · 同域多份待合并    —— 需要 LLM 蒸馏，交给人确认后走 consolidate
 *
 * 本模块只做"分组与判定"，不做 LLM 调用（那是 consolidation.js 的事）。
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { listSkills, listDrafts, promoteDraft, STAGING_DIRNAME } from "./applier.js";

/** 主题域关键词表：命中越多越可能属于同一把伞。 */
const THEMES = [
  { id: "dsh-plugin", label: "DSH / 插件工程", kw: ["dsh", "plugin", "cordis", "bundle", "patch", "slot", "vendored", "sri", "source-refactor"] },
  { id: "macos-app", label: "macOS 应用与配置", kw: ["macos", "app", "plist", "rosetta", "codesign", "third-party", "config-surgery", "install"] },
  { id: "game", label: "游戏与游戏 AI", kw: ["game", "rts", "gameplay", "telemetry", "asset", "map", "mod", "客户端"] },
  { id: "network", label: "网络与设备", kw: ["network", "nat", "tunnel", "device", "connection", "ssh", "dns", "port"] },
  { id: "system", label: "系统资源", kw: ["cpu", "disk", "thermal", "memory", "space", "reclaim", "resource"] },
  { id: "migration", label: "部署与迁移", kw: ["migrat", "deploy", "cutover", "release", "docker", "container", "service"] },
  { id: "agent", label: "Agent 协作", kw: ["subagent", "agent", "review", "orchestrat", "team"] },
  { id: "visual", label: "视觉产物验收", kw: ["visual", "render", "ui", "screenshot", "style"] },
];

/** 命中主题：返回该技能最可能的主题域（取命中关键词最多的一个）。 */
function themeOf(name, description = "") {
  const hay = `${name} ${description}`.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const t of THEMES) {
    let score = 0;
    for (const k of t.kw) if (hay.includes(k)) score += 1;
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : { id: "other", label: "其它", kw: [] };
}

/** 轻量相似度：技能名字词集合的 Jaccard（只用名字，避免正文噪音）。 */
export function nameSimilarity(a, b) {
  const tok = (s) => new Set(String(s).toLowerCase().split(/[-_.\s]+/).filter((x) => x.length > 2));
  const A = tok(a);
  const B = tok(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** 找草稿最可能归属的现有技能（同名优先，其次名字相似度）。 */
function findAnchor(draft, existingSkills) {
  const same = existingSkills.find((s) => s.name === draft.name);
  if (same) return { skill: same, similarity: 1, reason: "同名技能" };

  let best = null;
  for (const s of existingSkills) {
    const sim = nameSimilarity(draft.name, s.name);
    if (!best || sim > best.similarity) best = { skill: s, similarity: sim };
  }
  if (best && best.similarity >= 0.34) {
    return { ...best, reason: `名字高度相似 (${best.similarity.toFixed(2)})` };
  }
  return null;
}

/**
 * 生成整理计划（只读，不改任何文件）。
 *
 * @param {string} skillsRoot
 * @returns {Promise<object>} 计划
 */
export async function planTidy(skillsRoot) {
  const stagingPath = path.join(skillsRoot, STAGING_DIRNAME);
  const skills = await listSkills(skillsRoot);
  const drafts = await listDrafts(skillsRoot);

  const corrupt = [];
  const autoPromote = [];
  const candidates = [];

  // ---- Tier 0：找出损坏草稿（目录存在但没有可用的 SKILL.md）----
  let dirNames = [];
  try {
    dirNames = (await fs.readdir(stagingPath, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    dirNames = [];
  }

  // ---- Tier 1 / 2：逐份草稿判定 ----
  for (const d of drafts) {
    const dir = d.path ?? path.join(stagingPath, d.name);
    // listDrafts 只给 name/description/path，正文要自己读
    let body = "";
    let hasSkillMd = true;
    try {
      body = await fs.readFile(path.join(dir, "SKILL.md"), "utf8");
    } catch {
      hasSkillMd = false;
    }

    // 缺 SKILL.md → 损坏草稿（listDrafts 也会列出它，所以必须在这里拦）
    if (!hasSkillMd) {
      const files = await fs.readdir(dir).catch(() => []);
      corrupt.push({
        name: d.name,
        reason: files.length ? `缺少 SKILL.md（仅剩 ${files.join(", ")}）` : "空目录",
      });
      continue;
    }

    const desc = String(d.description ?? "");
    const theme = themeOf(d.name, desc);
    const anchor = findAnchor(d, skills);

    // 内容过短 → 没有沉淀价值
    if (body.trim().length < 200) {
      candidates.push({
        name: d.name,
        theme,
        tier: "drop",
        reason: `正文过短 (${body.trim().length} 字符)，不足以形成可复用规程`,
      });
      continue;
    }

    // 同名 / 高度相似 → 直接采纳为现有技能的升级（低风险，可回滚）
    if (anchor && anchor.similarity >= 0.34) {
      candidates.push({
        name: d.name,
        theme,
        tier: "auto",
        anchor: anchor.skill.name,
        reason: `${anchor.reason} → 升级现有技能「${anchor.skill.name}」`,
      });
      continue;
    }

    candidates.push({ name: d.name, theme, tier: "review", anchor: null, reason: "跨领域新增，需要你确认是否收下" });
  }

  // ---- 同域多份 → 组成待合并组 ----
  const byTheme = new Map();
  for (const c of candidates) {
    if (c.tier !== "review") continue;
    const key = c.theme.id;
    if (!byTheme.has(key)) byTheme.set(key, { theme: c.theme, members: [] });
    byTheme.get(key).members.push(c);
  }

  const groups = [];
  for (const { theme, members } of byTheme.values()) {
    if (members.length >= 2) {
      groups.push({
        theme: theme.label,
        themeId: theme.id,
        members: members.map((m) => m.name),
        suggestion: "merge",
        reason: `同属「${theme.label}」${members.length} 份，建议先合并成一把伞技能再采纳`,
      });
    } else {
      groups.push({
        theme: theme.label,
        themeId: theme.id,
        members: [members[0].name],
        suggestion: "promote",
        reason: `独立新增（${theme.label}）`,
      });
    }
  }

  const auto = candidates.filter((c) => c.tier === "auto");
  const drops = candidates.filter((c) => c.tier === "drop");

  return {
    ok: true,
    ts: new Date().toISOString(),
    corrupt,
    autoPromote: auto,
    autoDrop: drops,
    groups,
    summary: {
      total: dirNames.length + drafts.length,
      corrupt: corrupt.length,
      autoPromote: auto.length,
      autoDrop: drops.length,
      groupsNeedingDecision: groups.filter((g) => g.suggestion === "merge").length,
      hold: groups.reduce((n, g) => n + g.members.length, 0),
    },
  };
}

/**
 * 执行整理计划中"无需人判断"的部分（Tier 0 + Tier 1）。
 *
 * 关键：所有 promote 在同一事件循环内连续完成，利用 dsh-skill-filesystem
 * 的 200ms 写入防抖窗口合并为**一次**目录刷新，避免会话内重复追加 <available_skills>。
 *
 * @param {string} skillsRoot
 * @param {object} plan planTidy() 的结果
 * @param {{comment?: string, actor?: string}} [opts]
 */
export async function applyTidy(skillsRoot, plan, opts = {}) {
  const done = [];
  const errors = [];
  const stagingPath = path.join(skillsRoot, STAGING_DIRNAME);
  const archivePath = path.join(skillsRoot, ".archive");
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

  // Tier 0：损坏草稿移入归档区（永不物理删除）
  for (const c of plan.corrupt ?? []) {
    try {
      await fs.mkdir(archivePath, { recursive: true });
      const target = path.join(archivePath, `${c.name}-corrupt-${stamp}`);
      await fs.rename(path.join(stagingPath, c.name), target);
      done.push(`archive-corrupt ${c.name}`);
    } catch (e) {
      errors.push(`archive-corrupt ${c.name}: ${e.message}`);
    }
  }

  // Tier 1：同名/高度相似的补丁直接升入正式库（每份都写 led 账本，可回滚）
  for (const c of plan.autoPromote ?? []) {
    try {
      const r = await promoteDraft(skillsRoot, c.name, {
        actor: opts.actor ?? "user",
        comment: opts.comment ?? `一键整理：${c.reason}`,
      });
      if (r.ok) done.push(`promote ${c.name} → ${c.anchor}`);
      else errors.push(`promote ${c.name}: ${r.errors?.join("; ") ?? r.error}`);
    } catch (e) {
      errors.push(`promote ${c.name}: ${e.message}`);
    }
  }

  // Tier 1b：过短的直接归档（保留可追溯）
  for (const c of plan.autoDrop ?? []) {
    try {
      await fs.mkdir(archivePath, { recursive: true });
      const target = path.join(archivePath, `${c.name}-dropped-${stamp}`);
      await fs.rename(path.join(stagingPath, c.name), target);
      done.push(`archive-dropped ${c.name}`);
    } catch (e) {
      errors.push(`archive-dropped ${c.name}: ${e.message}`);
    }
  }

  return { ok: errors.length === 0, done, errors };
}
