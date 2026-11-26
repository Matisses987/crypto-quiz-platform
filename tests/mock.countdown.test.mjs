// 模拟考倒计时（服务端版）。
//
// 服务端版把「计时权威」搬到了服务器：
//   * 前端 state.mock.startedAt = Date.parse(exam.startedAt)，remaining 由「现在 - startedAt」派生；
//   * 到点自动交卷 = 前端 mockTick 在 left<=0 时调 submitMock(true) → POST /api/mock/:id/submit {autoSubmitted:true}；
//   * 真正判定「超时」的是 server/mock.js：elapsed > planSec + 30s 就是 autoSubmitted（客户端说了不算）。
//
// 所以这里分两层验证：
//   1. 前端：remaining 必须由 M.startedAt + M.limitSec 派生（改时钟只改 now，不碰 remaining 本身）；
//      跨导航不得冻结；到点必须带 autoSubmitted:true 打到服务端。
//   2. 服务端：超时判定见 tests/server.mock.test.mjs（直接调 server/mock.js）。
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createServerApp, fakeActionElement } from "./helpers/serverapp.mjs";

const MOCK_LIMIT = 3600;

/** 点导航栏（走真实 #nav 点击委托 → go(page)） */
function navClick(app, page) {
  const nav = app.dom.getElementById("nav");
  const button = {
    getAttribute(name) {
      return name === "data-nav" ? page : null;
    },
  };
  const fired = app.dom.fire(nav, "click", { target: { closest: () => button }, preventDefault() {} });
  assert.ok(fired >= 1, "导航点击应有监听器接住");
}

/** 弹窗里的按钮（confirmBox 生成的 modal-ok / modal-close） */
function modalButton(app, act) {
  const box = app.dom.getElementById("modalRoot").firstChild.firstChild;
  return box.querySelector('[data-act="' + act + '"]');
}

function clickModal(app, act) {
  const node = modalButton(app, act);
  const fired = app.dom.fire(node, "click", { target: node, preventDefault() {} });
  assert.ok(fired >= 1, "弹窗按钮 " + act + " 应有点击监听");
}

/** 受控时钟：只替换 vm 上下文里的 Date.now，真实 Date.parse 不动 */
function installFakeNow(context) {
  const ctxDate = vm.runInContext("Date", context);
  const realNow = ctxDate.now;
  let fake = null;
  ctxDate.now = () => (fake === null ? realNow() : fake);
  return {
    set(ms) {
      fake = ms;
    },
    restore() {
      ctxDate.now = realNow;
      fake = null;
    },
  };
}

async function startMock(app) {
  app.CQPUI.go("mock");
  app.CQPUI.__test.action("mock-start", fakeActionElement({ "data-act": "mock-start" }));
  await app.settle();
  const mock = app.CQPUI.__test.mockState();
  assert.equal(mock.phase, "running", "出卷后应进入 running");
  return mock;
}

/** 手动驱动一次 500ms 轮询 */
function tick(app) {
  const fns = app.clock.intervalFns();
  assert.ok(fns.length >= 1, "running 阶段必须有计时器在跑");
  for (const fn of fns) fn();
}

