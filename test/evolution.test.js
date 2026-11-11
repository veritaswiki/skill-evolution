/**
 * skill-evolution 单元测试
 *
 * 不依赖 DSH 运行时，纯 Node 跑：node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  validateSkillName,
  scanForbiddenContent,
  validateFrontmatter,
  gate,
  renderSkillMarkdown,
  parseSkillMarkdown,
  MAX_SKILL_BODY_CHARS,
} from "../lib/gatekeeper.js";
import { synthesize, extractJsonBlock, canPatchExisting } from "../lib/synthesizer.js";
import { buildSnapshot, assessTurn, looksLikeCorrection, Throttle } from "../lib/collector.js";
import {
  setCurrentWriteOrigin,
  resetCurrentWriteOrigin,
  isBackgroundReview,
  isUnattendedReview,
  mayAutoModify,
  BACKGROUND_REVIEW,
} from "../lib/provenance.js";
import { appendEntry, readEntries, captureSnapshot, rollbackEntry } from "../lib/ledger.js";
import { applySynthesis, promoteDraft, listDrafts, listSkills } from "../lib/applier.js";
import { applyAutomaticTransitions, bumpUsage, loadUsage, PROTECTED_SKILLS } from "../lib/usage.js";

async function tmpSkillsRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-evo-test-"));
  return dir;
}

// ---------- gatekeeper ----------

test("validateSkillName accepts class-level kebab names", () => {
  assert.equal(validateSkillName("cordis-plugin-development").ok, true);
  assert.equal(validateSkillName("pdf-processing").ok, true);
});

test("validateSkillName rejects session artifacts", () => {
  assert.equal(validateSkillName("fix-login-bug").ok, false);
  assert.equal(validateSkillName("debug-y").ok, false);
  assert.equal(validateSkillName("audit-today").ok, false);
  assert.equal(validateSkillName("issue-1234").ok, false);
  assert.equal(validateSkillName("skill-2026-11-07").ok, false);
  assert.equal(validateSkillName("Bad_Name").ok, false);
  assert.equal(validateSkillName("react").ok, false);
  assert.equal(validateSkillName("").ok, false);
});

test("scanForbiddenContent catches negative tool claims", () => {
  const r = scanForbiddenContent("Note: the browser tool does not work in this setup.");
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].kind, "negative-claim");
});

test("scanForbiddenContent catches env failures", () => {
  const r = scanForbiddenContent("If you see command not found, install it first.");
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.kind === "env-failure"));
});

test("scanForbiddenContent passes clean procedural text", () => {
  const r = scanForbiddenContent(
    "Run the test suite before widening a helper signature — hand-rolled mocks reimplement the old shape.",
  );
  assert.equal(r.ok, true);
});

test("validateFrontmatter requires name and description", () => {
  assert.equal(validateFrontmatter({ name: "ok-skill" }).ok, false);
  assert.equal(validateFrontmatter({ name: "ok-skill", description: "does a thing" }).ok, true);
  assert.equal(validateFrontmatter({ name: "ok-skill", description: "x".repeat(600) }).ok, false);
});

test("gate rejects oversized bodies", () => {
  const r = gate({
    action: "create",
    target: "big-skill",
    frontmatter: { name: "big-skill", description: "d" },
    body: "x".repeat(MAX_SKILL_BODY_CHARS + 1),
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("over the")));
});

test("gate rejects date-stamped reference filenames", () => {
  const r = gate({
    action: "add_reference",
    target: "some-skill",
    filePath: "references/2026-11-07-incident.md",
    body: "content",
  });
  assert.equal(r.ok, false);
});

test("renderSkillMarkdown / parseSkillMarkdown round-trip", () => {
  const md = renderSkillMarkdown({ name: "a-b", description: "desc here" }, "# Body\n\ntext");
  const parsed = parseSkillMarkdown(md);
  assert.equal(parsed.frontmatter.name, "a-b");
  assert.equal(parsed.frontmatter.description, "desc here");
  assert.ok(parsed.body.includes("# Body"));
});

// ---------- synthesizer ----------

test("extractJsonBlock finds fenced json", () => {
  const text = 'blah\n```json\n{"action":"nothing","target":""}\n```\ntail';
  const r = extractJsonBlock(text);
  assert.equal(r.action, "nothing");
});

test("extractJsonBlock falls back to bare braces", () => {
  const r = extractJsonBlock('prefix {"action":"create","target":"x"} suffix');
  assert.equal(r.action, "create");
});

test("synthesize returns nothing action cleanly", () => {
  const r = synthesize({ action: "nothing", target: "" });
  assert.equal(r.ok, true);
  assert.equal(r.action, "nothing");
  assert.equal(r.files.length, 0);
});

test("synthesize builds a SKILL.md for create", () => {
  const r = synthesize({
    action: "create",
    target: "pdf-processing",
    frontmatter: { name: "pdf-processing", description: "Process PDFs reliably" },
    body: "# Steps\n\n1. Do the thing.",
    rationale: "new technique",
    signals: ["new-technique"],
    confidence: "high",
  });
  assert.equal(r.ok, true);
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].path, "pdf-processing/SKILL.md");
  assert.ok(r.files[0].content.includes("createdBy"));
});

test("synthesize rejects a session-artifact target", () => {
  const r = synthesize({
    action: "create",
    target: "fix-login-bug",
    frontmatter: { name: "fix-login-bug", description: "d" },
    body: "# x",
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("session artifact")));
});

test("synthesize rejects forbidden body content", () => {
  const r = synthesize({
    action: "create",
    target: "some-class",
    frontmatter: { name: "some-class", description: "d" },
    body: "The browser tool does not work, so skip it.",
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("forbidden content")));
});

test("canPatchExisting rejects unparsable frontmatter", () => {
  assert.equal(canPatchExisting("no frontmatter here").ok, false);
});

// ---------- collector ----------

test("looksLikeCorrection detects zh and en corrections", () => {
  assert.equal(looksLikeCorrection("stop doing that"), true);
  assert.equal(looksLikeCorrection("你太啰嗦了"), true);
  assert.equal(looksLikeCorrection("please add a test"), false);
});

test("assessTurn skips pure Q&A", () => {
  const r = assessTurn({ userTexts: ["what is 2+2"], toolCalls: [], skillsLoaded: [] });
  assert.equal(r.worth, false);
});

test("assessTurn skips a single trivial tool call", () => {
  const r = assessTurn({ userTexts: ["rename it"], toolCalls: ["bash"], skillsLoaded: [] });
  assert.equal(r.worth, false);
});

test("assessTurn flags a complex multi-tool session", () => {
  const r = assessTurn({ userTexts: ["debug it"], toolCalls: ["grep", "read", "edit"], skillsLoaded: [] });
  assert.equal(r.worth, true);
  assert.ok(r.signals.includes("new-technique"));
});

test("assessTurn always flags a user correction", () => {
  const r = assessTurn({ userTexts: ["你太啰嗦了"], toolCalls: ["bash"], skillsLoaded: [] });
  assert.equal(r.worth, true);
  assert.ok(r.signals.includes("user-correction"));
});

test("buildSnapshot digests older messages and stays bounded", () => {
  const events = [];
  for (let i = 0; i < 60; i += 1) {
    events.push({ type: "user/message", content: `user msg ${i}` });
    events.push({ type: "assistant/message", content: `assistant msg ${i}` });
  }
  const snap = buildSnapshot(events, { maxMessages: 10, maxChars: 5000 });
  assert.ok(snap.stats.keptMessages <= 12);
  assert.ok(snap.transcript.includes("Earlier conversation digest"));
  assert.ok(snap.transcript.length <= 5000);
});

test("Throttle gates by turn count and time", () => {
  const t = new Throttle({ minTurnsBetween: 3, minMinutesBetween: 5 });
  assert.equal(t.tick({ worth: true }), false);
  assert.equal(t.tick({ worth: true }), false);
  assert.equal(t.tick({ worth: true }), true);
  // 立刻再来一次应被时间闸挡住
  assert.equal(t.tick({ worth: true }), false);
});

// ---------- provenance ----------

test("provenance defaults to foreground", () => {
  assert.equal(isBackgroundReview(), false);
  assert.equal(isUnattendedReview(), false);
});

test("provenance tracks background review", () => {
  const prev = setCurrentWriteOrigin(BACKGROUND_REVIEW);
  try {
    assert.equal(isBackgroundReview(), true);
    assert.equal(isUnattendedReview(), true);
  } finally {
    resetCurrentWriteOrigin(prev);
  }
  assert.equal(isBackgroundReview(), false);
});

test("mayAutoModify only allows agent-created skills", () => {
  assert.equal(mayAutoModify({ createdBy: "agent" }), true);
  assert.equal(mayAutoModify({ metadata: { createdBy: "agent" } }), true);
  assert.equal(mayAutoModify({ createdBy: null }), false);
  assert.equal(mayAutoModify(null), false);
});

// ---------- ledger ----------

test("ledger append + read round-trip", async () => {
  const root = await tmpSkillsRoot();
  const id = await appendEntry(root, { action: "create", target: "a-skill", actor: "agent" });
  assert.ok(id);
  const entries = await readEntries(root);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].target, "a-skill");
  await fs.rm(root, { recursive: true, force: true });
});

test("ledger capture + rollback restores content", async () => {
  const root = await tmpSkillsRoot();
  const skillDir = path.join(root, "a-skill");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), "v1 content");

  const before = await captureSnapshot(root, skillDir);
  await fs.writeFile(path.join(skillDir, "SKILL.md"), "v2 content");
  const id = await appendEntry(root, { action: "patch", target: "a-skill", before, actor: "curator" });

  const r = await rollbackEntry(root, id);
  assert.equal(r.ok, true);
  const restored = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
  assert.equal(restored, "v1 content");
  await fs.rm(root, { recursive: true, force: true });
});

test("rollback refuses when entry has no before-snapshot", async () => {
  const root = await tmpSkillsRoot();
  const id = await appendEntry(root, { action: "create", target: "a-skill", actor: "agent" });
  const r = await rollbackEntry(root, id);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("no before-snapshot"));
  await fs.rm(root, { recursive: true, force: true });
});

// ---------- applier ----------

test("applySynthesis in draft mode writes to .staging", async () => {
  const root = await tmpSkillsRoot();
  const synth = synthesize({
    action: "create",
    target: "demo-class",
    frontmatter: { name: "demo-class", description: "demo" },
    body: "# Steps\n\n1. one",
  });
  const r = await applySynthesis(root, synth, { mode: "draft" });
  assert.equal(r.ok, true);
  assert.ok(r.written[0].includes(".staging"));
  const drafts = await listDrafts(root);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].name, "demo-class");
  await fs.rm(root, { recursive: true, force: true });
});

test("applySynthesis refuses to modify user-authored skill", async () => {
  const root = await tmpSkillsRoot();
  const dir = path.join(root, "user-skill");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    renderSkillMarkdown({ name: "user-skill", description: "hand written" }, "# body"),
  );
  const synth = synthesize({
    action: "patch",
    target: "user-skill",
    frontmatter: { name: "user-skill", description: "hand written" },
    body: "# new body",
  });
  const r = await applySynthesis(root, synth, { mode: "apply" });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes("not created by the evolution loop"));
  await fs.rm(root, { recursive: true, force: true });
});

test("applySynthesis allows modifying agent-created skill", async () => {
  const root = await tmpSkillsRoot();
  const dir = path.join(root, "agent-skill");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    renderSkillMarkdown(
      { name: "agent-skill", description: "auto", metadata: { createdBy: "agent" } },
      "# old body",
    ),
  );
  const synth = synthesize({
    action: "patch",
    target: "agent-skill",
    frontmatter: { name: "agent-skill", description: "auto" },
    body: "# new body",
  });
  const r = await applySynthesis(root, synth, { mode: "apply" });
  assert.equal(r.ok, true);
  const text = await fs.readFile(path.join(dir, "SKILL.md"), "utf8");
  assert.ok(text.includes("# new body"));
  await fs.rm(root, { recursive: true, force: true });
});

test("promoteDraft moves staging skill into place", async () => {
  const root = await tmpSkillsRoot();
  const synth = synthesize({
    action: "create",
    target: "promo-class",
    frontmatter: { name: "promo-class", description: "d" },
    body: "# body",
  });
  await applySynthesis(root, synth, { mode: "draft" });
  const r = await promoteDraft(root, "promo-class");
  assert.equal(r.ok, true);
  const skills = await listSkills(root);
  assert.ok(skills.some((s) => s.name === "promo-class"));
  await fs.rm(root, { recursive: true, force: true });
});

// ---------- usage ----------

test("usage bump increments counters", async () => {
  const root = await tmpSkillsRoot();
  await bumpUsage(root, "a-skill", { createdBy: "agent" });
  await bumpUsage(root, "a-skill");
  const usage = await loadUsage(root);
  assert.equal(usage["a-skill"].useCount, 2);
  await fs.rm(root, { recursive: true, force: true });
});

test("zero-use skills are never archived", async () => {
  const root = await tmpSkillsRoot();
  await fs.mkdir(path.join(root, "never-used"), { recursive: true });
  await fs.writeFile(
    path.join(root, "never-used", "SKILL.md"),
    renderSkillMarkdown({ name: "never-used", description: "d" }, "# b"),
  );
  // 手工塞一条零使用的遥测，时间设得很老
  await fs.writeFile(
    path.join(root, ".usage.json"),
    JSON.stringify({ "never-used": { useCount: 0, createdAt: "2020-01-01T00:00:00Z", state: "active" } }),
  );
  const counts = await applyAutomaticTransitions(root, { staleAfterDays: 14, archiveAfterDays: 30 });
  assert.equal(counts.archived, 0);
  assert.equal(counts.marked_stale, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test("old used skills transition to stale then archived", async () => {
  const root = await tmpSkillsRoot();
  await fs.writeFile(
    path.join(root, ".usage.json"),
    JSON.stringify({
      "old-skill": { useCount: 5, lastUsedAt: "2020-01-01T00:00:00Z", state: "active" },
    }),
  );
  const counts = await applyAutomaticTransitions(root, { staleAfterDays: 14, archiveAfterDays: 30 });
  assert.equal(counts.archived, 1);
  const usage = await loadUsage(root);
  assert.equal(usage["old-skill"].state, "archived");
  await fs.rm(root, { recursive: true, force: true });
});

test("pinned skills bypass transitions", async () => {
  const root = await tmpSkillsRoot();
  await fs.writeFile(
    path.join(root, ".usage.json"),
    JSON.stringify({
      "pinned-skill": { useCount: 5, lastUsedAt: "2020-01-01T00:00:00Z", state: "active", pinned: true },
    }),
  );
  const counts = await applyAutomaticTransitions(root);
  assert.equal(counts.archived, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test("protected skills are never archived", async () => {
  const root = await tmpSkillsRoot();
  const name = [...PROTECTED_SKILLS][0];
  await fs.writeFile(
    path.join(root, ".usage.json"),
    JSON.stringify({ [name]: { useCount: 5, lastUsedAt: "2020-01-01T00:00:00Z", state: "active" } }),
  );
  const counts = await applyAutomaticTransitions(root);
  assert.equal(counts.archived, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test("buildSnapshot parses real DSH session/event envelope and filters system injections", () => {
  const events = [
    {
      type: "user/message",
      data: {
        content: [{ type: "text", text: "Current runtime context. This snapshot supersedes earlier snapshots." }],
        source: { kind: "system" },
      },
    },
    {
      type: "user/message",
      data: {
        content: [{ type: "text", text: "不对，你太啰嗦了，直接改默认 skillsRoot。" }],
        source: { kind: "user" },
      },
    },
    {
      type: "tool/call",
      data: {
        name: "skill",
        arguments: JSON.stringify({ name: "cordis-plugin-development" }),
      },
    },
    {
      type: "tool/result",
      data: {
        message: { content: [{ type: "text", text: "Loaded skill instructions" }] },
      },
    },
    {
      type: "assistant/message",
      data: {
        message: { content: [{ type: "text", text: "已修改默认路径。" }] },
      },
    },
  ];
  const snap = buildSnapshot(events);
  assert.equal(snap.worth, true);
  assert.ok(snap.signals.includes("user-correction"));
  assert.ok(snap.signals.includes("skill-was-wrong"));
  assert.deepEqual(snap.stats.skillsLoaded, ["cordis-plugin-development"]);
  assert.ok(!snap.transcript.includes("Current runtime context"));
  assert.ok(snap.transcript.includes("不对，你太啰嗦了"));
});
