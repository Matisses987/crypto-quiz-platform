// 构建产物测试。
//
// 项目已从「离线单文件网页」改成「服务端版」：
//   - 默认目标 server：产物**不含**内联题库（答案随页面泄露），app.js 全部走 /api/*
//   - offline 目标仍能构建（旧版本兼容 / 备份用），但产物里的 app.js 已经是服务端版，
//     所以 verifyArtifact 的 "app script reads inlined bank" 必然不成立 ——
//     这条用例只断言「能构建出带内联题库的 html」，不假装它是合格产物。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { build, escapeJsonForHtml, selfContainmentCheck, stripEsm, verifyArtifact } from "../tools/build.mjs";
import { cn_VERSION } from "../src/core/constants.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fixturePath = path.join(here, "fixtures", "bank.sample.json");
const realPath = path.join(root, "src", "data", "bank.json");
// t46 O-01：临时产物写系统临时目录，绝不落在交付目录 dist/
const tmpOut = path.join(os.tmpdir(), "__cqp_artifact_test.html");
const tmpReport = path.join(os.tmpdir(), "__cqp_artifact_test.report.json");

function extractScript(html, id) {
  const start = html.indexOf('<script id="' + id + '"');
  assert.ok(start > 0, "missing script " + id);
  const openEnd = html.indexOf(">", start);
  const close = html.indexOf("</script>", openEnd);
  return html.slice(openEnd + 1, close);
}

test("stripEsm turns core modules into one plain script", () => {
  const source = [
    'import { a } from "./a.mjs";',
    "export const value = 1;",
    "export function run() { return a; }",
    "const local = 2;",
  ].join("\n");
  const out = stripEsm(source);
  assert.equal(out.indexOf("import"), -1);
  assert.equal(out.indexOf("export"), -1);
  assert.ok(out.indexOf("const value = 1;") >= 0);
  assert.ok(out.indexOf("function run()") >= 0);
  assert.ok(out.indexOf("const local = 2;") >= 0);
});

test("escapeJsonForHtml hides protocol text and tag openers", () => {
  const escaped = escapeJsonForHtml(
    JSON.stringify({ stem: "见 http://example.com/a 与 https://b.c", html: "<b>" })
  );
  assert.equal(escaped.indexOf("http://"), -1);
  assert.equal(escaped.indexOf("https://"), -1);
  assert.equal(escaped.indexOf("<"), -1);
  assert.deepEqual(JSON.parse(escaped), {
    stem: "见 http://example.com/a 与 https://b.c",
    html: "<b>",
  });
});

test("selfContainmentCheck detects forbidden references", () => {
  assert.equal(selfContainmentCheck("<html><body>ok</body></html>").ok, true);
  assert.equal(selfContainmentCheck('<script src="a.js"></script>').ok, false);
  assert.equal(selfContainmentCheck("<style>@import 'a.css';</style>").ok, false);
  assert.equal(selfContainmentCheck("var x = fetch('/a');").ok, false);
  assert.equal(selfContainmentCheck("new XMLHttpRequest();").ok, false);
  assert.equal(selfContainmentCheck("new WebSocket('wss://x');").ok, false);
});

test("server build ships an answer-free artifact that calls the API", () => {
  const result = build({ target: "server", bankPath: realPath, write: false, reportPath: null });
  assert.equal(result.ok, true, JSON.stringify(result.blockingErrors));
  assert.equal(result.target, "server");
  assert.equal(result.fixture, false);
  assert.equal(result.questions, 1051);
  assert.equal(result.validateBank.ok, true, JSON.stringify(result.validateBank.errors.slice(0, 5)));
  assert.equal(result.bytes > 20000, true, "产物应有可观体积");
  assert.equal(result.selfContainment.ok, true, result.selfContainment.problems.join(","));

  // write: false 时 build() 不跑 verifyArtifact（它要走写盘分支），自己跑一遍
  const html = result.html;
  assert.equal(html.indexOf("<!DOCTYPE html>"), 0, "产物以 DOCTYPE 开头");
  assert.equal(html.indexOf("https://"), -1);
  assert.equal(html.indexOf("http://"), -1);
  assert.equal(html.indexOf('<script id="bank-data"'), -1, "服务端目标不得内联题库（答案会泄露）");
  assert.ok(html.indexOf('<script id="cqp-core">') > 0);
  assert.ok(html.indexOf('<script id="cqp-app">') > 0);
  assert.equal(html.indexOf("{{APP_VERSION}}"), -1);
  assert.equal(html.indexOf("{{BANK_VERSION}}"), -1);

  const artifactCheck = verifyArtifact(html, { target: "server" });
  assert.equal(artifactCheck.ok, true, JSON.stringify(artifactCheck.checks.filter((c) => !c.ok)));
  const names = artifactCheck.checks.map((c) => c.name);
  assert.ok(names.indexOf("no inlined bank (server target)") >= 0, "服务端目标必须检查「不带内联题库」");
  assert.ok(names.indexOf("app script calls server API") >= 0, "服务端目标必须检查「app 走 /api」");
});

