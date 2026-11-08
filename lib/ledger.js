/**
 * 技能变更账本（Skill Ledger）
 *
 * 移植自 Hermes `tools/skill_ledger.py`。
 *
 * 每一次技能变更（任何 actor：curator / agent / user）都在
 * `<skillsRoot>/.evolution_ledger.jsonl` 追加一条 JSON 记录，记录变更前后的
 * 文件清单，内容按 sha256 去重存进 `<skillsRoot>/.evolution_backups/blobs/`。
 *
 * 为什么用 JSONL 而不是数据库：
 *   - 持久、可 grep、可人工审阅
 *   - 数据库重置不会丢账
 *   - 追加写天然并发安全（配合 appendFile 的原子性）
 *
 * **定位：遥测，不是闸门。** 所有公开写入路径失败时吞掉并记日志，
 * 绝不让记账失败阻断业务。唯一例外是 `rollbackEntry`——它在安全捕获
 * 失败时 **fail closed**（宁可拒绝回滚，也不做一次不可逆的错误回滚）。
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const LEDGER_FILENAME = ".evolution_ledger.jsonl";
export const BACKUP_DIRNAME = ".evolution_backups";
const BLOB_GC_GRACE_MS = 3600 * 1000; // 1 小时内的 blob 可能属于进行中的捕获，永不 GC
const DEFAULT_LEDGER_MAX_BYTES = 5 * 1024 * 1024;

/** 这些目录是账本自身的家，绝不能被打进快照（否则账本会自我吞食）。 */
const NON_PACKAGE_TOPS = new Set([
  BACKUP_DIRNAME,
  ".staging",
  ".archive",
  ".locks",
  ".hub",
]);

/** 可再生的临时产物，永远不该进快照。 */
const TRANSIENT_DIRS = new Set([
  ".venv",
  "venv",
  "env",
  ".env",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".git",
]);

export const VALID_ACTORS = new Set(["curator", "agent", "user"]);

function nowIso() {
  return new Date().toISOString();
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function ledgerPath(skillsRoot) {
  return path.join(skillsRoot, LEDGER_FILENAME);
}

function blobsDir(skillsRoot) {
  return path.join(skillsRoot, BACKUP_DIRNAME, "blobs");
}

/**
 * 递归收集一个技能目录下的所有文件（跳过临时产物与账本自身目录）。
 * 返回 [{ relPath, absPath, size }]。
 */
async function collectFiles(rootDir, baseDir = rootDir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(rootDir, entry.name);
    const rel = path.relative(baseDir, abs);
    if (entry.isDirectory()) {
      if (TRANSIENT_DIRS.has(entry.name)) continue;
      if (rootDir === baseDir && NON_PACKAGE_TOPS.has(entry.name)) continue;
      await collectFiles(abs, baseDir, out);
    } else if (entry.isFile()) {
      try {
        const st = await fs.stat(abs);
        out.push({ relPath: rel, absPath: abs, size: st.size });
      } catch {
        /* 文件在扫描途中消失：跳过 */
      }
    }
  }
  return out;
}

/**
 * 捕获一个目录的内容清单，并把每个文件的内容按 sha256 存进 blob 库。
 * 返回 { files: [{relPath, size, sha}], capturedAt }。
 *
 * 这是回滚的依据：只要 blob 还在，就能把目录还原到这一刻。
 */
export async function captureSnapshot(skillsRoot, targetDir) {
  const blobs = blobsDir(skillsRoot);
  await fs.mkdir(blobs, { recursive: true });
  const files = [];
  for (const f of await collectFiles(targetDir)) {
    let buf;
    try {
      buf = await fs.readFile(f.absPath);
    } catch {
      continue;
    }
    const sha = sha256(buf);
    const blobPath = path.join(blobs, sha);
    try {
      await fs.access(blobPath);
    } catch {
      await fs.writeFile(blobPath, buf);
    }
    files.push({ relPath: f.relPath, size: f.size, sha });
  }
  return { files, capturedAt: nowIso() };
}

/**
 * 追加一条账本记录。
 *
 * @param {string} skillsRoot       技能根目录（账本与 blob 都放这里）
 * @param {object} entry
 * @param {string} entry.action     create | patch | write_file | delete | archive | pin | rollback
 * @param {string} entry.target     技能名或技能相对路径
 * @param {string} [entry.actor]    curator | agent | user（默认 agent）
 * @param {object} [entry.before]   captureSnapshot 的结果
 * @param {object} [entry.after]    captureSnapshot 的结果
 * @param {object} [entry.extra]    其他任意元数据（rationale、signals 等）
 * @returns {Promise<string|null>} 记录 id；失败返回 null（遥测不阻断业务）
 */
export async function appendEntry(skillsRoot, entry) {
  try {
    const actor = VALID_ACTORS.has(entry.actor) ? entry.actor : "agent";
    const record = {
      id: randomUUID(),
      ts: nowIso(),
      action: String(entry.action ?? "unknown"),
      target: String(entry.target ?? ""),
      actor,
      before: entry.before ?? null,
      after: entry.after ?? null,
      ...(entry.extra && typeof entry.extra === "object" ? { extra: entry.extra } : {}),
    };
    await fs.mkdir(skillsRoot, { recursive: true });
    await fs.appendFile(ledgerPath(skillsRoot), JSON.stringify(record) + "\n", "utf8");
    return record.id;
  } catch (error) {
    // 遥测失败绝不阻断写入路径
    console.warn("[dsh-evolution] ledger append failed:", error?.message ?? error);
    return null;
  }
}

