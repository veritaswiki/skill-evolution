import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { extractJsonBlock } from "../lib/synthesizer.js";
import { planTidy, applyTidy, nameSimilarity } from "../lib/tidy.js";

/** 建一个临时的 skills 根目录，含正式技能与 .staging 草稿。 */
async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-tidy-"));
  const staging = path.join(root, ".staging");
  await fs.mkdir(staging, { recursive: true });

  const writeSkill = async (base, name, description, body) => {
    const dir = path.join(base, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`,
      "utf8",
    );
  };

  // 正式技能
  await writeSkill(root, "dsh-plugin-engine", "DSH plugin engineering umbrella", "x".repeat(400));
  await writeSkill(root, "network-diagnosis", "network diagnosis umbrella", "x".repeat(400));

  // 草稿：同名补丁、跨域新增（同域两份）、过短草稿、损坏目录
  await writeSkill(staging, "network-diagnosis", "network diagnosis umbrella", "y".repeat(600));
  await writeSkill(staging, "macos-app-install", "install macOS app and bind model", "z".repeat(600));
  await writeSkill(staging, "macos-app-config", "edit macOS third party app config", "z".repeat(600));
  await writeSkill(staging, "tiny-note", "too short", "short");

  // 损坏：只有附属文件，没有 SKILL.md
  await fs.mkdir(path.join(staging, "broken-one"), { recursive: true });
  await fs.writeFile(path.join(staging, "broken-one", ".briefing.json"), "{}", "utf8");

  // 必须被跳过的内部目录
  await fs.mkdir(path.join(staging, ".evolution_backups"), { recursive: true });

  return root;
}

// ---------------- extractJsonBlock：截断与非法字符修复 ----------------

test("extractJsonBlock 解析正常闭合的 json 围栏", () => {
  const raw = '```json\n{"action":"patch","target":"a","frontmatter":{"name":"a","description":"d"},"body":"b"}\n```';
  const r = extractJsonBlock(raw);
  assert.equal(r.action, "patch");
  assert.equal(r.target, "a");
});

test("extractJsonBlock 修复被截断、缺少闭合围栏的输出", () => {
  const raw = [
    "分析完成。",
    "```json",
    "{",
    '  "action": "create",',
    '  "target": "embedded-ui-restyle",',
    '  "frontmatter": {"name": "embedded-ui-restyle", "description": "d"},',
    '  "body": "第一行\\n第二行',
  ].join("\n");
  const r = extractJsonBlock(raw);
  assert.ok(r, "截断输出应当被修复而不是丢弃");
  assert.equal(r.action, "create");
  assert.equal(r.target, "embedded-ui-restyle");
  assert.ok(r.body && r.body.length > 0, "已产出的 body 片段应当保留");
});

test("extractJsonBlock 修复字符串内未转义的真实换行", () => {
  // 手工构造一段非法 JSON：body 里放真实换行
  const raw = '```json\n{"action":"patch","target":"b","frontmatter":{"name":"b","description":"d"},"body":"line1\nline2"}\n```';
  const r = extractJsonBlock(raw);
  assert.ok(r, "未转义换行不应导致整轮复盘失败");
  assert.equal(r.target, "b");
  assert.match(r.body, /line1/);
});

test("extractJsonBlock 对无 JSON 内容返回 null", () => {
  assert.equal(extractJsonBlock("这里完全没有结构化输出"), null);
  assert.equal(extractJsonBlock(""), null);
  assert.equal(extractJsonBlock(null), null);
});

// ---------------- nameSimilarity ----------------

test("nameSimilarity 对同名返回 1，对无关名字返回 0", () => {
  assert.equal(nameSimilarity("dsh-plugin-authoring", "dsh-plugin-authoring"), 1);
  assert.equal(nameSimilarity("alpha-beta", "gamma-delta"), 0);
  assert.ok(nameSimilarity("dsh-plugin-authoring", "dsh-plugin-engineering") > 0.3);
});

// ---------------- planTidy ----------------

test("planTidy 把同名草稿判为自动升级，把同域多份判为待合并组", async () => {
  const root = await makeFixture();
  const plan = await planTidy(root);

  assert.ok(
    plan.autoPromote.some((c) => c.name === "network-diagnosis" && c.anchor === "network-diagnosis"),
    "同名草稿应进入自动升级",
  );

  const macosGroup = plan.groups.find((g) => g.members.includes("macos-app-install"));
  assert.ok(macosGroup, "macOS 主题应形成一个分组");
  assert.equal(macosGroup.suggestion, "merge", "同域两份应建议合并");

  await fs.rm(root, { recursive: true, force: true });
});

test("planTidy 识别损坏草稿并跳过内部点目录", async () => {
  const root = await makeFixture();
  const plan = await planTidy(root);

  assert.ok(
    plan.corrupt.some((c) => c.name === "broken-one"),
    "缺失 SKILL.md 的目录应判为损坏",
  );
  assert.ok(
    !plan.corrupt.some((c) => c.name === ".evolution_backups"),
    "内部点目录不能被当成损坏草稿",
  );

  await fs.rm(root, { recursive: true, force: true });
});

test("planTidy 把过短草稿判为自动归档而不是待审", async () => {
  const root = await makeFixture();
  const plan = await planTidy(root);
  assert.ok(plan.autoDrop.some((c) => c.name === "tiny-note"));
  await fs.rm(root, { recursive: true, force: true });
});

// ---------------- applyTidy ----------------

test("applyTidy 归档损坏与过短草稿，且绝不物理删除", async () => {
  const root = await makeFixture();
  const plan = await planTidy(root);
  const res = await applyTidy(root, {
    corrupt: plan.corrupt,
    autoPromote: [],
    autoDrop: plan.autoDrop,
  });

  assert.equal(res.errors.length, 0);

  const archive = path.join(root, ".archive");
  const archived = await fs.readdir(archive);
  assert.ok(archived.some((n) => n.startsWith("broken-one")), "损坏草稿应移入 .archive");
  assert.ok(archived.some((n) => n.startsWith("tiny-note")), "过短草稿应移入 .archive");

  // 原始目录已不存在于 staging，但归档区仍有实体（不是删除）
  const staging = await fs.readdir(path.join(root, ".staging"));
  assert.ok(!staging.includes("broken-one"));
  assert.ok(archived.length >= 2);

  await fs.rm(root, { recursive: true, force: true });
});