test("the server bundle's core script still judges in a bare VM", () => {
  const result = build({ target: "server", bankPath: realPath, write: false, reportPath: null });
  assert.equal(result.ok, true, JSON.stringify(result.blockingErrors));
  const coreJs = extractScript(result.html, "cqp-core");
  const appJs = extractScript(result.html, "cqp-app");
  assert.ok(appJs.indexOf("密码赛刷题平台") > 0, "app 脚本是成品界面脚本");
  assert.ok(appJs.indexOf('"/api/') > 0, "app 脚本调用服务端接口");

  // 服务端不下发答案，所以 CQP.setBank 由 /api/banks/:slug 的响应驱动；
  // 这里验证的是「核心脚本本身仍能判分」——用带答案的本地题库注入。
  const bank = JSON.parse(fs.readFileSync(realPath, "utf8"));
  const context = vm.createContext({
    document: { getElementById: () => null },
    console: { log() {}, error() {}, warn() {} },
  });
  vm.runInContext(coreJs, context, { filename: "server-core.js" });
  const CQP = context.CQP;
  assert.ok(CQP, "core script exposes CQP");
  assert.match(String(CQP.VERSION), /^\d+\.\d+\.\d+$/);
  assert.equal(CQP.VERSION, cn_VERSION);
  CQP.setBank(bank);
  assert.equal(CQP.validateBank(bank).ok, true);
  assert.equal(bank.questions.length, 1051);
  assert.equal(CQP.judge({ sectionType: "blank", answer: ["SM4"] }, ["ＳＭ４"]).correct, true);
  assert.equal(CQP.candidates({ bank }).length, 1051, "真题库全部题目都可作答（answerStatus 全 ok）");  assert.equal(CQP.buildMockPaper({ bank, rng: CQP.makeRng(1) }).questionIds.length, 100);
});

test("server build is repeatable and byte-identical", () => {
  const a = build({ target: "server", bankPath: realPath, write: false, reportPath: null });
  const b = build({ target: "server", bankPath: realPath, write: false, reportPath: null });
  assert.equal(a.bytes, b.bytes);
  assert.equal(a.html === b.html, true, "两次构建逐字节一致");
});

test("the offline target still builds an artifact with the inlined bank", () => {
  // 说明：offline 目标的 app.js 已是服务端版（全是 fetch），所以
  // selfContainmentCheck 会报 "fetch call"、verifyArtifact 会缺 "app script reads inlined bank"。
  // 这不是 bug 而是两者语义冲突 —— 这里只断言「构建仍然跑得通且题库被内联」，
  // 是否彻底下掉 offline 目标由主 agent 决定（见最终回复）。
  const result = build({ target: "offline", bankPath: realPath, write: false, reportPath: null });
  assert.equal(result.target, "offline");
  assert.equal(result.questions, 1051);
  assert.equal(result.bytes > 20000, true);
  const html = result.html;
  assert.equal(html.indexOf("<!DOCTYPE html>"), 0);
  assert.ok(html.indexOf('<script id="bank-data" type="application/json">') > 0, "offline 目标仍内联题库");
  const inlined = JSON.parse(extractScript(html, "bank-data"));
  assert.equal(inlined.questions.length, 1051);
  assert.ok(html.indexOf('<script id="cqp-core">') > 0);
  assert.ok(html.indexOf('<script id="cqp-app">') > 0);
  assert.equal(html.indexOf("{{APP_VERSION}}"), -1);
});

test("real bank build reports the frozen counts and distribution", () => {
  const result = build({ target: "server", bankPath: realPath, write: false, reportPath: null, strict: true });
  assert.equal(result.ok, true, JSON.stringify(result.blockingErrors));
  assert.equal(result.fixture, false);
  assert.equal(result.questions, 1051);
  assert.equal(result.validateBank.ok, true, JSON.stringify(result.validateBank.errors.slice(0, 5)));
  assert.deepEqual(result.counts.bySectionType, { single: 491, multiple: 358, judge: 172, blank: 30 });
  assert.deepEqual(result.distribution, { blank: 3, multiple: 34, single: 47, judge: 16 });
});

test("write mode still drops the artifact and the report on disk", () => {
  const result = build({ target: "server", bankPath: realPath, outPath: tmpOut, reportPath: tmpReport });
  try {
    // 注意：写盘分支的返回值不带 html（html 只在 write:false 时回传），
    // 所以落盘内容要和一次 write:false 的构建比。
    assert.equal(result.ok, true, JSON.stringify(result.blockingErrors));
    assert.equal(fs.existsSync(tmpOut), true, "写了 outPath");
    assert.equal(fs.existsSync(tmpReport), true, "写了 reportPath");
    const html = fs.readFileSync(tmpOut, "utf8");
    const inMemory = build({ target: "server", bankPath: realPath, write: false, reportPath: null });
    assert.equal(html.indexOf('<script id="bank-data"'), -1);
    assert.equal(html.length, inMemory.html.length, "落盘内容与内存产物等长");
    const report = JSON.parse(fs.readFileSync(tmpReport, "utf8"));
    assert.equal(report.target, "server");
    assert.equal(report.questions, 1051);
    assert.equal(report.selfContainment.ok, true);
    assert.equal(report.artifactCheck.ok, true, JSON.stringify((report.artifactCheck.checks || []).filter((c) => !c.ok)));
  } finally {
    fs.rmSync(tmpOut, { force: true });
    fs.rmSync(tmpReport, { force: true });
  }
});
