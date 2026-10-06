// t53 F-04: the teammate-file importer must work through a REAL DOM change event.
// v1.1.0 shipped `<input type="file" id="importFile">` **without** `data-act`, so the
// delegated change listener on #main (`event.target.closest("[data-act]")`) never routed it
// and `handleImportFile` was unreachable: 「导入队友记录」was silently dead for everyone.
// This suite drives the real event path (no direct function calls) and adds a dead-control guard.
// Console output of this suite is English ASCII (repo convention); Chinese stays in comments.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "../tools/build.mjs";
import { createDom } from "./helpers/domshim.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const realBankPath = path.join(root, "src", "data", "bank.json");
const fixturePath = path.join(here, "fixtures", "bank.sample.json");
const appJsPath = path.join(root, "src", "ui", "app.js");
const artifactPath = path.join(os.tmpdir(), "__cqp_import_test.html");

function extractScript(html, id) {
  const start = html.indexOf('<script id="' + id + '"');
  assert.ok(start > 0, "missing script " + id);
  const openEnd = html.indexOf(">", start);
  const close = html.indexOf("</script>", openEnd);
  return html.slice(openEnd + 1, close);
}

// 启动成品，并给 DOM shim 装一个「真能读文本」的 FileReader
//（shim 自带的 FileReader 只会触发 onerror；真实浏览器里由 FileReader 读 File 内容）
function bootApp() {
  const bankPath = fs.existsSync(realBankPath) ? realBankPath : fixturePath;
  const result = build({ bankPath, outPath: artifactPath, reportPath: null });
  assert.equal(result.ok, true);
  const html = fs.readFileSync(artifactPath, "utf8");
  const dom = createDom();
  dom.getElementById("bank-data").textContent = extractScript(html, "bank-data");
  const context = vm.createContext(dom.context);
  vm.runInContext(extractScript(html, "cqp-core"), context, { filename: "core.js" });
  dom.window.CQP = context.CQP;
  context.FileReader = class FileReader {
    readAsText(file) {
      this.result = String(file && file.__text !== undefined ? file.__text : "");
      if (typeof this.onload === "function") this.onload();
    }
  };
  vm.runInContext(extractScript(html, "cqp-app"), context, { filename: "app.js" });
  return { dom, context, CQP: context.CQP, CQPUI: dom.window.CQPUI };
}

// 关键：事件目标由**渲染出来的 HTML** 反推出属性，测试因此有鉴别力——
// 若实现里缺 data-act，closest("[data-act]") 会返回 null，change 事件被委托监听器丢弃。
function importControl(dom) {
  const html = dom.getElementById("main").innerHTML;
  const tag = html.match(/<input[^>]*id="importFile"[^>]*>/);
  assert.ok(tag, "#importFile must be rendered on the io page");
  const actMatch = tag[0].match(/data-act="([^"]+)"/);
  const attributes = { id: "importFile", type: "file", accept: ".json,application/json" };
  if (actMatch) attributes["data-act"] = actMatch[1];
  const node = {
    tagName: "INPUT",
    type: "file",
    value: "",
    files: [],
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null; },
    closest(selector) { return selector === "[data-act]" && attributes["data-act"] ? node : null; },
  };
  return { node, tagHtml: tag[0], hasDataAct: !!actMatch };
}

function button(act) {
  const node = {
    tagName: "BUTTON",
    getAttribute(name) { return name === "data-act" ? act : null; },
    closest(selector) { return selector === "[data-act]" ? node : null; },
  };
  return node;
}

// 队友导出文件：小红 2 条记录（一错一对）
function teammateFile(CQP) {
  const bank = CQP.__test.bank;
  const q1 = bank.questions[0];
  const q2 = bank.questions[1];
  const teammate = CQP.emptyStore();
  teammate.meta.nickname = "小红";
  teammate.meta.deviceId = "d-33334444";
  teammate.records = [
    CQP.makeRecord({
      question: q1,
      myAnswer: q1.options && q1.options.length ? [q1.options[0].key] : ["错误答案"],
      confidence: "confident",
      elapsedMs: 2000,
      mode: "practice_random",
      nickname: "小红",
      bankVersion: bank.bankVersion,
      appVersion: CQP.VERSION,
      nowISO: "2026-10-05T10:00:00+08:00",
    }),
    CQP.makeRecord({
      question: q2,
      myAnswer: q2.answer.slice(),
      confidence: "confident",
      elapsedMs: 2000,
      mode: "practice_random",
      nickname: "小红",
      bankVersion: bank.bankVersion,
      appVersion: CQP.VERSION,
      nowISO: "2026-10-05T10:05:00+08:00",
    }),
  ];
  return CQP.exportPayload({
    store: teammate,
    scope: "all",
    nickname: "小红",
    bankVersion: bank.bankVersion,
    nowISO: "2026-10-05T11:00:00+08:00",
  });
}

function withLocalRecord(CQP, CQPUI) {
  const bank = CQP.__test.bank;
  CQPUI.state.store.meta.nickname = "小明";
  CQP.touchMeta(CQPUI.state.store, { nickname: "小明" }, CQP.isoNow());
  CQPUI.state.store.records.push(
    CQP.makeRecord({
      question: bank.questions[0],
      myAnswer: ["本地作答"],
      confidence: "guessed",
      elapsedMs: 1000,
      mode: "practice_random",
      nickname: "小明",
      bankVersion: bank.bankVersion,
      appVersion: CQP.VERSION,
      nowISO: "2026-10-04T09:00:00+08:00",
    })
  );
  CQPUI.render();
}