test("mock countdown: remaining is derived from an immutable limitSec baseline, not decremented", async () => {
  const app = await createServerApp({ nickname: "小明" });
  const clockCtl = installFakeNow(app.context);
  const mock = await startMock(app);

  assert.equal(mock.limitSec, MOCK_LIMIT);
  assert.equal(mock.limitSec, app.CQP.MOCK_LIMITS.timeLimitSec);
  assert.equal(mock.remaining, MOCK_LIMIT);
  assert.equal(app.state.page, "mock");

  // 前端确实用 startedAt + limitSec 派生（而不是把 remaining 自己减来减去）
  assert.equal(mock.startedAt, Date.parse(mock.paper.startedAt), "startedAt 来自服务端下发的 exam.startedAt");
  assert.ok(Number.isFinite(mock.startedAt) && mock.startedAt > 0);

  const timer = app.dom.getElementById("mockTimer");
  assert.equal(timer.textContent, "60:00", "开局应显示 60:00");
  assert.equal(timer.className, "timer", "剩余时间充足时不该有 danger");

  const intervalJobs = app.clock.intervalJobs();
  assert.equal(intervalJobs.length, 1, "只有一个倒计时轮询");
  assert.equal(intervalJobs[0].ms, 500, "轮询间隔 500ms（每秒两次，显示按秒向下取整）");

  for (const seconds of [1, 10, 60, 300, 3599]) {
    clockCtl.set(mock.startedAt + seconds * 1000);
    tick(app);
    assert.equal(mock.remaining, MOCK_LIMIT - seconds, seconds + " 秒后剩余应等于 limitSec - elapsed");
    assert.equal(mock.phase, "running");
  }

  // 派生语义的铁证：把时钟往回拨，remaining 应该变大（递减实现做不到这点）
  clockCtl.set(mock.startedAt + 50 * 1000);
  tick(app);
  assert.equal(mock.remaining, MOCK_LIMIT - 50, "回拨时钟后剩余时间应重新派生");

  // 5 分钟以内切 danger 样式
  clockCtl.set(mock.startedAt + (MOCK_LIMIT - 300) * 1000);
  tick(app);
  assert.equal(mock.remaining, 300);
  assert.equal(app.dom.getElementById("mockTimer").textContent, "05:00");
  assert.match(app.dom.getElementById("mockTimer").className, /danger/);

  clockCtl.restore();
});

test("mock countdown: reaching the limit submits with autoSubmitted:true and shows the late notice", async () => {
  const app = await createServerApp({ nickname: "小明" });
  const clockCtl = installFakeNow(app.context);
  const mock = await startMock(app);
  const examId = mock.paper.sessionId;

  clockCtl.set(mock.startedAt + (MOCK_LIMIT - 1) * 1000);
  tick(app);
  assert.equal(mock.phase, "running", "最后一秒还没到点");
  assert.equal(mock.remaining, 1);

  clockCtl.set(mock.startedAt + MOCK_LIMIT * 1000);
  tick(app);
  await app.settle();

  assert.equal(mock.phase, "result", "到点应自动交卷进入成绩页");
  assert.equal(mock.remaining, 0);
  assert.ok(mock.session, "成绩页应有服务端返回的场次");
  assert.equal(mock.session.autoSubmitted, true);

  const submit = app.lastCall(/^POST \/api\/mock\/[^/]+\/submit$/);
  assert.ok(submit, "必须打到 POST /api/mock/:id/submit");
  assert.equal(submit.url, "/api/mock/" + encodeURIComponent(examId) + "/submit");
  assert.equal(submit.body.autoSubmitted, true, "自动交卷必须带 autoSubmitted:true");
  assert.equal(submit.body.nickname, "小明");

  // 服务端也认了这次交卷
  const row = app.serverExam(examId);
  assert.equal(row.status, "submitted");
  assert.ok(row.submitted_at, "服务端应写入 submitted_at");

  assert.match(app.main(), /到点自动交卷/, "成绩页应提示到点自动交卷");
  assert.equal(app.clock.intervalFns().length, 0, "交卷后必须停表");

  // 停表后再点也不会有第二个请求
  const submits = app.callsMatching(/^POST \/api\/mock\/[^/]+\/submit$/);
  assert.equal(submits.length, 1, "一场只能交一次");

  clockCtl.restore();
});

