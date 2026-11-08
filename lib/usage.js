/**
 * 使用遥测与生命周期（Usage & Lifecycle）
 *
 * 移植自 Hermes `tools/skill_usage.py`。
 *
 * 关键设计（每一条都来自 Hermes 的实战教训）：
 *   - 遥测存**旁路文件** `.usage.json`，绝不写进 SKILL.md frontmatter
 *     （否则会污染用户手写的技能，也会污染 bundled/hub 技能）
 *   - 生命周期三态：active → stale → archived
 *   - **use_count == 0 是"无证据"，不是"陈旧"** —— 永不因零使用而归档
 *   - `pinned` 豁免全部自动状态转换
 *   - 关键内置技能永不归档
 *   - 只归档，永不删除（可恢复）
 */

import fs from "node:fs/promises";
import path from "node:path";

export const USAGE_FILENAME = ".usage.json";
export const STATE_ACTIVE = "active";
export const STATE_STALE = "stale";
export const STATE_ARCHIVED = "archived";
export const VALID_STATES = new Set([STATE_ACTIVE, STATE_STALE, STATE_ARCHIVED]);

export const DEFAULT_STALE_AFTER_DAYS = 14;
export const DEFAULT_ARCHIVE_AFTER_DAYS = 30;

/** 承载关键功能的技能，curator 无论什么判断都不得归档。保持极小。 */
export const PROTECTED_SKILLS = new Set([
  "agent-experience",
  "cordis-plugin-development",
  "cordis-composition-reference",
  "editing-cordis-compositions",
  "official-plugins",
]);

function usagePath(skillsRoot) {
  return path.join(skillsRoot, USAGE_FILENAME);
}

