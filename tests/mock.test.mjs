// Mock selection exam: docs/需求规格.md 9.9 / 10.x.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CQP } from "../src/core/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// 10.2 frozen pool sizes (real bank, answerStatus=ok)
const POOL = CQP.MOCK_DIST_EXPECT.pool;
const frozenBank = CQP.__test.makeBank(POOL, { tag: "密码法" });

test("mock distribution follows the two-level largest-remainder table (10.2)", () => {
  const dist = CQP.computeMockDistribution(frozenBank.questions, 100);
  assert.equal(dist.total, 100);
  assert.deepEqual(dist.byType, CQP.MOCK_DIST_EXPECT.byType);
  assert.deepEqual(dist.byChapter, CQP.MOCK_DIST_EXPECT.byChapter);
  for (const type of CQP.MOCK_TYPE_ORDER) {
    assert.deepEqual(dist.byChapterType[type], CQP.MOCK_DIST_EXPECT.byChapterType[type], "type " + type);
  }
});

test("buildMockPaper draws 100 unique answerable questions in frozen order", () => {
  const paper = CQP.buildMockPaper({ bank: frozenBank, rng: CQP.makeRng(2026), nowISO: "2026-10-10T19:30:00+08:00" });
  assert.equal(paper.questionIds.length, 100);
  assert.equal(new Set(paper.questionIds).size, 100);
  assert.equal(paper.timeLimitSec, 3600);
  assert.equal(paper.totalScore, 100);
  assert.equal(paper.perQuestionScore, 1);
  assert.equal(paper.startedAt, "2026-10-10T19:30:00+08:00");
  assert.match(paper.sessionId, /^mock-20261010-193000-[0-9a-f]{6}$/);
  assert.deepEqual(paper.distribution.byType, CQP.MOCK_DIST_EXPECT.byType);
  assert.deepEqual(paper.distribution.byChapter, CQP.MOCK_DIST_EXPECT.byChapter);

  const byId = new Map(frozenBank.questions.map((q) => [q.id, q]));
  const types = paper.questionIds.map((id) => byId.get(id).sectionType);
  const order = CQP.MOCK_TYPE_ORDER;
  const ranks = types.map((t) => order.indexOf(t));
  for (let i = 1; i < ranks.length; i += 1) assert.ok(ranks[i] >= ranks[i - 1], "type blocks are contiguous and ordered");
  for (const id of paper.questionIds) assert.equal(byId.get(id).answerStatus, "ok");
});

test("buildMockPaper is deterministic for the same rng seed", () => {
  const a = CQP.buildMockPaper({ bank: frozenBank, rng: CQP.makeRng(11), nowISO: "2026-10-10T19:30:00+08:00" });
  const b = CQP.buildMockPaper({ bank: frozenBank, rng: CQP.makeRng(11), nowISO: "2026-10-10T19:30:00+08:00" });
  assert.deepEqual(a.questionIds, b.questionIds);
});

test("gradeMock scores 1 point per correct answer and counts unanswered", () => {
  const paper = CQP.buildMockPaper({ bank: frozenBank, rng: CQP.makeRng(5), nowISO: "2026-10-10T19:30:00+08:00" });
  const byId = new Map(frozenBank.questions.map((q) => [q.id, q]));
  const responses = {};
  let expectedCorrect = 0;
  paper.questionIds.forEach((id, index) => {
    if (index < 5) {
      responses[id] = { myAnswer: [], confidence: "confident", elapsedMs: 0 };
      return;
    }
    const question = byId.get(id);
    const answer = question.answer.slice();
    responses[id] = { myAnswer: answer, confidence: "confident", elapsedMs: 1000 + index };
    expectedCorrect += 1;
  });
  const session = CQP.gradeMock({
    paper,
    responses,
    bank: frozenBank,
    submittedAtISO: "2026-10-10T20:20:00+08:00",
    autoSubmitted: false,
    nickname: "小明",
  });
  assert.equal(session.result.score, expectedCorrect);
  assert.equal(session.result.correctCount, expectedCorrect);
  assert.equal(session.result.unansweredCount, 5);
  assert.equal(session.result.maxScore, 100);
  assert.equal(session.autoSubmitted, false);
  assert.equal(session.nickname, "小明");
  assert.equal(session.timeLimitSec, 3600);
  assert.equal(session.result.totalElapsedMs, 50 * 60 * 1000);
  assert.equal(session.responses[paper.questionIds[0]].myAnswer.length, 0);
  assert.equal(session.responses[paper.questionIds[0]].correct, false);
  const typeScoreSum = CQP.MOCK_TYPE_ORDER.reduce((sum, t) => sum + session.result.byType[t].score, 0);
  assert.equal(typeScoreSum, session.result.score);
  const typeTotalSum = CQP.MOCK_TYPE_ORDER.reduce((sum, t) => sum + session.result.byType[t].total, 0);
  assert.equal(typeTotalSum, 100);
});

