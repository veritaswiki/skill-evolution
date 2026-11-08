/**
 * Curator 合并能力测试
 *
 * 验证移植自 Hermes `CURATOR_REVIEW_PROMPT` 的建伞合并逻辑。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  validateCuratorOps,
  applyCuratorOps,
  extractCuratorOps,
  listConsolidationCandidates,
  runConsolidation,
} from "../lib/consolidation.js";
import { renderSkillMarkdown } from "../lib/gatekeeper.js";
import { listSkills } from "../lib/applier.js";
import { loadUsage, adoptSkill, disownSkill, listUnmanaged, setUsageFlag } from "../lib/usage.js";
import { readEntries } from "../lib/ledger.js";
import { buildCuratorPrompt, CURATOR_REVIEW_PROMPT } from "../lib/prompts.js";

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "dsh-consol-"));
}

async function makeSkill(root, name, description, body = "# Body\n\nDo the thing.") {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    renderSkillMarkdown({ name, description, metadata: { createdBy: "agent" } }, body),
  );
}

// ---------- 提示词 ----------

test("curator prompt carries Hermes umbrella-building rules", () => {
  const p = CURATOR_REVIEW_PROMPT;
  assert.ok(p.includes("UMBRELLA-BUILDING consolidation pass"));
  assert.ok(p.includes("LIBRARY OF CLASS-LEVEL"));
  assert.ok(p.includes("DO NOT delete any skill"));
  assert.ok(p.includes("DO NOT touch skills shown as pinned=yes"));
  assert.ok(p.includes("use=0"));
  assert.ok(p.includes("PREFIX CLUSTERS"));
  assert.ok(p.includes("Package integrity"));
  assert.ok(p.includes("absorbed_into"));
});

test("buildCuratorPrompt includes candidates and protected list", () => {
  const p = buildCuratorPrompt({
    candidates: [{ name: "a-skill", description: "does a", useCount: 3, state: "active" }],
    protectedNames: ["agent-experience"],
  });
  assert.ok(p.includes("a-skill"));
  assert.ok(p.includes("use=3"));
  assert.ok(p.includes("agent-experience"));
  assert.ok(p.includes("Output contract"));
});

// ---------- 输出解析 ----------

test("extractCuratorOps parses operations", () => {
  const raw = '```json\n{"operations":[{"op":"archive","target":"a","absorbedInto":"b"}],"summary":"merged"}\n```';
  const r = extractCuratorOps(raw);
  assert.equal(r.ok, true);
  assert.equal(r.ops.length, 1);
  assert.equal(r.summary, "merged");
});

test("extractCuratorOps handles empty operations", () => {
  const r = extractCuratorOps('```json\n{"operations":[],"summary":"nothing"}\n```');
  assert.equal(r.ok, true);
  assert.equal(r.ops.length, 0);
});

// ---------- 校验闸门 ----------

test("validate rejects archive without absorbedInto", () => {
  const r = validateCuratorOps([{ op: "archive", target: "a" }], { existingNames: new Set(["a", "b"]) });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes("missing absorbedInto"));
});

test("validate rejects archive whose absorb target does not exist", () => {
  const r = validateCuratorOps([{ op: "archive", target: "a", absorbedInto: "ghost" }], {
    existingNames: new Set(["a"]),
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes("does not exist"));
});

test("validate allows archive when umbrella is created in same batch", () => {
  const r = validateCuratorOps(
    [
      { op: "create", target: "new-umbrella", frontmatter: { name: "new-umbrella", description: "umbrella" }, body: "# Umbrella" },
      { op: "archive", target: "a", absorbedInto: "new-umbrella" },
    ],
    { existingNames: new Set(["a"]) },
  );
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("validate rejects archiving a protected skill", () => {
  const r = validateCuratorOps([{ op: "archive", target: "agent-experience", absorbedInto: "x" }], {
    existingNames: new Set(["agent-experience", "x"]),
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes("protected"));
});

test("validate rejects narrow session-artifact umbrella name", () => {
  const r = validateCuratorOps(
    [{ op: "create", target: "fix-hmr-bug", frontmatter: { name: "fix-hmr-bug", description: "d" }, body: "# x" }],
    { existingNames: new Set() },
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes("session artifact"));
});

test("validate rejects forbidden content in umbrella body", () => {
  const r = validateCuratorOps(
    [
      {
        op: "create",
        target: "some-class",
        frontmatter: { name: "some-class", description: "d" },
        body: "The browser tool does not work.",
      },
    ],
    { existingNames: new Set() },
  );
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes("forbidden content"));
});

test("validate rejects write_file outside support dirs", () => {
  const r = validateCuratorOps([{ op: "write_file", target: "a", filePath: "../evil.md", body: "x" }], {
    existingNames: new Set(["a"]),
  });
  assert.equal(r.ok, false);
});

test("validate rejects patch on nonexistent skill", () => {
  const r = validateCuratorOps([{ op: "patch", target: "ghost", body: "# x" }], { existingNames: new Set() });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes("does not exist"));
});

// ---------- 执行 ----------

test("applyCuratorOps performs create → patch → write_file → archive in order", async () => {
  const root = await tmpRoot();
  await makeSkill(root, "narrow-a", "narrow a");
  await makeSkill(root, "narrow-b", "narrow b");

  const ops = [
    { op: "archive", target: "narrow-a", absorbedInto: "big-umbrella", reason: "absorbed" },
    { op: "create", target: "big-umbrella", frontmatter: { name: "big-umbrella", description: "umbrella" }, body: "# Umbrella\n\n## A\n\nrule a" },
    { op: "write_file", target: "big-umbrella", filePath: "references/topic.md", body: "# Topic depth" },
  ];
  const r = await applyCuratorOps(root, ops);
  assert.equal(r.ok, true, JSON.stringify(r.errors));

  const skills = await listSkills(root);
  const names = skills.map((s) => s.name);
  assert.ok(names.includes("big-umbrella"), "umbrella created");
  assert.ok(!names.includes("narrow-a"), "narrow-a archived away");

  const ref = await fs.readFile(path.join(root, "big-umbrella", "references", "topic.md"), "utf8");
  assert.ok(ref.includes("Topic depth"));

  const archived = await fs.readdir(path.join(root, ".archive"));
  assert.ok(archived.some((d) => d.startsWith("narrow-a")));

  const entries = await readEntries(root);
  const actions = entries.map((e) => e.action);
  assert.ok(actions.includes("curator_create"));
  assert.ok(actions.includes("curator_write_file"));
  assert.ok(actions.includes("curator_archive"));

  await fs.rm(root, { recursive: true, force: true });
});

test("applyCuratorOps records absorbedInto in the ledger", async () => {
  const root = await tmpRoot();
  await makeSkill(root, "sibling", "sib");
  await makeSkill(root, "umbrella", "umb");
  await applyCuratorOps(root, [{ op: "archive", target: "sibling", absorbedInto: "umbrella", reason: "dup" }]);
  const entries = await readEntries(root);
  const arch = entries.find((e) => e.action === "curator_archive");
  assert.equal(arch.extra.absorbedInto, "umbrella");
  assert.equal(arch.extra.reason, "dup");
  await fs.rm(root, { recursive: true, force: true });
});

// ---------- 候选过滤 ----------

test("listConsolidationCandidates excludes pinned and protected", async () => {
  const root = await tmpRoot();
  await makeSkill(root, "normal-one", "n1");
  await makeSkill(root, "pinned-one", "p2");
  await makeSkill(root, "agent-experience", "protected");
  await setUsageFlag(root, "pinned-one", { pinned: true });

  const c = await listConsolidationCandidates(root);
  const names = c.map((s) => s.name);
  assert.ok(names.includes("normal-one"));
  assert.ok(!names.includes("pinned-one"), "pinned excluded");
  assert.ok(!names.includes("agent-experience"), "protected excluded");
  await fs.rm(root, { recursive: true, force: true });
});

// ---------- 完整 pass ----------

test("runConsolidation skips when fewer than 2 candidates", async () => {
  const root = await tmpRoot();
  await makeSkill(root, "only-one", "o");
  const r = await runConsolidation(root, { runFork: async () => "{}" });
  assert.equal(r.skipped, true);
  await fs.rm(root, { recursive: true, force: true });
});

test("runConsolidation dry-run reports plan without writing", async () => {
  const root = await tmpRoot();
  await makeSkill(root, "sib-a", "a");
  await makeSkill(root, "sib-b", "b");

  const fork = async () =>
    '```json\n' +
    JSON.stringify({
      operations: [{ op: "archive", target: "sib-a", absorbedInto: "sib-b", reason: "dup" }],
      summary: "merge a into b",
    }) +
    "\n```";

  const r = await runConsolidation(root, { runFork: fork, dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(r.planned.length, 1);

  const skills = await listSkills(root);
  assert.ok(skills.some((s) => s.name === "sib-a"), "dry run must not archive");
  await fs.rm(root, { recursive: true, force: true });
});

test("runConsolidation applies when dryRun false", async () => {
  const root = await tmpRoot();
  await makeSkill(root, "sib-a", "a");
  await makeSkill(root, "sib-b", "b");

  const fork = async () =>
    '```json\n' +
    JSON.stringify({
      operations: [{ op: "archive", target: "sib-a", absorbedInto: "sib-b", reason: "dup" }],
      summary: "merge",
    }) +
    "\n```";

  const r = await runConsolidation(root, { runFork: fork, dryRun: false });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.done.length, 1);
  const skills = await listSkills(root);
  assert.ok(!skills.some((s) => s.name === "sib-a"));
  await fs.rm(root, { recursive: true, force: true });
});

test("runConsolidation rejects an invalid batch wholesale", async () => {
  const root = await tmpRoot();
  await makeSkill(root, "sib-a", "a");
  await makeSkill(root, "sib-b", "b");

  const fork = async () =>
    '```json\n' +
    JSON.stringify({
      operations: [{ op: "archive", target: "sib-a" }], // missing absorbedInto
      summary: "bad",
    }) +
    "\n```";

  const r = await runConsolidation(root, { runFork: fork, dryRun: false });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
  const skills = await listSkills(root);
  assert.ok(skills.some((s) => s.name === "sib-a"), "nothing archived on rejection");
  await fs.rm(root, { recursive: true, force: true });
});

// ---------- adopt ----------

test("adoptSkill brings an unmanaged skill under management", async () => {
  const root = await tmpRoot();
  await makeSkill(root, "user-skill", "hand written");
  let unmanaged = await listUnmanaged(root, ["user-skill"]);
  assert.deepEqual(unmanaged, ["user-skill"]);

  const r = await adoptSkill(root, "user-skill");
  assert.equal(r.ok, true);

  unmanaged = await listUnmanaged(root, ["user-skill"]);
  assert.deepEqual(unmanaged, []);

  const usage = await loadUsage(root);
  assert.equal(usage["user-skill"].adopted, true);
  await fs.rm(root, { recursive: true, force: true });
});

test("adoptSkill refuses an already-managed skill", async () => {
  const root = await tmpRoot();
  await makeSkill(root, "a-skill", "d");
  await adoptSkill(root, "a-skill");
  const r = await adoptSkill(root, "a-skill");
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("already managed"));
  await fs.rm(root, { recursive: true, force: true });
});

test("disownSkill returns a skill to unmanaged", async () => {
  const root = await tmpRoot();
  await makeSkill(root, "a-skill", "d");
  await adoptSkill(root, "a-skill");
  const r = await disownSkill(root, "a-skill");
  assert.equal(r.ok, true);
  const unmanaged = await listUnmanaged(root, ["a-skill"]);
  assert.deepEqual(unmanaged, ["a-skill"]);
  await fs.rm(root, { recursive: true, force: true });
});
