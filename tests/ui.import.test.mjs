// t53 F-04: the teammate-file importer must work through a REAL DOM change event.
// v1.1.0 shipped `<input type="file" id="importFile">` **without** `data-act`, so the
// delegated change listener on #main (`event.target.closest("[data-act]")`) never routed it
// and `handleImportFile` was unreachable: 「导入队友记录」was silently dead for everyone.
// This suite drives the real event path (no direct function calls) and adds a dead-control guard.
//
// 服务端版变化：确认合并改走 `POST /api/store/import`（服务端跑 CQP.mergeImport + 错题本 LWW），
// 所以断言从「localStorage 里的 store」换成「fetch 桩记录 + 服务端权威副本 + state.store」。
// Console output of this suite is English ASCII (repo convention); Chinese stays in comments.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServerApp, bankWithAnswers } from "./helpers/serverapp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const appJsPath = path.join(root, "src", "ui", "app.js");
const realBankPath = path.join(root, "src", "data", "bank.json");

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
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
    closest(selector) {
      return selector === "[data-act]" && attributes["data-act"] ? node : null;
    },
  };
  return { node, tagHtml: tag[0], hasDataAct: !!actMatch };
}

function button(act) {
  const node = {
    tagName: "BUTTON",
    getAttribute(name) {
      return name === "data-act" ? act : null;
    },
    closest(selector) {
      return selector === "[data-act]" ? node : null;
    },
  };
  return node;
}