/** 读 .usage.json；不存在或损坏返回空对象。 */
export async function loadUsage(skillsRoot) {
  try {
    const text = await fs.readFile(usagePath(skillsRoot), "utf8");
    const data = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/** 原子写 .usage.json。 */
export async function saveUsage(skillsRoot, usage) {
  const p = usagePath(skillsRoot);
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.mkdir(skillsRoot, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(usage, null, 2) + "\n", "utf8");
  await fs.rename(tmp, p);
}

/** 取某个技能的遥测条目（不存在则返回默认值）。 */
export function entryOf(usage, name) {
  const e = usage[name];
  return {
    useCount: Number(e?.useCount ?? e?.use_count ?? 0),
    lastUsedAt: e?.lastUsedAt ?? e?.last_used ?? null,
    createdAt: e?.createdAt ?? e?.created_at ?? null,
    state: VALID_STATES.has(e?.state) ? e.state : STATE_ACTIVE,
    pinned: Boolean(e?.pinned),
    createdBy: e?.createdBy ?? e?.created_by ?? null,
  };
}

/**
 * 记一次使用。**尽力而为**：失败只记日志，绝不让遥测打断工具调用。
 */
export async function bumpUsage(skillsRoot, name, { createdBy } = {}) {
  try {
    const usage = await loadUsage(skillsRoot);
    const cur = usage[name] ?? {};
    usage[name] = {
      ...cur,
      useCount: Number(cur.useCount ?? 0) + 1,
      lastUsedAt: new Date().toISOString(),
      createdAt: cur.createdAt ?? new Date().toISOString(),
      state: VALID_STATES.has(cur.state) ? cur.state : STATE_ACTIVE,
      pinned: Boolean(cur.pinned),
      ...(createdBy ? { createdBy } : {}),
    };
    await saveUsage(skillsRoot, usage);
    return usage[name];
  } catch (error) {
    console.warn("[dsh-evolution] usage bump failed:", error?.message ?? error);
    return null;
  }
}

/** 设置 pinned / state。 */
export async function setUsageFlag(skillsRoot, name, patch) {
  const usage = await loadUsage(skillsRoot);
  const cur = usage[name] ?? {};
  usage[name] = { ...cur, ...patch };
  await saveUsage(skillsRoot, usage);
  return usage[name];
}

/**
 * 确定性状态转换：根据活动时间戳把技能在 active/stale/archived 之间移动。
 *
 * 这是 curator 的**确定性**部分（不需要 LLM），对应 Hermes 的
 * `apply_automatic_transitions`。Hermes 的注释说明了为什么这部分永远开着：
 * 它便宜、可预测、不需要模型判断。
 *
 * @returns {{marked_stale: number, archived: number, reactivated: number, checked: number}}
 */
export async function applyAutomaticTransitions(
  skillsRoot,
  { staleAfterDays = DEFAULT_STALE_AFTER_DAYS, archiveAfterDays = DEFAULT_ARCHIVE_AFTER_DAYS, now = new Date() } = {},
) {
  const usage = await loadUsage(skillsRoot);
  const counts = { marked_stale: 0, archived: 0, reactivated: 0, checked: 0 };
  const staleCutoff = now.getTime() - staleAfterDays * 86400_000;
  const archiveCutoff = now.getTime() - archiveAfterDays * 86400_000;

  for (const [name, raw] of Object.entries(usage)) {
    counts.checked += 1;
    const e = entryOf(usage, name);

    // pinned 豁免全部自动转换
    if (e.pinned) continue;
    // 关键内置技能永不归档
    if (PROTECTED_SKILLS.has(name)) continue;
    // use_count == 0 是"无证据"，不是"陈旧" —— 永不因零使用归档
    if (e.useCount === 0) continue;

    const anchorIso = e.lastUsedAt ?? e.createdAt;
    if (!anchorIso) continue;
    const anchor = Date.parse(anchorIso);
    if (!Number.isFinite(anchor)) continue;

    if (anchor <= archiveCutoff && e.state !== STATE_ARCHIVED) {
      usage[name] = { ...raw, state: STATE_ARCHIVED };
      counts.archived += 1;
    } else if (anchor <= staleCutoff && e.state === STATE_ACTIVE) {
      usage[name] = { ...raw, state: STATE_STALE };
      counts.marked_stale += 1;
    } else if (anchor > staleCutoff && e.state !== STATE_ACTIVE) {
      usage[name] = { ...raw, state: STATE_ACTIVE };
      counts.reactivated += 1;
    }
  }

  await saveUsage(skillsRoot, usage);
  return counts;
}

/**
 * 把归档技能移到 `.archive/` 目录（**永不删除**）。
 * 返回 { moved: boolean, to?: string, error?: string }
 */
export async function archiveSkill(skillsRoot, name) {
  if (PROTECTED_SKILLS.has(name)) {
    return { moved: false, error: `"${name}" is a protected skill and is never archived` };
  }
  const usage = await loadUsage(skillsRoot);
  const e = entryOf(usage, name);
  if (e.pinned) return { moved: false, error: `"${name}" is pinned` };

  const from = path.join(skillsRoot, name);
  const archiveRoot = path.join(skillsRoot, ".archive");
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const to = path.join(archiveRoot, `${name}-${stamp}`);
  try {
    await fs.mkdir(archiveRoot, { recursive: true });
    await fs.rename(from, to);
    usage[name] = { ...(usage[name] ?? {}), state: STATE_ARCHIVED, archivedAt: new Date().toISOString() };
    await saveUsage(skillsRoot, usage);
    return { moved: true, to };
  } catch (error) {
    return { moved: false, error: String(error?.message ?? error) };
  }
}

/**
 * 接管一个无 provenance 标记的技能（移植自 Hermes `hermes curator adopt`）。
 *
 * 背景：用户手写或从别处导入的技能没有 `metadata.createdBy: agent` 标记，
 * curator 默认永不自动处理它们。`adopt` 把它们纳入管理——但只是**纳入生命周期管理**，
 * 不改变归属：它们仍然不会被自动改写内容。
 *
 * @returns {{ok: boolean, error?: string}}
 */
export async function adoptSkill(skillsRoot, name) {
  const usage = await loadUsage(skillsRoot);
  if (usage[name]) {
    return { ok: false, error: `"${name}" is already managed` };
  }
  usage[name] = {
    useCount: 0,
    createdAt: new Date().toISOString(),
    state: STATE_ACTIVE,
    pinned: false,
    adopted: true,
    createdBy: null,
  };
  await saveUsage(skillsRoot, usage);
  return { ok: true };
}

/** 取消接管（回到 unmanaged）。 */
export async function disownSkill(skillsRoot, name) {
  const usage = await loadUsage(skillsRoot);
  if (!usage[name]) return { ok: false, error: `"${name}" is not managed` };
  delete usage[name];
  await saveUsage(skillsRoot, usage);
  return { ok: true };
}

/** 列出未纳入管理的技能（有 SKILL.md 但 .usage.json 里没有）。 */
export async function listUnmanaged(skillsRoot, allSkillNames) {
  const usage = await loadUsage(skillsRoot);
  return allSkillNames.filter((n) => !usage[n]);
}
