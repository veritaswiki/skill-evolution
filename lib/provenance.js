/**
 * 写来源溯源（Write-Origin Provenance）
 *
 * 移植自 Hermes `tools/skill_provenance.py`。
 *
 * 核心不变量：**用户明确要求的技能归用户，自动复盘产生的技能归 curator。**
 * 这决定了谁有权归档、修改或删除一个技能。没有这层区分，自进化机制会
 * 悄悄改写用户手写的技能，那是不可接受的。
 *
 * 两种来源：
 *   - "foreground"       任何常规 agent（CLI、gateway、cron、subagent、用户直接对话）
 *   - "background_review" 自进化复盘 fork 写出的内容
 *
 * 另有一个正交维度「是否有人值守」（attended）：
 *   - 用户显式触发 `/refine` 的复盘仍是 background_review（所有 curator 护栏照样生效），
 *     但因为是用户要求的，无人值守专属的删除闸门不适用。
 */

import { AsyncLocalStorage } from "node:async_hooks";

export const FOREGROUND = "foreground";
export const BACKGROUND_REVIEW = "background_review";

const VALID_ORIGINS = new Set([FOREGROUND, BACKGROUND_REVIEW]);

const _store = new AsyncLocalStorage();

/**
 * 在当前异步上下文中绑定写来源，返回一个 token 供 reset 使用。
 * 用法：
 *   const token = setCurrentWriteOrigin(BACKGROUND_REVIEW);
 *   try { ...写入技能... } finally { resetCurrentWriteOrigin(token); }
 */
export function setCurrentWriteOrigin(origin) {
  const previous = _store.getStore() ?? { origin: FOREGROUND, attended: false };
  const next = { ...previous, origin: VALID_ORIGINS.has(origin) ? origin : FOREGROUND };
  _store.enterWith(next);
  return previous;
}

/** 恢复到 setCurrentWriteOrigin 之前的上下文。 */
export function resetCurrentWriteOrigin(previous) {
  _store.enterWith(previous ?? { origin: FOREGROUND, attended: false });
}

/** 当前写来源：常规 agent 为 "foreground"，复盘 fork 为 "background_review"。 */
export function getCurrentWriteOrigin() {
  return _store.getStore()?.origin ?? FOREGROUND;
}

/** 是否处于自动复盘 fork 中。所有 curator / 账本 / 审批闸门都以此为判定依据。 */
export function isBackgroundReview() {
  return getCurrentWriteOrigin() === BACKGROUND_REVIEW;
}

/** 标记本次复盘是否由用户显式触发（有人值守）。 */
export function setReviewAttended(attended) {
  const previous = _store.getStore() ?? { origin: FOREGROUND, attended: false };
  _store.enterWith({ ...previous, attended: Boolean(attended) });
  return previous;
}

export function resetReviewAttended(previous) {
  _store.enterWith(previous ?? { origin: FOREGROUND, attended: false });
}

/**
 * 无人值守的自动复盘：background_review 且用户没有显式要求。
 * 这是权限最小的一档——只允许产出草稿，不允许直接落盘或删除任何东西。
 */
export function isUnattendedReview() {
  const s = _store.getStore();
  return s?.origin === BACKGROUND_REVIEW && !s?.attended;
}

/**
 * 某个技能是否允许被自动复盘修改。
 *
 * 规则（移植自 Hermes 的归属原则）：
 *   - 技能带 `created_by: agent` 标记 → 自动复盘可以改（它是我们自己造的）
 *   - 否则（用户手写 / 内置 / 从 hub 安装 / 用户明确要求）→ 自动复盘只能"建议"，不能改
 *
 * 注意：这里刻意**不**用"技能在哪个目录"来推断归属——位置会被移动，
 * 只有显式标记才是可信来源。
 */
export function mayAutoModify(skillMeta) {
  if (!skillMeta || typeof skillMeta !== "object") return false;
  const createdBy =
    skillMeta.createdBy ??
    skillMeta.created_by ??
    skillMeta.metadata?.createdBy ??
    skillMeta.metadata?.created_by;
  return createdBy === "agent";
}

/** 给新建技能打上归属标记（写入 SKILL.md frontmatter 的 metadata 段）。 */
export function agentMetadata(extra = {}) {
  return {
    createdBy: "agent",
    origin: getCurrentWriteOrigin(),
    ...extra,
  };
}