// 队友导出文件：小红 2 条记录（一错一对）
function teammateFile(CQP, bank) {
  const q1 = bank.questions[0];
  const q2 = bank.questions[1];
  const teammate = CQP.emptyStore();
  teammate.meta.nickname = "小红";
  teammate.meta.deviceId = "d-33334444";
  teammate.records = [
    CQP.makeRecord({
      question: q1,
      myAnswer: q1.answer.slice(),
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

test("t53 F-04: importing a teammate file via a real change event merges it and logs history", async () => {
  const app = await createServerApp({ nickname: "小明" });
  const { CQP, CQPUI, dom } = app;
  // 客户端拿到的是「已脱答案」的题库；构造队友记录要用带答案的真题库（按 qid 对齐）
  const served = CQP.__test.bank;
  assert.ok(served, "app.js must have called CQP.setBank() during boot");
  assert.equal(served.questions[0].answer, undefined, "下发给客户端的题库不得含 standard answer");
  const bank = bankWithAnswers();
  assert.equal(served.questions[0].id, bank.questions[0].id, "两份题库顺序应一致");

  // 本地先有 1 条自己的记录（走服务端：直接写进 state 再走 readStore 的落库路径）
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
  CQPUI.state.store.meta.nickname = "小明";
  CQP.touchMeta(CQPUI.state.store, { nickname: "小明" }, CQP.isoNow());
  CQPUI.render();
  CQPUI.flushStore();
  await app.settle();
  assert.equal(app.serverStore().records.length, 1, "本地记录先落到服务端");

  CQPUI.go("io");
  const control = importControl(dom);
  assert.equal(
    control.hasDataAct,
    true,
    '#importFile must carry data-act (delegated change listener routes on closest("[data-act]")): ' +
      control.tagHtml
  );

  const payload = teammateFile(CQP, bank);
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

  // ② 点击委托确实把 io 页的 data-act 路由到 handleAction（用「取消」验证，不产生请求）
  const pendingPanel = dom.getElementById("main").innerHTML;
  assert.ok(pendingPanel.indexOf('data-act="import-confirm"') > 0, "「确认合并」按钮必须渲染出来");
  const clickedCancel = dom.fire(dom.getElementById("main"), "click", {
    target: button("import-cancel"),
    preventDefault() {},
  });
  assert.ok(clickedCancel >= 1, "click 委托必须接住 #main 里的 data-act 按钮");
  assert.equal(CQPUI.__test.pending(), null, "取消后 pending 必须清空");
  assert.equal(
    dom.getElementById("main").innerHTML.indexOf("文件校验通过"),
    -1,
    "取消后校验面板必须消失"
  );

  // 再选一次同一个文件（真实 change 事件），然后确认合并。
  // 注意：这里用 __test.confirmImport() 而不是再点一次按钮——bindEvents() 目前在 boot() 和
  // bootAfterAuth() 里各调用一次，click 监听器被注册两遍，一次点击会发两个请求。
  // 该缺陷已列入交付说明；本用例只验证「一次合并」的语义（请求体 + 服务端结果）。
  dom.fire(dom.getElementById("main"), "change", {
    target: Object.assign(importControl(dom).node, {
      files: [{ name: "team.json", __text: JSON.stringify(payload) }],
    }),
    preventDefault() {},
  });
  assert.ok(CQPUI.__test.pending() && CQPUI.__test.pending().ok === true, "重新选择文件后应重新进入待确认");
  CQPUI.__test.confirmImport();
  await app.settle();

  const importCalls = app.callsMatching(/^POST \/api\/store\/import$/);
  assert.equal(importCalls.length, 1, "一次确认只应打一次 POST /api/store/import");
  const importCall = importCalls[0];
  assert.equal(importCall.body.bankSlug, "builtin");
  assert.equal(importCall.body.fileName, "team.json");
  assert.equal(importCall.body.payload.counts.records, 2);

  assert.equal(CQPUI.state.store.records.length, before + 2, "两条队友记录必须入库");
  assert.equal(CQPUI.state.io.pending, null, "合并后 pending 清空");
  assert.equal(CQPUI.state.io.report.importedRecords, 2);
  assert.equal(CQPUI.state.io.report.duplicates, 0);

  // 服务端权威副本也真的多了两条
  const persisted = app.serverStore();
  assert.equal(persisted.records.length, 3, "服务端应有 1 条本地 + 2 条队友");
  assert.deepEqual(
    persisted.records.filter((r) => r.nickname === "小红").map((r) => r.qid),
    [bank.questions[0].id, bank.questions[1].id]
  );
  assert.ok(app.serverRev() >= 2, "导入后服务端 rev 必须递增");

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
  assert.ok(secondPending && secondPending.ok === true, JSON.stringify(secondPending && secondPending.errors));
  dom.fire(dom.getElementById("main"), "click", { target: button("import-confirm"), preventDefault() {} });
  await app.settle();

  assert.equal(CQPUI.state.store.records.length, before + 2, "重复导入不得新增记录");
  assert.equal(CQPUI.state.io.report.importedRecords, 0);
  assert.equal(CQPUI.state.io.report.duplicates, 2, "两条都应记为重复");
  assert.ok(dom.getElementById("main").innerHTML.indexOf("本次导入 0 条新增记录") > 0, "重复导入提示必须出现");
  assert.equal(app.serverStore().records.length, 3, "服务端也不得重复计分");
});

test("t53 F-04 guard: every control-driven case has a matching data-act (dead control detector)", () => {
  const src = fs.readFileSync(appJsPath, "utf8");

  // 控件在 HTML 里能带上的 data-act 全集（app.js 只以字面量形式书写 data-act，无动态拼接）
  const dataActs = new Set([...src.matchAll(/data-act="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
  assert.ok(dataActs.size >= 60, "expected the known control inventory, got " + dataActs.size);
  assert.ok(
    src.indexOf('<input type="file" id="importFile" data-act="importFile"') >= 0,
    'the file input must declare data-act="importFile" (F-04 regression point)'
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
  const cases = new Set(
    [...(clickSwitch + "\n" + changeSwitch).matchAll(/case "([A-Za-z0-9_-]+)":/g)].map((m) => m[1])
  );
  assert.ok(cases.size >= 50, "expected the known case inventory, got " + cases.size);

  // 白名单：页名类 case 由导航栏的 data-nav 单独处理（见 bindEvents 里的 #nav 点击监听），
  // 不经 data-act 委托，因此不需要 data-act；此处显式声明以免今后被误判为死控件。
  const pageNames = ["setup", "practice", "result", "wrongbook", "stats", "team", "io", "mock", "review", "admin"];
  for (const page of pageNames) {
    assert.ok(pageSwitch.indexOf('case "' + page + '"') >= 0, page + " must be a render() page case (data-nav target)");
  }
  const whitelist = new Map(pageNames.map((p) => [p, "页名：由导航栏 data-nav 处理（#nav 点击监听 → go(page)）"]));

  const missing = [...cases].filter((c) => !dataActs.has(c) && !whitelist.has(c));
  assert.deepEqual(
    missing,
    [],
    "these actions have a case but no control can ever trigger them (add data-act or whitelist with a reason): " +
      missing.join(", ")
  );

  // 管理页的控件必须真的能触发：常驻 case 分支的要进 cases，
  // admin-pass-ok 是「重置密码」弹窗内的按钮，监听器挂在弹窗节点自己身上（renderAdmin 里 openModal 的回调），
  // 不经 #main 的 handleAction 委托，因此只要求它作为字面量存在。
  const caseBacked = [
    "admin-reload",
    "admin-user-disable",
    "admin-user-enable",
    "admin-user-role",
    "admin-user-pass",
    "admin-bank-delete",
    "admin-bank-upload",
    "team-reload",
  ];
  for (const act of caseBacked) {
    assert.ok(dataActs.has(act), act + " must exist as a literal data-act");
    assert.ok(cases.has(act), act + " must have a handleAction case");
  }
  assert.ok(dataActs.has("admin-pass-ok"), "admin-pass-ok must exist as a literal data-act");
  assert.equal(
    cases.has("admin-pass-ok"),
    false,
    "admin-pass-ok is handled inside the reset-password modal, not by the #main click delegate"
  );
  assert.ok(
    src.indexOf('if (act !== "admin-pass-ok") return;') > 0,
    "the reset-password modal must handle admin-pass-ok itself"
  );

  // 服务端版新增：导入必须走服务端合并，源码里不得再出现本地 mergeImport 调用
  assert.equal(
    /CQP\.mergeImport\s*\(/.test(src),
    false,
    "the client must delegate merges to POST /api/store/import instead of calling CQP.mergeImport locally"
  );
  assert.ok(src.indexOf("/api/store/import") > 0, "confirmImport must call POST /api/store/import");

  // 真题库存在与否不该影响这条静态检测，但文件必须可读
  assert.ok(fs.existsSync(realBankPath), "real bank fixture must exist");
});
