/**
 * 能力对齐审计：DSH 插件 vs Hermes
 * 逐项检查 Hermes 的每个自进化能力在 DSH 插件里的实现状态。
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const files = {
  prompts: read("lib/prompts.js"),
  reflector: read("lib/reflector.js"),
  ledger: read("lib/ledger.js"),
  usage: read("lib/usage.js"),
  provenance: read("lib/provenance.js"),
  applier: read("lib/applier.js"),
  consolidation: read("lib/consolidation.js"),
  gatekeeper: read("lib/gatekeeper.js"),
  collector: read("lib/collector.js"),
  index: read("index.js"),
  http: read("lib/http-api.js"),
  client: read("client.js"),
};
const all = Object.values(files).join("\n");

const CAPABILITIES = [
  // [能力, Hermes 位置, 检查函数]
  ["回合后异步复盘 fork", "background_review._spawn_background_review_now",
    () => files.reflector.includes("startActivation") && files.index.includes("turn/end")],
  ["复盘工具白名单（只读）", "background_review dispatch-side whitelist",
    () => files.reflector.includes("REVIEW_TOOL_ALLOWLIST")],
  ["复盘可取消（新回合打断）", "background_review._interrupt_background_review",
    () => files.index.includes("inflight.get(session.id)?.abort()")],
  ["历史压缩（有界快照）", "background_review._digest_history",
    () => files.collector.includes("Earlier conversation digest")],
  ["三段审查提示词", "background_review._SKILL_REVIEW_PROMPT 等",
    () => files.prompts.includes("LESSON_LAYER_BLOCK") && files.prompts.includes("DO_NOT_CAPTURE_BLOCK")],
  ["Be ACTIVE 反惰性", "background_review._SKILL_REVIEW_PROMPT",
    () => files.prompts.includes("Be ACTIVE")],
  ["类级别技能形态", "background_review._LESSON_LAYER_BLOCK",
    () => files.prompts.includes("CLASS-LEVEL")],
  ["四级优先顺序", "background_review._SKILL_REVIEW_PROMPT",
    () => files.prompts.includes("UPDATE A CURRENTLY-LOADED SKILL") && files.prompts.includes("CREATE A NEW CLASS-LEVEL UMBRELLA")],
  ["Read-before-write", "skill_manager_guards",
    () => files.prompts.includes("Read-before-write")],
  ["用户偏好嵌入技能", "background_review User-preference embedding",
    () => files.prompts.includes("User-preference embedding")],
  ["负面断言禁令", "background_review._DO_NOT_CAPTURE_BLOCK",
    () => files.gatekeeper.includes("NEGATIVE_CLAIM_PATTERNS")],
  ["环境失败禁令", "background_review._DO_NOT_CAPTURE_BLOCK",
    () => files.gatekeeper.includes("ENV_FAILURE_PATTERNS")],
  ["未解决失败禁令", "background_review._DO_NOT_CAPTURE_BLOCK",
    () => files.prompts.includes("Unresolved failures")],
  ["技能写入", "skill_manager_tool",
    () => files.applier.includes("applySynthesis")],
  ["JSONL 账本", "skill_ledger",
    () => files.ledger.includes(".evolution_ledger.jsonl")],
  ["sha256 blob 去重", "skill_ledger",
    () => files.ledger.includes("createHash") && files.ledger.includes("blobs")],
  ["单条回滚", "skill_ledger.rollback_entry",
    () => files.ledger.includes("rollbackEntry")],
  ["回滚 fail-closed", "skill_ledger rollback safety capture",
    () => files.ledger.includes("refusing to roll back")],
  ["旁路遥测（不污染 SKILL.md）", "skill_usage",
    () => files.usage.includes(".usage.json")],
  ["生命周期 active/stale/archived", "skill_usage",
    () => files.usage.includes("STATE_ACTIVE") && files.usage.includes("STATE_ARCHIVED")],
  ["零使用不归档", "skill_usage",
    () => files.usage.includes("useCount === 0")],
  ["pinned 豁免", "skill_usage",
    () => files.usage.includes("if (e.pinned) continue")],
  ["保护内置技能", "skill_usage.PROTECTED_BUILTIN_SKILLS",
    () => files.usage.includes("PROTECTED_SKILLS")],
  ["只归档不删除", "curator invariants",
    () => files.usage.includes("archiveSkill") && !files.usage.includes("fs.rm(from")],
  ["写来源溯源", "skill_provenance",
    () => files.provenance.includes("BACKGROUND_REVIEW") && files.provenance.includes("isUnattendedReview")],
  ["用户技能归属保护", "skill_provenance + curator",
    () => files.applier.includes("not created by the evolution loop")],
  ["LLM 建伞合并", "curator.CURATOR_REVIEW_PROMPT",
    () => files.prompts.includes("CURATOR_REVIEW_PROMPT") && files.consolidation.includes("runConsolidation")],
  ["前缀聚类", "curator.CURATOR_REVIEW_PROMPT",
    () => files.prompts.includes("PREFIX CLUSTERS")],
  ["三种合并方式", "curator.CURATOR_REVIEW_PROMPT",
    () => files.prompts.includes("MERGE INTO EXISTING UMBRELLA") && files.prompts.includes("DEMOTE TO REFERENCES")],
  ["包完整性检查", "curator.CURATOR_REVIEW_PROMPT",
    () => files.prompts.includes("Package integrity")],
  ["归档必须带 absorbedInto", "curator.CURATOR_REVIEW_PROMPT",
    () => files.consolidation.includes("absorbedInto") && files.consolidation.includes("missing absorbedInto")],
  ["curator adopt", "hermes curator adopt",
    () => files.usage.includes("adoptSkill")],
  ["节流（回合/时间）", "background_review 节流",
    () => files.collector.includes("class Throttle")],
  ["快照长度上限", "background_review 有界",
    () => files.collector.includes("maxChars")],
  ["超时保护", "background_review 超时",
    () => files.reflector.includes("timeoutMs")],
  ["账本轮转", "skill_ledger 体积控制",
    () => files.ledger.includes("maybeRotateLedger")],
  ["blob GC", "skill_ledger blob 回收",
    () => files.ledger.includes("gcBlobs")],
  // DSH 独有（Hermes 没有）
  ["人工闸门（草稿模式）", "— DSH 独有",
    () => files.applier.includes("STAGING_DIRNAME")],
  ["代码级禁词硬拦截", "— DSH 独有",
    () => files.gatekeeper.includes("scanForbiddenContent")],
  ["可视化界面", "— DSH 独有",
    () => files.client.includes("EvolutionPanel")],
  ["HTTP API", "— DSH 独有",
    () => files.http.includes("registerEvolutionHttp")],
];

let pass = 0;
const missing = [];
console.log("Hermes 自进化能力 → DSH 插件实现状态\n" + "=".repeat(72));
for (const [name, hermesLoc, check] of CAPABILITIES) {
  let ok = false;
  try { ok = Boolean(check()); } catch { ok = false; }
  if (ok) pass++;
  else missing.push(name);
  const tag = hermesLoc.startsWith("—") ? "[DSH+]" : "[Hermes]";
  console.log(`${ok ? "✅" : "❌"} ${tag} ${name}`);
  if (!ok) console.log(`        └ Hermes: ${hermesLoc}`);
}
console.log("=".repeat(72));
console.log(`\n覆盖: ${pass}/${CAPABILITIES.length}`);
if (missing.length) {
  console.log("缺失:");
  for (const m of missing) console.log("  - " + m);
  process.exitCode = 1;
} else {
  console.log("🎉 全部覆盖");
}
