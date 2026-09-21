// t28: mock exam countdown must follow real time (immutable limitSec baseline, derived remaining).
// Two angles: (1) controlled clock with a captured interval callback; (2) real setInterval smoke.
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
const fixturePath = path.join(here, "fixtures", "bank.sample.json");
const realPath = path.join(root, "src", "data", "bank.json");
// t46 O-01：临时产物写系统临时目录，绝不落在交付目录 dist/
const artifactPath = path.join(os.tmpdir(), "__cqp_countdown_test.html");

function extractScript(html, id) {
  const start = html.indexOf('<script id="' + id + '"');
  assert.ok(start > 0, "missing script " + id);
  const openEnd = html.indexOf(">", start);
  const close = html.indexOf("</script>", openEnd);
  return html.slice(openEnd + 1, close);
}

function bootApp() {
  const bankPath = fs.existsSync(realPath) ? realPath : fixturePath;
  const result = build({ bankPath, outPath: artifactPath, reportPath: null });
  assert.equal(result.ok, true);
  const html = fs.readFileSync(artifactPath, "utf8");
  const dom = createDom();
  dom.getElementById("bank-data").textContent = extractScript(html, "bank-data");
  const context = vm.createContext(dom.context);
  vm.runInContext(extractScript(html, "cqp-core"), context, { filename: "core.js" });
  dom.window.CQP = context.CQP;
  vm.runInContext(extractScript(html, "cqp-app"), context, { filename: "app.js" });
  const CQPUI = dom.window.CQPUI;
  CQPUI.state.store.meta.nickname = "小明";
  context.CQP.touchMeta(CQPUI.state.store, { nickname: "小明" }, context.CQP.isoNow());
  CQPUI.render();
  return { dom, context, CQP: context.CQP, CQPUI };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("mock countdown: derived from an immutable limitSec baseline (controlled clock)", () => {
  const { dom, context, CQP, CQPUI } = bootApp();

  // 受控时钟：Date.now 由测试推进；setInterval 只捕获回调，由测试手动触发
  const ctxDate = vm.runInContext("Date", context);
  const realDateNow = ctxDate.now;
  let fakeNow = Date.parse("2026-09-20T12:00:00+08:00"); // publication-safe constant (t49)
  let scheduled = null;
  ctxDate.now = () => fakeNow;
  dom.window.setInterval = (fn) => {
    scheduled = fn;
    return 42;
  };
  dom.window.clearInterval = () => {
    scheduled = null;
  };

  CQPUI.go("mock");
  CQPUI.__test.action("mock-start");
  const M = CQPUI.__test.mockState();
  assert.equal(M.limitSec, 3600, "限额基准来自 paper.timeLimitSec");
  assert.equal(M.remaining, 3600, "初始剩余 = 限额");
  assert.equal(CQP.MOCK_LIMITS.timeLimitSec, 3600, "限额口径来自 CQP.MOCK_LIMITS");

  const start = fakeNow;
  const tickAt = (seconds) => {
    fakeNow = start + seconds * 1000;
    scheduled();
  };

  for (const t of [0, 1, 10, 30, 60, 300, 3599]) {
    tickAt(t);
    assert.equal(M.remaining, 3600 - t, "t=" + t + "s 时剩余必须精确等于 limitSec - t（0 容差）");
    assert.equal(M.phase, "running", "t=" + t + "s 时不得自动交卷");
  }

  // 修复前的实际故障点：t=60s 就已归零并强制交卷
  tickAt(60);
  assert.equal(M.remaining, 3540);
  assert.equal(M.phase, "running", "t=60s 必须仍在答题（修复前故障点）");
  assert.equal(dom.getElementById("mockTimer").textContent, "59:00", "t=60s 显示 59:00");
  assert.equal(dom.getElementById("mockTimer").className.indexOf("danger"), -1, "t=60s 不应出现危险样式");

  // 危险样式只在剩余 ≤300s 时出现（t=3300 → 剩 300s）
  tickAt(3300);
  assert.equal(M.remaining, 300);
  assert.equal(dom.getElementById("mockTimer").textContent, "05:00");
  assert.ok(dom.getElementById("mockTimer").className.indexOf("danger") >= 0, "剩 5 分钟时出现危险样式");
  assert.equal(M.phase, "running", "剩 300s 仍不得交卷");

  // 到点（t=3600）才自动交卷
  tickAt(3600);
  assert.equal(M.remaining, 0);
  assert.equal(M.phase, "result", "恰好到限额才自动交卷");
  assert.equal(M.session.autoSubmitted, true, "autoSubmitted=true");
  assert.equal(M.session.timeLimitSec, 3600, "session.timeLimitSec 仍为 3600");
  assert.equal(CQPUI.state.store.sessions.length, 1, "只写入 1 场 session");
  assert.equal(scheduled === null, true, "自动交卷后定时器已停止（stopMockTimer）");
  assert.ok(dom.getElementById("main").innerHTML.indexOf("到点自动交卷") > 0, "结果页显示自动交卷文案");
  assert.equal(CQP.masteryOverall(CQPUI.state.store.records.filter((r) => r.mode === "mock")).attempts >= 0, true);

  // 定时器已停 → 再手动 tick 也不会重复交卷/重复写 session
  if (scheduled) scheduled();
  assert.equal(CQPUI.state.store.sessions.length, 1, "不得重复交卷或重复写 session");

  ctxDate.now = realDateNow;
  fs.rmSync(artifactPath, { force: true });
});

test("mock countdown: real setInterval ticks once per second and submits at the limit", async () => {
  const { dom, CQPUI } = bootApp();
  CQPUI.go("mock");
  CQPUI.__test.action("mock-start");
  const M = CQPUI.__test.mockState();
  assert.equal(M.remaining, 3600);

  // 真实计时冒烟：把本次上限压到 2 秒（只改测试期基准，产品默认仍是 3600）
  M.limitSec = 2;
  M.startedAt = Date.now();

  await sleep(1200);
  assert.equal(M.phase, "running", "1.2s（限额 2s）时不得交卷");
  assert.ok(M.remaining <= 1 && M.remaining >= 0, "1.2s 时剩余应为 1 或 0，实测 " + M.remaining);
  assert.equal(dom.getElementById("mockTimer").textContent, "00:0" + M.remaining);

  await sleep(2000); // 累计约 3.2s > 2s
  assert.equal(M.phase, "result", "真实计时到限额后必须自动交卷");
  assert.equal(M.session.autoSubmitted, true, "autoSubmitted=true");
  assert.equal(M.remaining, 0, "剩余归零");
  assert.equal(CQPUI.state.store.sessions.length, 1, "只写 1 场 session");
  assert.equal(M.session.timeLimitSec, 3600, "限额口径不变");
  assert.ok(M.session.result.totalElapsedMs >= 0 && M.session.result.totalElapsedMs <= 3600000, "总用时在限额内");
  assert.ok(dom.getElementById("main").innerHTML.indexOf("到点自动交卷") > 0, "结果页显示自动交卷文案");

  fs.rmSync(artifactPath, { force: true });
});

// 导航辅助：走 app 真正的事件通路（#nav 上的委托 click）；弹窗按钮走 openModal 注册的监听器
function navClick(dom, page) {
  const btn = { getAttribute: (name) => (name === "data-nav" ? page : null) };
  dom.fire(dom.getElementById("nav"), "click", { target: { closest: () => btn } });
}
function modalClick(dom, act) {
  const box = dom.getElementById("modalRoot").firstChild.firstChild;
  dom.fire(box.querySelector('[data-act="' + act + '"]'), "click");
}

test("mock countdown: navigation never freezes the timer (t31 F-02, controlled clock)", () => {
  const { dom, context, CQPUI } = bootApp();

  const ctxDate = vm.runInContext("Date", context);
  const realDateNow = ctxDate.now;
  let fakeNow = Date.parse("2026-09-20T12:00:00+08:00"); // publication-safe constant (t49)
  let scheduled = null;
  ctxDate.now = () => fakeNow;
  dom.window.setInterval = (fn) => {
    scheduled = fn;
    return 42;
  };
  dom.window.clearInterval = () => {
    scheduled = null;
  };
  const timerActive = () => CQPUI.state.mockTimer !== null && scheduled !== null;
  const tickFrom = (base, seconds) => {
    fakeNow = base + seconds * 1000;
    if (scheduled) scheduled();
  };
  let start = fakeNow;
  const tickAt = (seconds) => tickFrom(start, seconds);

  // 逐序列取证（CQP_COUNTDOWN_TRACE=1 时打印，英文 ASCII）
  const trace = [];
  const rec = (tag) => {
    trace.push(tag + " remaining=" + M.remaining + " timerActive=" + timerActive() + " phase=" + M.phase + " page=" + CQPUI.state.page);
  };

  CQPUI.go("mock");
  CQPUI.__test.action("mock-start");
  const M = CQPUI.__test.mockState();
  start = fakeNow;
  tickAt(2);
  assert.equal(M.remaining, 3598);
  assert.equal(timerActive(), true, "开局定时器活动");
  rec("00-start(+2s)");

  // ① 运行中点当前导航项「模拟选拔赛」→ 不得停表
  navClick(dom, "mock");
  assert.equal(CQPUI.state.page, "mock", "① 仍在模拟赛页");
  assert.equal(timerActive(), true, "① 点当前导航项后 timerActive === true");
  rec("01-same-nav-click");
  tickAt(3);
  assert.equal(M.remaining, 3597, "① 倒计时继续按 1 秒/秒递减");
  rec("01-after-1s");
  tickAt(10);
  assert.equal(M.remaining, 3590);
  rec("01-after-8s");

  // ② 点其它导航 → 取消离开 → 仍在考场且计时继续
  navClick(dom, "stats");
  assert.ok(dom.getElementById("modalRoot").innerHTML.indexOf("正在模拟赛中") > 0, "② 弹出离开确认");
  assert.equal(CQPUI.state.page, "mock", "② 未确认前仍在考场");
  rec("02-leave-prompt-open");
  modalClick(dom, "modal-close");
  assert.equal(CQPUI.state.page, "mock", "② 取消后仍在考场");
  assert.equal(timerActive(), true, "② 取消后定时器仍活动");
  rec("02-cancel-leave");
  tickAt(30);
  assert.equal(M.remaining, 3570, "② 取消后倒计时继续");
  assert.equal(M.startedAt, start, "② 未重设 startedAt（严禁重置）");
  assert.equal(M.limitSec, 3600, "② 限额基准未变");
  assert.equal(M.phase, "running");
  rec("02-after-20s");

  // ③ 确认离开 → 场次作废、定时器停止、不新增 session
  const sessionsBefore = CQPUI.state.store.sessions.length;
  navClick(dom, "stats");
  modalClick(dom, "modal-ok");
  assert.equal(CQPUI.state.page, "stats", "③ 确认后离开模拟赛页");
  assert.notEqual(M.phase, "running", "③ 场次退出 running");
  assert.equal(timerActive(), false, "③ 定时器停止");
  assert.equal(CQPUI.state.store.sessions.length, sessionsBefore, "③ 作废不新增 session");
  rec("03-confirm-leave");

  // ③b 重新开始 → 全新 3600s 场次、旧场次不残留
  fakeNow = fakeNow + 60000;
  CQPUI.go("mock");
  CQPUI.__test.action("mock-start");
  const M2 = CQPUI.__test.mockState();
  assert.equal(M2.remaining, 3600, "③b 新场次为全新 3600s（不是回到旧场次）");
  assert.equal(M2.limitSec, 3600);
  assert.equal(M2.session, null, "③b 旧场次不残留");
  assert.equal(timerActive(), true, "③b 新场次定时器活动");
  rec("03b-new-session");
  const start2 = fakeNow;
  tickFrom(start2, 1);
  assert.equal(M2.remaining, 3599, "③b 新场次从新起点开始计时（不继承旧场次已过时间）");
  rec("03b-after-1s");

  if (process.env.CQP_COUNTDOWN_TRACE === "1") {
    console.log("[countdown-trace] limitSec=" + M.limitSec + " oldStart=" + start + " newStart=" + start2 + " newStartDeltaSec=" + (start2 - start) / 1000 + " navSameItemKeptTimer=true");
    for (const line of trace) console.log("[countdown-trace] " + line);
  }

  ctxDate.now = realDateNow;
  fs.rmSync(artifactPath, { force: true });
});

test("mock countdown: real timer survives navigation roundtrips and submits at the limit", async () => {
  const { dom, CQPUI } = bootApp();
  CQPUI.go("mock");
  CQPUI.__test.action("mock-start");
  const M = CQPUI.__test.mockState();
  M.limitSec = 3; // 缩短限额（仅测试期），期间做一次「点当前导航项」与一次「去其它页再取消」
  M.startedAt = Date.now();
  const realTrace = [];
  const recReal = (tag) => realTrace.push(tag + " remaining=" + M.remaining + " timerActive=" + (CQPUI.state.mockTimer !== null) + " phase=" + M.phase);

  await sleep(1100);
  assert.equal(M.phase, "running", "1.1s（限额 3s）仍在答题");
  assert.ok(CQPUI.state.mockTimer !== null, "定时器活动");
  recReal("00-start(+1.1s)");

  navClick(dom, "mock"); // ① 点当前导航项
  assert.equal(CQPUI.state.page, "mock");
  assert.ok(CQPUI.state.mockTimer !== null, "① 点当前导航项后定时器仍活动（F-02 修复点）");
  recReal("01-same-nav-click");

  await sleep(400);
  const before = M.remaining;
  navClick(dom, "stats"); // ② 去其它页 → 取消
  assert.ok(dom.getElementById("modalRoot").innerHTML.indexOf("正在模拟赛中") > 0, "② 弹出离开确认");
  modalClick(dom, "modal-close");
  assert.equal(CQPUI.state.page, "mock", "② 取消后仍在考场");
  assert.ok(CQPUI.state.mockTimer !== null, "② 取消后定时器仍活动");
  assert.ok(M.remaining <= before, "② 取消后剩余时间不回升（未重置）");
  recReal("02-cancel-leave");

  await sleep(2000); // 累计约 3.5s > 3s
  assert.equal(M.phase, "result", "在原限额处自动交卷（不提前、不延后）");
  assert.equal(M.session.autoSubmitted, true, "autoSubmitted=true");
  assert.equal(M.remaining, 0, "剩余归零");
  assert.equal(CQPUI.state.store.sessions.length, 1, "只写一条 session");
  assert.ok(dom.getElementById("main").innerHTML.indexOf("到点自动交卷") > 0, "结果页显示自动交卷文案");
  recReal("03-auto-submitted");

  if (process.env.CQP_COUNTDOWN_TRACE === "1") {
    console.log("[countdown-trace-real] limitSec=3 sessions=" + CQPUI.state.store.sessions.length);
    for (const line of realTrace) console.log("[countdown-trace-real] " + line);
  }

  fs.rmSync(artifactPath, { force: true });
});