/** 读取全部账本记录（跳过损坏行）。 */
export async function readEntries(skillsRoot, { limit = 0 } = {}) {
  let text;
  try {
    text = await fs.readFile(ledgerPath(skillsRoot), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* 损坏行跳过 */
    }
  }
  return limit > 0 ? out.slice(-limit) : out;
}

/**
 * 回滚一条记录到它的 `before` 状态。
 *
 * **失败关闭**：如果无法完整捕获当前状态作为"回滚前快照"，
 * 直接抛错拒绝执行——宁可不动，也不做一次不可逆的错误回滚。
 *
 * @returns {Promise<{ok: boolean, restored: number, error?: string}>}
 */
export async function rollbackEntry(skillsRoot, entryId) {
  const entries = await readEntries(skillsRoot);
  const entry = entries.find((e) => e.id === entryId);
  if (!entry) return { ok: false, restored: 0, error: `ledger entry not found: ${entryId}` };
  if (!entry.before || !Array.isArray(entry.before.files)) {
    return { ok: false, restored: 0, error: `entry ${entryId} has no before-snapshot (nothing to roll back to)` };
  }

  const targetDir = path.join(skillsRoot, entry.target);

  // fail-closed：先安全捕获当前状态，失败则拒绝回滚
  let currentSnapshot;
  try {
    currentSnapshot = await captureSnapshot(skillsRoot, targetDir);
  } catch (error) {
    return { ok: false, restored: 0, error: `safety capture failed, refusing to roll back: ${error?.message ?? error}` };
  }

  // 用 before 快照重建目录：先清空（保留账本目录），再写回
  try {
    let existing = [];
    try {
      existing = await fs.readdir(targetDir);
    } catch {
      /* 目录不存在：直接创建 */
    }
    for (const name of existing) {
      if (NON_PACKAGE_TOPS.has(name)) continue;
      await fs.rm(path.join(targetDir, name), { recursive: true, force: true });
    }
    await fs.mkdir(targetDir, { recursive: true });

    let restored = 0;
    for (const f of entry.before.files) {
      const blobPath = path.join(blobsDir(skillsRoot), f.sha);
      let buf;
      try {
        buf = await fs.readFile(blobPath);
      } catch {
        return { ok: false, restored, error: `blob missing for ${f.relPath} (sha ${f.sha}); rollback incomplete` };
      }
      const dest = path.join(targetDir, f.relPath);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, buf);
      restored += 1;
    }

    await appendEntry(skillsRoot, {
      action: "rollback",
      target: entry.target,
      actor: "agent",
      before: currentSnapshot,
      after: entry.before,
      extra: { rolledBackEntryId: entryId },
    });
    return { ok: true, restored };
  } catch (error) {
    return { ok: false, restored: 0, error: String(error?.message ?? error) };
  }
}

/**
 * 账本体积控制：超过上限时把最老的一半归档到 `.1` 后缀文件。
 * 返回 { rotated: boolean, bytes }。
 */
export async function maybeRotateLedger(skillsRoot, maxBytes = DEFAULT_LEDGER_MAX_BYTES) {
  const p = ledgerPath(skillsRoot);
  let st;
  try {
    st = await fs.stat(p);
  } catch {
    return { rotated: false, bytes: 0 };
  }
  if (st.size <= maxBytes) return { rotated: false, bytes: st.size };
  try {
    const text = await fs.readFile(p, "utf8");
    const lines = text.split("\n").filter((l) => l.trim());
    const half = Math.floor(lines.length / 2);
    const archivePath = `${p}.${Date.now()}`;
    await fs.writeFile(archivePath, lines.slice(0, half).join("\n") + "\n", "utf8");
    await fs.writeFile(p, lines.slice(half).join("\n") + "\n", "utf8");
    return { rotated: true, bytes: st.size };
  } catch (error) {
    console.warn("[dsh-evolution] ledger rotation failed:", error?.message ?? error);
    return { rotated: false, bytes: st.size };
  }
}

/**
 * blob 垃圾回收：删除超过宽限期、且不再被任何账本记录引用的 blob。
 * 宽限期内的 blob 可能属于进行中的捕获，永不删除。
 */
export async function gcBlobs(skillsRoot, graceMs = BLOB_GC_GRACE_MS) {
  const blobs = blobsDir(skillsRoot);
  const referenced = new Set();
  for (const entry of await readEntries(skillsRoot)) {
    for (const snap of [entry.before, entry.after]) {
      if (!snap?.files) continue;
      for (const f of snap.files) if (f?.sha) referenced.add(f.sha);
    }
  }
  let removed = 0;
  let names;
  try {
    names = await fs.readdir(blobs);
  } catch {
    return { removed: 0 };
  }
  const cutoff = Date.now() - graceMs;
  for (const name of names) {
    if (referenced.has(name)) continue;
    const abs = path.join(blobs, name);
    try {
      const st = await fs.stat(abs);
      if (st.mtimeMs > cutoff) continue;
      await fs.rm(abs, { force: true });
      removed += 1;
    } catch {
      /* 忽略 */
    }
  }
  return { removed };
}
