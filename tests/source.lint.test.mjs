// Source lint: keep恒等三元（no-op ternaries）与内部异常文案彻底清出源码。
// 背景：t5 评审连续命中 `? "" : ""`、`(mode === "blank" ? optionsHtml : optionsHtml)`
// 这类恒等表达式，构建后会原样进入成品 HTML，因此加一条回归自检长期守住。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// 恒等三元的三类形态：空串分支、同一标识符/属性链、同一字面量或同一调用
const IDENTITY_PATTERNS = [
  { name: "empty-string ternary", re: /\?\s*(?:"{2}|'{2})\s*:\s*(?:"{2}|'{2})/g },
  { name: "same identifier ternary", re: /\?\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*:\s*\1(?=\s*[,;)])/g },
  { name: "same literal ternary", re: /\?\s*(\d+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*:\s*\1(?=\s*[,;)])/g },
  { name: "same call ternary", re: /\?\s*([A-Za-z_$][\w$.]*\(\s*[^()]*\))\s*:\s*\1(?=\s*[,;)])/g },
];

function sourceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|js|css|cjs)$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(root, "src"));
  files.push(path.join(root, "tools", "build.mjs"));
  return files;
}

function scanFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const hits = [];
  lines.forEach((line, index) => {
    for (const pattern of IDENTITY_PATTERNS) {
      pattern.re.lastIndex = 0;
      if (pattern.re.test(line)) {
        hits.push({ file: path.relative(root, filePath).replace(/\\/g, "/"), line: index + 1, kind: pattern.name, text: line.trim() });
      }
    }
  });
  return hits;
}

test("lint scanner detects identity ternaries (self-test)", () => {
  const synthetic = [
    'var a = flag ? "" : "";',
    "var b = mode === \"blank\" ? optionsHtml : optionsHtml;",
    "var c = item.skipped ? item.skipped : item.skipped;",
    'var d = f() ? f() : f();',
    "var e = 1 ? 1 : 1;",
  ].join("\n");
  let found = 0;
  for (const pattern of IDENTITY_PATTERNS) {
    pattern.re.lastIndex = 0;
    found += (synthetic.match(pattern.re) || []).length;
  }
  assert.ok(found >= 5, "scanner must flag every identity-ternary shape, found " + found);
});

test("no identity ternaries in src/ or tools/build.mjs", () => {
  const hits = [];
  for (const file of sourceFiles()) hits.push(...scanFile(file));
  const detail = hits.map((hit) => hit.file + ":" + hit.line + " [" + hit.kind + "] " + hit.text).join("\n");
  assert.equal(hits.length, 0, "identity ternaries found:\n" + detail);

  // 跨行写法也要覆盖：整文件文本级再扫一遍
  const multiline = [];
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of IDENTITY_PATTERNS) {
      pattern.re.lastIndex = 0;
      const found = text.match(pattern.re);
      if (found) multiline.push(path.relative(root, file).replace(/\\/g, "/") + " [" + pattern.name + "] " + found.join(" | "));
    }
  }
  assert.equal(multiline.length, 0, "identity ternaries found (text level):\n" + multiline.join("\n"));
});

test("UI never surfaces caught-exception messages", () => {
  const uiFiles = ["app.js"].map((name) => path.join(root, "src", "ui", name));
  const offenders = [];
  for (const file of uiFiles) {
    const text = fs.readFileSync(file, "utf8");
    // 只针对 catch 参数（真正的异常对象）；结构化结果里的 {code,message}（如 storage.save 返回值）不受限
    const catchVars = new Set();
    const catchRe = /catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
    let match = catchRe.exec(text);
    while (match) {
      catchVars.add(match[1]);
      match = catchRe.exec(text);
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const name of catchVars) {
        if (new RegExp("\\b" + name + "\\.(message|stack)\\b").test(line)) {
          offenders.push(path.relative(root, file).replace(/\\/g, "/") + ":" + (index + 1) + " " + line.trim());
        }
      }
    });
  }
  assert.equal(offenders.length, 0, "caught-exception messages must not reach the UI:\n" + offenders.join("\n"));
});

test("sources stay free of protocol text (self-contained precondition)", () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    if (file.indexOf(path.join("tools", "build.mjs")) >= 0) continue; // 构建脚本自身含检测用正则
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (/https?:\/\//.test(line)) {
        offenders.push(path.relative(root, file).replace(/\\/g, "/") + ":" + (index + 1) + " " + line.trim());
      }
    });
  }
  assert.equal(offenders.length, 0, "no protocol text allowed in inlined sources:\n" + offenders.join("\n"));
});
