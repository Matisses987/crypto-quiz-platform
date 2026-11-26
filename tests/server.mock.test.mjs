// 服务端模拟考（mock_exams 表 + server/mock.js）。
//
// 离线单文件时代，模拟考的计时与判分都在浏览器里：到点自动交卷靠 setInterval，
// 关掉页面就能绕过时限。服务端版把「开始时刻 / 计划时长 / 交卷判定」都放在库里，
// 交卷时按 started_at + plan_sec + 30s 宽限决定 autoSubmitted，改本地时钟没用。
//
// 这里直接跑 server/ 的真实函数（:memory: 库），不起 HTTP 服务。
// Console output is English ASCII (repo convention); Chinese stays in comments.
import test from "node:test";
import assert from "node:assert/strict";
import { CQP } from "../src/core/index.mjs";
import { one, all, run } from "../server/db.js";
import { startMock, currentMock, saveResponses, submitMock, abandonMock, listMocks } from "../server/mock.js";
import { ensureServerSandbox, bankWithAnswers } from "./helpers/serverapp.mjs";

ensureServerSandbox();
const bank = bankWithAnswers();
const SLUG = "builtin";

let seq = 0;
function makeUser(nickname) {
  seq += 1;
  const username = "mockuser" + String(seq).padStart(3, "0");
  const res = run(
    "INSERT INTO users (username, pass_hash, display_name, role, disabled, created_at) VALUES (?, ?, ?, 'user', 0, ?)",
    username,
    "test-only-hash",
    nickname,
    "2026-10-05T09:00:00+08:00"
  );
  return { id: res.lastId, username, displayName: nickname, role: "user" };
}

/**
 * 把某场考试的 started_at 挪到「N 秒之前」。
 * 必须相对**当前时刻**：交卷判定算的是 now - started_at，挪到固定的历史日期会让
 * 每场考试都变成超时，宽限窗口那一侧的断言就没法测。
 */
function backdate(examId, seconds) {
  const target = Date.now() - seconds * 1000;
  // 库里存的是带 +08:00 偏移的本地时间串（style: 2026-10-05T10:00:00+08:00）
  const local = new Date(target + 8 * 3600 * 1000).toISOString().slice(0, 19) + "+08:00";
  run("UPDATE mock_exams SET started_at = ? WHERE id = ?", local, examId);
  return local;
}

/** 把某场考试的 started_at 挪到「刚好超时」 */
function expire(examId, planSec) {
  return backdate(examId, planSec + 60);
}

/* ------------------------------------------------------------------ 出卷 */

test("server mock: a new paper never exceeds the question pool and has no duplicates", () => {
  const user = makeUser("小明");
  const out = startMock(user.id, SLUG);
  assert.equal(out.resumed, false);
  const exam = out.exam;
  assert.equal(exam.status, "running");
  assert.equal(exam.bankSlug, SLUG);
  assert.equal(exam.responses && typeof exam.responses, "object");
  assert.deepEqual(exam.responses, {});
  assert.equal(exam.submittedAt, null);

  const pool = CQP.candidates({ bank }).length;
  assert.equal(exam.questionIds.length, Math.min(CQP.MOCK_LIMITS.count, pool), "paper size = min(100, pool)");
  assert.equal(exam.total, exam.questionIds.length);
  assert.equal(new Set(exam.questionIds).size, exam.questionIds.length, "no duplicated question ids");
  assert.equal(exam.planSec, CQP.MOCK_LIMITS.timeLimitSec);
  assert.match(exam.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/, "startedAt keeps the local offset");
  assert.ok(out.distribution && out.distribution.byType, "a fresh paper reports its distribution");
  const distTotal = Object.values(out.distribution.byType).reduce((a, b) => a + b, 0);
  assert.equal(distTotal, exam.questionIds.length, "distribution byType must add up to the paper size");

  // 每道题都能在题库里找到
  const index = CQP.questionIndex(bank);
  exam.questionIds.forEach((qid) => assert.ok(index.has(qid), "unknown qid in paper: " + qid));
});

test("server mock: starting again reuses the running exam instead of burning a new paper", () => {
  const user = makeUser("小明");
  const first = startMock(user.id, SLUG);
  const second = startMock(user.id, SLUG);

  assert.equal(second.resumed, true, "the running exam is resumed");
  assert.equal(second.exam.id, first.exam.id);
  assert.deepEqual(second.exam.questionIds, first.exam.questionIds);
  assert.equal(second.exam.startedAt, first.exam.startedAt, "the original start time is kept");
  assert.equal(second.distribution, undefined, "a resumed exam does not re-roll a distribution");

  const rows = all("SELECT id FROM mock_exams WHERE user_id = ? AND bank_slug = ?", user.id, SLUG);
  assert.equal(rows.length, 1, "only one running row is created");

  assert.equal(currentMock(user.id, SLUG).exam.id, first.exam.id);
});