test("t53 F-04: importing a teammate file via a real change event merges it and logs history", () => {
  const { dom, CQP, CQPUI } = bootApp();
  withLocalRecord(CQP, CQPUI);
  CQPUI.go("io");

  const control = importControl(dom);
  assert.equal(
    control.hasDataAct,
    true,
    '#importFile must carry data-act (delegated change listener routes on closest("[data-act]")): ' + control.tagHtml
  );

  const payload = teammateFile(CQP);
  const main = dom.getElementById("main");
  const before = CQPUI.state.store.records.length;
  const firedCount = dom.fire(main, "change", {
    target: Object.assign(control.node, { files: [{ name: "team.json", __text: JSON.stringify(payload) }] }),
    preventDefault() {},
  });
  assert.ok(firedCount >= 1, "a change listener must be registered on #main");

  // ① 出现「文件校验通过」面板，且显示记录条数
  const pending = CQPUI.__test.pending();
  assert.ok(pending, "pending must be set after the change event (import never reaches the handler otherwise)");
  assert.equal(pending.ok, true, JSON.stringify(pending.errors));
  assert.equal(pending.payload.counts.records, 2);
  const pendingHtml = dom.getElementById("main").innerHTML;
  assert.ok(pendingHtml.indexOf("文件校验通过") > 0, "校验结果面板必须出现");
  assert.ok(pendingHtml.indexOf("2 条作答记录") > 0, "面板必须显示记录条数");

  // ② 「确认合并」按钮存在，点击后记录入库
  assert.ok(pendingHtml.indexOf('data-act="import-confirm"') > 0, "「确认合并」按钮必须渲染出来");
  dom.fire(dom.getElementById("main"), "click", { target: button("import-confirm"), preventDefault() {} });
  assert.equal(CQPUI.state.store.records.length, before + 2, "两条队友记录必须入库");
  assert.equal(CQPUI.state.io.pending, null, "合并后 pending 清空");
  assert.equal(CQPUI.state.io.report.importedRecords, 2);

  // ③ 「导入历史」出现新行
  const historyHtml = dom.getElementById("main").innerHTML;
  assert.ok(historyHtml.indexOf("team.json") > 0, "导入历史必须出现该文件名");
  assert.equal(CQPUI.state.store.imports.length, 1);
  assert.equal(CQPUI.state.store.imports[0].fileName, "team.json");

  // ④ 重复导入同一文件 → 新增 0、重复 = 总条数
  const again = importControl(dom);
  dom.fire(dom.getElementById("main"), "change", {
    target: Object.assign(again.node, { files: [{ name: "team.json", __text: JSON.stringify(payload) }] }),
    preventDefault() {},
  });
  const secondPending = CQPUI.__test.pending();
  assert.ok(secondPending && secondPending.ok === true);
  dom.fire(dom.getElementById("main"), "click", { target: button("import-confirm"), preventDefault() {} });
  assert.equal(CQPUI.state.store.records.length, before + 2, "重复导入不得新增记录");
  assert.equal(CQPUI.state.io.report.importedRecords, 0);
  assert.equal(CQPUI.state.io.report.duplicates, 2, "两条都应记为重复");
  assert.ok(dom.getElementById("main").innerHTML.indexOf("本次导入 0 条新增记录") > 0, "重复导入提示必须出现");

  fs.rmSync(artifactPath, { force: true });
});

test("t53 F-04 guard: every control-driven case has a matching data-act (dead control detector)", () => {
  const src = fs.readFileSync(appJsPath, "utf8");

  // 控件在 HTML 里能带上的 data-act 全集（app.js 只以字面量形式书写 data-act，无动态拼接）
  const dataActs = new Set([...src.matchAll(/data-act="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
  assert.ok(dataActs.size >= 60, "expected the known control inventory, got " + dataActs.size);
  assert.ok(
    src.indexOf('<input type="file" id="importFile" data-act="importFile"') >= 0,
    "the file input must declare data-act=\"importFile\" (F-04 regression point)"
  );

  // 两个事件委托入口：click -> handleAction()，change -> #main 内联 switch；
  // 以及 render() 的页名 switch（白名单依据）。统一切到下一条顶层函数声明为止。
  const sliceToNextFunction = (from) => {
    const a = src.indexOf(from);
    assert.ok(a >= 0, "anchor not found: " + from);
    const b = src.indexOf("\n  function ", a);
    assert.ok(b > a, "cannot find the end of the region starting at: " + from);
    return src.slice(a, b);
  };
  const clickSwitch = sliceToNextFunction("function handleAction(");
  const changeSwitch = sliceToNextFunction('main.addEventListener("change"');
  const pageSwitch = sliceToNextFunction("switch (S.page)");
  const cases = new Set([...(clickSwitch + "\n" + changeSwitch).matchAll(/case "([A-Za-z0-9_-]+)":/g)].map((m) => m[1]));
  assert.ok(cases.size >= 50, "expected the known case inventory, got " + cases.size);

  // 白名单：页名类 case 由导航栏的 data-nav 单独处理（见 bindEvents 里的 #nav 点击监听），
  // 不经 data-act 委托，因此不需要 data-act；此处显式声明以免今后被误判为死控件。
  const pageNames = ["setup", "practice", "result", "wrongbook", "stats", "team", "io", "mock", "review"];
  for (const page of pageNames) {
    assert.ok(pageSwitch.indexOf('case "' + page + '"') >= 0, page + " must be a render() page case (data-nav target)");
  }
  const whitelist = new Map(pageNames.map((p) => [p, "页名：由导航栏 data-nav 处理（#nav 点击监听 → go(page)）"]));

  const missing = [...cases].filter((c) => !dataActs.has(c) && !whitelist.has(c));
  assert.deepEqual(
    missing,
    [],
    "these actions have a case but no control can ever trigger them (add data-act or whitelist with a reason): " + missing.join(", ")
  );

  fs.rmSync(artifactPath, { force: true });
});
