// 校验 lib/prompts.js 与 Hermes 原文的一致性
import fs from "node:fs";
import path from "node:path";
import { LESSON_LAYER_BLOCK, DO_NOT_CAPTURE_BLOCK } from "../lib/prompts.js";

const root = path.resolve(import.meta.dirname, "..");
const src = fs.readFileSync(path.join(root, "vendor/hermes/background_review.py"), "utf8");

function extractPyConst(name) {
  const start = src.indexOf(`${name} = (`);
  if (start < 0) return null;
  let i = src.indexOf("(", start);
  let depth = 0;
  let end = -1;
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = src.slice(start, end + 1);
  const parts = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    parts.push(m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\"));
  }
  return parts.join("");
}

const checks = [
  ["LESSON_LAYER_BLOCK", LESSON_LAYER_BLOCK],
  ["_DO_NOT_CAPTURE_BLOCK", DO_NOT_CAPTURE_BLOCK],
];

for (const [pyName, jsValue] of checks) {
  const py = extractPyConst(pyName);
  if (py === null) {
    console.log(`⚠️  找不到 ${pyName}`);
    continue;
  }
  const same = py.trim() === jsValue.trim();
  console.log(`${same ? "✅" : "❌"} ${pyName}: Python ${py.length} chars / JS ${jsValue.length} chars`);
  if (!same) process.exitCode = 1;
}