test("server mock: current is null before any exam and after abandoning", () => {
  const user = makeUser("小明");
  assert.equal(currentMock(user.id, SLUG).exam, null, "no exam yet");

  const { exam } = startMock(user.id, SLUG);
  assert.equal(currentMock(user.id, SLUG).exam.id, exam.id);

  const out = abandonMock(user.id, exam.id);
  assert.equal(out.ok, true);
  assert.equal(currentMock(user.id, SLUG).exam, null, "an abandoned exam is no longer current");
  const row = one("SELECT status, submitted_at FROM mock_exams WHERE id = ?", exam.id);
  assert.equal(row.status, "abandoned");
  assert.match(row.submitted_at, /^\d{4}-\d{2}-\d{2}T/, "abandoning stamps submitted_at");

  // 作废之后可以重新开一场
  const again = startMock(user.id, SLUG);
  assert.equal(again.resumed, false);
  assert.notEqual(again.exam.id, exam.id);
});

test("server mock: responses saved mid-exam survive and are used at submit time", () => {
  const user = makeUser("小明");
  const { exam } = startMock(user.id, SLUG);
  const firstQid = exam.questionIds[0];
  const question = CQP.questionById(bank, firstQid);

  const responses = { [firstQid]: { myAnswer: question.answer.slice(), confidence: "confident", elapsedMs: 4200 } };
  assert.equal(saveResponses(user.id, exam.id, responses).ok, true);

  const stored = currentMock(user.id, SLUG).exam.responses;
  assert.deepEqual(stored[firstQid].myAnswer, question.answer.slice());
  assert.equal(stored[firstQid].elapsedMs, 4200);

  // 交卷时不传 responses，服务端用库里已保存的那份
  const out = submitMock(user.id, exam.id, { nickname: "小明" });
  assert.equal(out.session.responses[firstQid].correct, true);
  assert.equal(out.session.result.correctCount, 1);
  assert.equal(out.session.nickname, "小明");
});

/* ------------------------------------------------------------------ 交卷 */

test("server mock: submitting grades the paper, stores the score and hands back the answers", () => {
  const user = makeUser("小明");
  const { exam } = startMock(user.id, SLUG);
  const index = CQP.questionIndex(bank);

  // 前三题答对、第四题答错，其余不作答
  const responses = {};
  exam.questionIds.slice(0, 3).forEach((qid, i) => {
    responses[qid] = { myAnswer: index.get(qid).answer.slice(), confidence: "confident", elapsedMs: 1000 + i };
  });
  const wrongQid = exam.questionIds[3];
  const wrongQuestion = index.get(wrongQid);
  const wrongAnswer = wrongQuestion.responseMode === "blank" ? ["错的"] : ["ZZZ"];
  responses[wrongQid] = { myAnswer: wrongAnswer, confidence: "guessed", elapsedMs: 500 };

  const out = submitMock(user.id, exam.id, { responses, nickname: "小明" });
  const session = out.session;

  assert.equal(out.autoSubmitted, false, "a quick submit is not auto-submitted");
  assert.equal(session.sessionId, exam.id);
  assert.equal(session.questionIds.length, exam.questionIds.length);
  assert.equal(session.nickname, "小明");
  assert.equal(session.result.maxScore, CQP.MOCK_LIMITS.totalScore);
  assert.equal(session.result.correctCount, 3);
  assert.equal(session.result.score, 3, "score = correct count (1 point per question)");
  assert.equal(session.result.unansweredCount, exam.questionIds.length - 4);
  assert.deepEqual(Object.keys(session.result.byType).sort(), ["blank", "judge", "multiple", "single"]);
  assert.equal(session.result.rankKey.length, 6);
  assert.equal(session.result.rankKey[0], session.result.score);

  // 交卷之后才给标准答案：每题一条 {answer, answerText, explanation, responseMode}
  assert.equal(Object.keys(out.answers).length, exam.questionIds.length);
  const sample = out.answers[exam.questionIds[0]];
  assert.ok(Array.isArray(sample.answer) && sample.answer.length > 0);
  assert.equal(typeof sample.answerText, "string");
  assert.equal(typeof sample.explanation, "string");
  assert.match(sample.responseMode, /^(single|multiple|judge|blank)$/);

  const row = one("SELECT status, score, correct_cnt, total, submitted_at FROM mock_exams WHERE id = ?", exam.id);
  assert.equal(row.status, "submitted");
  assert.equal(row.score, 3);
  assert.equal(row.correct_cnt, 3);
  assert.equal(row.total, exam.questionIds.length);
  assert.ok(row.submitted_at);

  assert.equal(currentMock(user.id, SLUG).exam, null, "a submitted exam is not current any more");
});

test("server mock: a second submit on the same exam is rejected", () => {
  const user = makeUser("小明");
  const { exam } = startMock(user.id, SLUG);
  submitMock(user.id, exam.id, { responses: {}, nickname: "小明" });

  assert.throws(() => submitMock(user.id, exam.id, { responses: {} }), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /已经结束/);
    return true;
  });
  // 分数不被第二次调用改写
  const row = one("SELECT score, correct_cnt FROM mock_exams WHERE id = ?", exam.id);
  assert.equal(row.score, 0);
  assert.equal(row.correct_cnt, 0);
});

