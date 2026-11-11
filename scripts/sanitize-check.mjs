#!/usr/bin/env node
/**
 * 脱敏门禁：扫描仓库文本，禁止出现本机绝对路径、内网地址、私有包前缀、密钥前缀。
 *
 * 用法：node scripts/sanitize-check.mjs
 * 退出码：0 = 干净；1 = 有命中（逐条打印 file:line）。
 *
 * 说明：needle 一律用拼接构造，避免本文件被自己的门禁命中——
 * 门禁是对整个仓库做的，写下字面量会自报家门。
 *
 * 唯一例外是 `vendor/hermes/`：那是 Nous Research `hermes-agent` 的逐字副本
 * （MIT，见 vendor/hermes/PROVENANCE.md）。该目录里的 `skills_guard.py` 以
 * 回环地址、API key 前缀等字面量作为「密钥外泄检测规则」本身，改动它等于弄坏
 * 上游的检测语义。因此该目录不参与内容扫描，但会显式打印跳过数量，不做静默放行。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.woff', '.woff2']);
const MAX_BYTES = 2 * 1024 * 1024;

/** 逐字引入的第三方源码：内容不扫描，但文件名仍做备份检查。 */
const VENDOR_PREFIX = ['vendor', 'hermes'].join('/');

const NEEDLES = [
  // 基线五条
  { reason: 'absolute home path (macOS)', text: ['', 'Users', ''].join('/') },
  { reason: 'absolute home path (Linux)', text: ['', 'home', ''].join('/') },
  { reason: 'private package scope', text: '@' + 'local' },
  { reason: 'loopback IPv4 address', text: [127, 0, 0, 1].join('.') },
  { reason: 'loopback hostname', text: 'local' + 'host' },
  // 本批额外拦截
  { reason: 'private key material', text: 'PRIVATE' + ' KEY' },
  { reason: 'tailscale / internal IP', text: ['100', ''].join('.') },
  { reason: 'internal gateway name', text: 'mag' + 'pie' },
  { reason: 'cloud vendor host', text: 'cty' + 'un' },
  { reason: 'api key prefix', text: 'sk' + '-' },
  { reason: 'github token prefix', text: 'gh' + 'o_' },
];

/** 文件名层面的检查：备份文件与依赖目录不该出现在仓库里。 */
const BAD_NAME_PATTERNS = [
  { reason: 'backup file', test: (name) => name.includes('.bak-') },
  { reason: 'dependency directory', test: (name) => name === 'node_modules' },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(ROOT, full).split('\\').join('/');
    for (const bad of BAD_NAME_PATTERNS) {
      if (bad.test(entry.name)) out.badNames.push(`${rel}: ${bad.reason}`);
    }
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (rel === VENDOR_PREFIX || rel.startsWith(`${VENDOR_PREFIX}/`)) {
      out.vendored.push(rel);
      continue;
    }
    const name = entry.name;
    const dot = name.lastIndexOf('.');
    if (dot > 0 && SKIP_EXT.has(name.slice(dot).toLowerCase())) continue;
    out.files.push(full);
  }
  return out;
}

const collected = walk(ROOT, { files: [], vendored: [], badNames: [] });
const hits = [...collected.badNames];

for (const file of collected.files) {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    continue;
  }
  if (size > MAX_BYTES) continue;

  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\u0000')) continue; // 二进制

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const needle of NEEDLES) {
      if (!line.includes(needle.text)) continue;
      hits.push(`${relative(ROOT, file)}:${i + 1}: ${needle.reason}`);
    }
  }
}

const scanned = collected.files.length;
const vendoredCount = collected.vendored.length;

if (hits.length === 0) {
  console.log(`sanitize-check: clean (0 hits, ${scanned} files scanned)`);
  if (vendoredCount > 0) {
    console.log(`sanitize-check: skipped ${vendoredCount} vendored file(s) under ${VENDOR_PREFIX}/ (verbatim upstream source)`);
  }
  process.exit(0);
}

console.error(`sanitize-check: ${hits.length} hit(s)`);
for (const hit of hits) console.error(`  ${hit}`);
process.exit(1);