test("gradeMock clamps total elapsed time to the 60 minute limit", () => {
  const paper = CQP.buildMockPaper({ bank: frozenBank, rng: CQP.makeRng(9), nowISO: "2026-10-10T19:30:00+08:00" });
  const session = CQP.gradeMock({
    paper,
    responses: {},
    bank: frozenBank,
    submittedAtISO: "2026-10-10T21:30:00+08:00",
    autoSubmitted: true,
  });
  assert.equal(session.autoSubmitted, true);
  assert.equal(session.result.totalElapsedMs, 3600000);
  assert.equal(session.result.score, 0);
  assert.equal(session.result.unansweredCount, 100);
  assert.deepEqual(session.result.rankKey, [0, -3600000, 0, 0, 0, 0]);
});

test("gradeMock excludes unanswered time from per-type totals (10.4)", () => {
  const paper = CQP.buildMockPaper({ bank: frozenBank, rng: CQP.makeRng(21), nowISO: "2026-10-10T19:30:00+08:00" });
  const byId = new Map(frozenBank.questions.map((q) => [q.id, q]));
  const responses = {};
  paper.questionIds.forEach((id, index) => {
    const question = byId.get(id);
    if (index < 10) {
      // 未作答但停留了 5000ms：不计入任何题型用时
      responses[id] = { myAnswer: [], confidence: "confident", elapsedMs: 5000 };
      return;
    }
    responses[id] = { myAnswer: question.answer.slice(), confidence: "confident", elapsedMs: 1000 };
  });
  const session = CQP.gradeMock({
    paper,
    responses,
    bank: frozenBank,
    submittedAtISO: "2026-10-10T20:30:00+08:00",
  });
  const perTypeElapsed = CQP.MOCK_TYPE_ORDER.reduce((sum, type) => sum + session.result.byType[type].elapsedMs, 0);
  assert.equal(session.result.unansweredCount, 10);
  assert.equal(perTypeElapsed, 90 * 1000, "只有已作答题的用时进入题型分项");
  assert.equal(session.result.totalElapsedMs, 3600000, "总用时仍按实际经过时间（截断 60 分钟）");
});

test("rankKey ordering matches the official tie-break rules (T-10-05)", () => {
  const build = (score, seconds, blank, multiple, single, judge) => {
    const byType = {
      blank: { total: 3, correct: blank, score: blank, elapsedMs: 0 },
      multiple: { total: 34, correct: multiple, score: multiple, elapsedMs: 0 },
      single: { total: 47, correct: single, score: single, elapsedMs: 0 },
      judge: { total: 16, correct: judge, score: judge, elapsedMs: 0 },
    };
    return CQP.rankKey({ score, totalElapsedMs: seconds * 1000, byType });
  };
  const a = build(80, 3000, 2, 30, 40, 8);
  const b = build(80, 2500, 2, 30, 40, 8);
  assert.deepEqual(a, [80, -3000000, 2, 30, 40, 8]);
  assert.ok(CQP.compareRankKey(b, a) < 0, "fewer seconds ranks first");
  const c = build(80, 2500, 3, 29, 40, 8);
  assert.ok(CQP.compareRankKey(c, b) < 0, "higher blank score ranks first");
  const d = build(80, 2500, 3, 31, 38, 8);
  assert.ok(CQP.compareRankKey(d, c) < 0, "multiple score is compared before single");
  const e = build(80, 2500, 3, 31, 38, 9);
  assert.ok(CQP.compareRankKey(e, d) < 0, "judge score is the last tie-breaker");
  const high = build(81, 3600, 0, 0, 0, 0);
  assert.ok(CQP.compareRankKey(high, e) < 0, "score dominates");
});

test("gradeMock keeps per-type elapsed sums and declared keys", () => {
  const paper = CQP.buildMockPaper({ bank: frozenBank, rng: CQP.makeRng(3), nowISO: "2026-10-10T19:30:00+08:00" });
  const byId = new Map(frozenBank.questions.map((q) => [q.id, q]));
  const responses = {};
  paper.questionIds.forEach((id, index) => {
    responses[id] = { myAnswer: byId.get(id).answer.slice(), confidence: "confident", elapsedMs: index * 10 };
  });
  const session = CQP.gradeMock({
    paper,
    responses,
    bank: frozenBank,
    submittedAtISO: "2026-10-10T20:00:00+08:00",
  });
  assert.deepEqual(Object.keys(session.result.byType), ["blank", "multiple", "single", "judge"]);
  for (const type of CQP.MOCK_TYPE_ORDER) {
    const row = session.result.byType[type];
    assert.equal(row.score, row.correct);
    assert.ok(Number.isInteger(row.elapsedMs));
  }
});

test("real bank: mock paper matches 10.2 and stays duplicate free", (t) => {
  const realPath = path.join(here, "..", "src", "data", "bank.json");
  if (!fs.existsSync(realPath)) {
    t.skip("src/data/bank.json not available");
    return;
  }
  const bank = JSON.parse(fs.readFileSync(realPath, "utf8"));
  const paper = CQP.buildMockPaper({ bank, rng: CQP.makeRng(2026) });
  assert.equal(paper.questionIds.length, 100);
  assert.equal(new Set(paper.questionIds).size, 100);
  assert.deepEqual(paper.distribution.byType, CQP.MOCK_DIST_EXPECT.byType);
  assert.deepEqual(paper.distribution.byChapter, CQP.MOCK_DIST_EXPECT.byChapter);
  const byId = new Map(bank.questions.map((q) => [q.id, q]));
  for (const id of paper.questionIds) assert.equal(byId.get(id).answerStatus, "ok");
});
