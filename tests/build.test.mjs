// Build tool: self-contained single file, repeatability, inlined bank.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { build, escapeJsonForHtml, selfContainmentCheck, stripEsm } from "../tools/build.mjs";
import { cn_VERSION } from "../src/core/constants.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fixturePath = path.join(here, "fixtures", "bank.sample.json");
const realPath = path.join(root, "src", "data", "bank.json");
// t46 O-01：临时产物写系统临时目录，绝不落在交付目录 dist/
const tmpOut = path.join(os.tmpdir(), "__cqp_artifact_test.html");
const tmpReport = path.join(os.tmpdir(), "__cqp_artifact_test.report.json");

function extractScript(html, id) {
  const marker = '<script id="' + id + '"';
  const start = html.indexOf(marker);
  assert.ok(start > 0, "missing script block: " + id);
  const openEnd = html.indexOf(">", start);
  const close = html.indexOf("</script>", openEnd);
  assert.ok(close > 0, "unterminated script block: " + id);
  return html.slice(openEnd + 1, close);
}

test("stripEsm turns core modules into one plain script", () => {
  const source = [
    'import { a } from "./a.mjs";',
    'import {',
    "  b,",
    '} from "./b.mjs";',
    "export const value = 1;",
    "export function run() { return value; }",
    'export { value as alias };',
    "const local = 2;",
  ].join("\n");
  const out = stripEsm(source, "sample.mjs");
  assert.equal(out.indexOf("import"), -1);
  assert.ok(out.indexOf("export") === -1, "no export keywords left");
  assert.ok(out.indexOf("export { value as alias }") === -1);
  assert.ok(out.indexOf("const value = 1;") >= 0);
  assert.ok(out.indexOf("function run()") >= 0);
  assert.ok(out.indexOf("const local = 2;") >= 0);
});

test("escapeJsonForHtml hides protocol text and tag openers", () => {
  const json = JSON.stringify({ stem: "见 http://example.com/a 与 https://b.c", html: "<b>" });
  const escaped = escapeJsonForHtml(json);
  assert.equal(escaped.indexOf("http://"), -1);
  assert.equal(escaped.indexOf("https://"), -1);
  assert.equal(escaped.indexOf("<"), -1);
  const parsed = JSON.parse(escaped);
  assert.equal(parsed.stem, "见 http://example.com/a 与 https://b.c");
  assert.equal(parsed.html, "<b>");
});

test("selfContainmentCheck detects forbidden references", () => {
  assert.equal(selfContainmentCheck("<html><body>ok</body></html>").ok, true);
  assert.equal(selfContainmentCheck('<script src="a.js"></script>').ok, false);
  assert.equal(selfContainmentCheck("<style>@import 'a.css';</style>").ok, false);
  assert.equal(selfContainmentCheck("var x = fetch('/a');").ok, false);
  assert.equal(selfContainmentCheck("new XMLHttpRequest();").ok, false);
  assert.equal(selfContainmentCheck("new WebSocket('wss://x');").ok, false);
});