test("server mock: submitting someone else's exam is not found", () => {
  const owner = makeUser("小明");
  const intruder = makeUser("小红");
  const { exam } = startMock(owner.id, SLUG);

  assert.throws(() => submitMock(intruder.id, exam.id, { responses: {} }), (err) => {
    assert.equal(err.status, 404);
    assert.match(err.message, /不存在/);
    return true;
  });
  assert.throws(() => abandonMock(intruder.id, exam.id), /不存在/);
  assert.throws(() => saveResponses(intruder.id, exam.id, {}), /不存在/);
  // 主人的场次仍然是 running
  assert.equal(one("SELECT status FROM mock_exams WHERE id = ?", exam.id).status, "running");
});

/* -------------------------------------------------------------- 服务端计时 */

test("server mock: an exam left running past planSec + grace is marked autoSubmitted", () => {
  const user = makeUser("小明");
  const { exam } = startMock(user.id, SLUG);
  // 前端根本没上报 autoSubmitted（例如页面被直接关掉），只能靠服务端时间判定
  expire(exam.id, exam.planSec);

  const out = submitMock(user.id, exam.id, { responses: {}, nickname: "小明" });
  assert.equal(out.autoSubmitted, true, "service-side elapsed time decides auto-submit");
  assert.equal(out.session.autoSubmitted, true, "and it is recorded in the session");
  const row = one("SELECT status, score FROM mock_exams WHERE id = ?", exam.id);
  assert.equal(row.status, "submitted");
  assert.equal(row.score, 0, "an empty late paper still gets graded");

  // 页面渲染依赖这条文案
  assert.ok(CQP.VERSION.length > 0);
});

test("server mock: within the grace window a submit is not treated as late", () => {
  const user = makeUser("小明");
  const { exam } = startMock(user.id, SLUG);
  // 计划 3600s，宽限 30s：时刻落在 planSec 之后但宽限之内，仍算正常交卷
  backdate(exam.id, exam.planSec - 5);
  const out = submitMock(user.id, exam.id, { responses: {}, nickname: "小明" });
  assert.equal(out.autoSubmitted, false, "just under the limit");
});

test("server mock: the client cannot opt out of auto-submit by lying about the clock", () => {
  const user = makeUser("小明");
  const { exam } = startMock(user.id, SLUG);
  expire(exam.id, exam.planSec);
  // 前端谎报 autoSubmitted:false —— 服务端仍按 elapsedMs 判定
  const out = submitMock(user.id, exam.id, { responses: {}, autoSubmitted: false, nickname: "小明" });
  assert.equal(out.autoSubmitted, true, "server-side elapsed time wins over the client flag");
});

test("server mock: a late exam keeps whatever was answered before the limit", () => {
  const user = makeUser("小明");
  const { exam } = startMock(user.id, SLUG);
  const index = CQP.questionIndex(bank);
  const answeredQid = exam.questionIds[0];
  const responses = { [answeredQid]: { myAnswer: index.get(answeredQid).answer.slice(), confidence: "confident", elapsedMs: 3000 } };
  saveResponses(user.id, exam.id, responses);
  expire(exam.id, exam.planSec);

  const out = submitMock(user.id, exam.id, { nickname: "小明" });
  assert.equal(out.autoSubmitted, true);
  assert.equal(out.session.result.correctCount, 1, "answers saved before the limit still count");
  assert.equal(out.session.responses[answeredQid].correct, true);
});

/* ------------------------------------------------------------------ 其它 */

test("server mock: saveResponses is rejected once the exam is finished", () => {
  const user = makeUser("小明");
  const { exam } = startMock(user.id, SLUG);
  submitMock(user.id, exam.id, { responses: {}, nickname: "小明" });
  assert.throws(() => saveResponses(user.id, exam.id, {}), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
});

test("server mock: listMocks returns the user's own exams newest first", () => {
  const user = makeUser("小明");
  const other = makeUser("小红");

  const first = startMock(user.id, SLUG);
  submitMock(user.id, first.exam.id, { responses: {}, nickname: "小明" });
  const second = startMock(user.id, SLUG);
  startMock(other.id, SLUG);

  const list = listMocks(user.id, SLUG, 10);
  assert.equal(list.items.length, 2, "only this user's exams");
  assert.deepEqual(
    list.items.map((e) => e.id).sort(),
    [first.exam.id, second.exam.id].sort()
  );
  assert.equal(listMocks(user.id, SLUG, 1).items.length, 1, "limit is honoured");
  assert.equal(listMocks(other.id, SLUG, 10).items.length, 1);
});

test("server mock: unknown bank slug is not found, and unknown exam id is not found", () => {
  const user = makeUser("小明");
  assert.throws(() => startMock(user.id, "no-such-bank"), (err) => {
    assert.equal(err.status, 404);
    return true;
  });
  assert.throws(() => submitMock(user.id, "mock-nope-000000", {}), (err) => {
    assert.equal(err.status, 404);
    return true;
  });
  assert.throws(() => abandonMock(user.id, "mock-nope-000000"), (err) => {
    assert.equal(err.status, 404);
    return true;
  });
});