test("mock countdown: navigating away asks first and navigation to the exam page never freezes it (t31 F-02)", async () => {
  const app = await createServerApp({ nickname: "小明" });
  const clockCtl = installFakeNow(app.context);
  const mock = await startMock(app);
  const examId = mock.paper.sessionId;
  const startedAt = mock.startedAt;

  clockCtl.set(startedAt + 2 * 1000);
  tick(app);
  assert.equal(mock.remaining, MOCK_LIMIT - 2);

  // 点当前页（模拟选拔赛）不得冻结计时
  navClick(app, "mock");
  assert.equal(app.state.page, "mock");
  assert.equal(app.clock.intervalFns().length, 1, "回到考场页面后计时器仍在");
  clockCtl.set(startedAt + 3 * 1000);
  tick(app);
  assert.equal(mock.remaining, MOCK_LIMIT - 3);
  assert.equal(mock.startedAt, startedAt, "导航不得重置 startedAt");

  // 离开要二次确认：取消 → 留在考场，计时继续
  navClick(app, "stats");
  assert.equal(app.state.page, "mock", "未确认前不得离开考场");
  assert.match(app.dom.getElementById("modalRoot").innerHTML, /正在模拟赛中/);
  clickModal(app, "modal-close");
  assert.equal(app.dom.getElementById("modalRoot").innerHTML, "", "取消后应关闭弹窗");
  assert.equal(app.state.page, "mock");
  assert.equal(mock.phase, "running");
  assert.equal(app.clock.intervalFns().length, 1, "取消离开不得停表");
  clockCtl.set(startedAt + 30 * 1000);
  tick(app);
  assert.equal(mock.remaining, MOCK_LIMIT - 30, "取消离开后倒计时照旧推进");

  // 确认离开 → 作废 + 停表 + 服务端也标 abandoned
  navClick(app, "stats");
  clickModal(app, "modal-ok");
  await app.settle();

  assert.equal(app.state.page, "stats", "确认后应离开考场");
  assert.notEqual(mock.phase, "running", "离开后不应还处于 running");
  assert.equal(app.clock.intervalFns().length, 0, "离开后必须停表");
  const abandon = app.lastCall(/^POST \/api\/mock\/[^/]+\/abandon$/);
  assert.ok(abandon, "作废必须打到 POST /api/mock/:id/abandon");
  assert.equal(abandon.url, "/api/mock/" + encodeURIComponent(examId) + "/abandon");
  assert.equal(app.serverExam(examId).status, "abandoned", "服务端场次应标为 abandoned");

  // 再开一场：全新 60:00，不复用作废场次。
  // 新场次由服务端用真实时间签发 startedAt，所以先把受控时钟放回真实时间，
  // 否则「假 now 仍停在上一场 +30s」会让新场次一开局就少 30 秒。
  clockCtl.set(null);
  app.CQPUI.go("mock", true);
  app.CQPUI.__test.action("mock-start", fakeActionElement({ "data-act": "mock-start" }));
  await app.settle();
  const again = app.CQPUI.__test.mockState();
  assert.equal(again.phase, "running");
  assert.notEqual(again.paper.sessionId, examId, "作废后应开新场次");
  assert.equal(again.remaining, MOCK_LIMIT, "新场次从满时长开始");
  assert.equal(again.limitSec, MOCK_LIMIT);
  assert.equal(again.session, null);
  assert.equal(app.clock.intervalFns().length, 1, "新场次重新起表");

  clockCtl.restore();
});

test("mock countdown: roundtrips through other pages keep counting and still submit at the limit", async () => {
  const app = await createServerApp({ nickname: "小明" });
  const clockCtl = installFakeNow(app.context);
  const mock = await startMock(app);
  const examId = mock.paper.sessionId;
  const startedAt = mock.startedAt;

  clockCtl.set(startedAt + 5 * 1000);
  tick(app);
  const before = mock.remaining;
  assert.equal(before, MOCK_LIMIT - 5);

  // 多次点导航（都指向当前页）→ 计时不抖
  for (const round of [1, 2, 3]) {
    navClick(app, "mock");
    assert.equal(app.state.page, "mock");
    assert.equal(app.clock.intervalFns().length, 1, "第 " + round + " 轮后计时器仍在");
  }
  clockCtl.set(startedAt + 9 * 1000);
  tick(app);
  assert.equal(mock.remaining, MOCK_LIMIT - 9);
  assert.ok(mock.remaining < before, "往返后剩余时间继续减少");

  // 离开确认→取消，再来一轮，然后到点
  navClick(app, "team");
  clickModal(app, "modal-close");
  assert.equal(mock.phase, "running");
  assert.equal(app.clock.intervalFns().length, 1);

  clockCtl.set(startedAt + MOCK_LIMIT * 1000);
  tick(app);
  await app.settle();

  assert.equal(mock.phase, "result");
  assert.equal(mock.session.autoSubmitted, true, "往返后到点仍要自动交卷");
  assert.equal(mock.remaining, 0);
  assert.equal(app.serverExam(examId).status, "submitted");
  assert.match(app.main(), /到点自动交卷/);

  const abandonCalls = app.callsMatching(/^POST \/api\/mock\/[^/]+\/abandon$/);
  assert.equal(abandonCalls.length, 0, "取消离开后不应产生作废请求");
  const submits = app.callsMatching(/^POST \/api\/mock\/[^/]+\/submit$/);
  assert.equal(submits.length, 1);

  clockCtl.restore();
});