test("build produces a self-contained single file from the fixture bank", () => {
  const result = build({ bankPath: fixturePath, outPath: tmpOut, reportPath: tmpReport });
  assert.equal(result.ok, true, JSON.stringify(result.blockingErrors));
  assert.equal(result.fixture, true);
  assert.equal(result.questions, 38);
  assert.equal(result.selfContainment.ok, true, result.selfContainment.problems.join(","));
  assert.ok(result.bytes > 20000);

  const html = fs.readFileSync(tmpOut, "utf8");
  assert.equal(/https?:\/\//.test(html), false, "no protocol text in the artifact");
  assert.ok(html.indexOf("<!DOCTYPE html>") === 0);
  assert.ok(html.indexOf('<script id="bank-data" type="application/json">') > 0);
  assert.ok(html.indexOf('<script id="cqp-core">') > 0);
  assert.ok(html.indexOf('<script id="cqp-app">') > 0);
  assert.ok(html.indexOf("CQP") > 0);
  assert.ok(html.indexOf("分类练习") > 0);
  assert.ok(html.indexOf("模拟选拔赛") > 0);
  assert.ok(html.indexOf("{{APP_VERSION}}") === -1, "placeholders replaced");

  const report = JSON.parse(fs.readFileSync(tmpReport, "utf8"));
  assert.equal(report.questions, 38);
  assert.equal(report.selfContainment.ok, true);
});

test("the inlined core script runs in a bare VM and judges questions", () => {
  const html = fs.readFileSync(tmpOut, "utf8");
  const bankJson = extractScript(html, "bank-data");
  const coreJs = extractScript(html, "cqp-core");
  const appJs = extractScript(html, "cqp-app");
  assert.ok(appJs.indexOf("密码赛刷题平台") >= 0);

  const bank = JSON.parse(bankJson);
  assert.equal(bank.questions.length, 38);

  const document = {
    getElementById(id) { return id === "bank-data" ? { textContent: bankJson } : null; },
  };
  const context = vm.createContext({ document, console: { error() {}, log() {} } });
  vm.runInContext(coreJs, context, { filename: "artifact-core.js" });
  const CQP = context.CQP;
  assert.ok(CQP, "CQP must be registered on the global object");
  // t37：不断言具体的应用版本号（避免升版时改测试），只校验形状 + 与源码常量一致。
  assert.match(CQP.VERSION, /^\d+\.\d+\.\d+$/, "CQP.VERSION must be a semver-shaped string");
  assert.equal(CQP.VERSION, cn_VERSION, "artifact core must inline the source cn_VERSION");
  const validation = CQP.validateBank(CQP.__test.bank);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors.slice(0, 5)));
  assert.equal(CQP.__test.bank.questions.length, 38);
  assert.equal(CQP.judge({ sectionType: "blank", answer: ["SM4"] }, ["ＳＭ４"]).correct, true);
  const drawn = CQP.drawQuestions({ bank: CQP.__test.bank, count: 5, rng: CQP.makeRng(3) });
  assert.equal(drawn.length, 5);
  const answerable = CQP.candidates({ bank: CQP.__test.bank }).length;
  assert.equal(answerable, 37, "one fixture question has no answer and is excluded from the pool");
  const paper = CQP.buildMockPaper({ bank: CQP.__test.bank, rng: CQP.makeRng(3) });
  assert.equal(paper.questionIds.length, answerable);
  const store = CQP.emptyStore();
  const exported = CQP.exportPayload({ store, scope: "all", nickname: "小明" });
  assert.equal(exported.kind, "cqp-export");
  assert.equal(CQP.validateImport(exported).ok, true);
});

test("build is repeatable and byte-identical", () => {
  const first = build({ bankPath: fixturePath, outPath: tmpOut, reportPath: null });
  const firstText = fs.readFileSync(tmpOut, "utf8");
  const second = build({ bankPath: fixturePath, outPath: tmpOut, reportPath: null });
  const secondText = fs.readFileSync(tmpOut, "utf8");
  assert.equal(first.bytes, second.bytes);
  assert.equal(firstText === secondText, true, "identical build output");
});

test("real bank build inlines the full question set", (t) => {
  if (!fs.existsSync(realPath)) {
    t.skip("src/data/bank.json not available");
    return;
  }
  const result = build({ bankPath: realPath, outPath: tmpOut, reportPath: tmpReport, strict: true });
  assert.equal(result.ok, true, JSON.stringify(result.validateBank.errors.slice(0, 5)));
  assert.equal(result.fixture, false);
  assert.equal(result.questions, 1051);
  assert.equal(result.validateBank.ok, true);
  assert.deepEqual(result.counts.bySectionType, { single: 491, multiple: 358, judge: 172, blank: 30 });
  assert.deepEqual(result.distribution, { blank: 3, multiple: 34, single: 47, judge: 16 });
  const html = fs.readFileSync(tmpOut, "utf8");
  assert.equal(/https?:\/\//.test(html), false);
  assert.equal(selfContainmentCheck(html).ok, true);
  const bank = JSON.parse(extractScript(html, "bank-data"));
  assert.equal(bank.questions.length, 1051);
  fs.rmSync(tmpOut, { force: true });
  fs.rmSync(tmpReport, { force: true });
});
