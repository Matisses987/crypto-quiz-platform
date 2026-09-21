// Question drawing + practice scoring: docs/需求规格.md 9.8.
import test from "node:test";
import assert from "node:assert/strict";
import { CQP } from "../src/core/index.mjs";

const bank = CQP.__test.makeBank({
  C01: { single: 5, multiple: 3, judge: 2 },
  C05: { single: 4, multiple: 2, judge: 2, blank: 2 },
});

test("makeRng is deterministic for the same seed", () => {
  const a = CQP.makeRng(42);
  const b = CQP.makeRng(42);
  const first = [a(), a(), a()];
  const second = [b(), b(), b()];
  assert.deepEqual(first, second);
  for (const value of first) {
    assert.ok(value >= 0 && value < 1, "value must be in [0,1)");
  }
  const other = CQP.makeRng(43);
  assert.notEqual(other(), first[0]);
  assert.throws(() => CQP.makeRng("42"), TypeError);
});

test("drawQuestions is deterministic for the same seed and never repeats", () => {
  const one = CQP.drawQuestions({ bank, count: 5, rng: CQP.makeRng(7) });
  const two = CQP.drawQuestions({ bank, count: 5, rng: CQP.makeRng(7) });
  assert.deepEqual(one.map((q) => q.id), two.map((q) => q.id));
  assert.equal(one.length, 5);
  assert.equal(new Set(one.map((q) => q.id)).size, 5);
});

test("drawQuestions returns the whole pool when count exceeds it", () => {
  const all = CQP.drawQuestions({ bank, count: 2000, rng: CQP.makeRng(1) });
  assert.equal(all.length, bank.questions.length);
  assert.equal(new Set(all.map((q) => q.id)).size, all.length);
});

test("drawQuestions filters by chapter, type and tag", () => {
  const c01 = CQP.drawQuestions({ bank, chapters: ["C01"], count: 100 });
  assert.equal(c01.length, 10);
  assert.ok(c01.every((q) => q.chapterCode === "C01"));
  const judge = CQP.drawQuestions({ bank, types: ["judge"], count: 100 });
  assert.equal(judge.length, 4);
  assert.ok(judge.every((q) => q.sectionType === "judge"));
  const tagged = CQP.candidates({ bank, tags: ["密码法"] });
  assert.equal(tagged.length, bank.questions.filter((q) => q.tags.includes("密码法")).length);
  assert.equal(CQP.candidates({ bank, tags: ["不存在的标签"] }).length, 0);
});

test("drawQuestions honours excludeQids and the missing-answer default", () => {
  const excluded = CQP.drawQuestions({ bank, count: 100, excludeQids: ["Q-C01-S-0001"] });
  assert.equal(excluded.length, bank.questions.length - 1);
  assert.ok(!excluded.some((q) => q.id === "Q-C01-S-0001"));

  const withMissing = {
    questions: [
      Object.assign({}, bank.questions[0], { id: "Q-C01-S-0001", answerStatus: "missing", answer: [] }),
      bank.questions[1],
    ],
  };
  assert.equal(CQP.drawQuestions({ bank: withMissing, count: 10 }).length, 1);
  assert.equal(CQP.drawQuestions({ bank: withMissing, count: 10, includeNoAnswer: true }).length, 2);
  assert.equal(CQP.DEFAULTS.excludeMissingAnswer, true);
});

test("drawQuestions returns an empty list for an empty pool and validates input", () => {
  assert.deepEqual(CQP.drawQuestions({ bank, chapters: ["C99"], count: 5 }), []);
  assert.throws(() => CQP.drawQuestions({ bank, count: 0 }), TypeError);
  assert.throws(() => CQP.drawQuestions({ bank, count: 1.5 }), TypeError);
  assert.throws(() => CQP.drawQuestions({ questions: [] }), TypeError);
});

test("drawQuestions keeps chapter/type/seq order before shuffling", () => {
  const pool = CQP.candidates({ bank });
  const typeOrder = ["single", "multiple", "judge", "blank"];
  const chapterOrder = CQP.CHAPTER_CODES;
  const keys = pool.map((q) => [
    chapterOrder.indexOf(q.chapterCode),
    typeOrder.indexOf(q.sectionType),
    q.seq,
  ]);
  for (let i = 1; i < keys.length; i += 1) {
    const prev = keys[i - 1];
    const current = keys[i];
    const ascending = prev[0] < current[0] || (prev[0] === current[0] && (prev[1] < current[1] || (prev[1] === current[1] && prev[2] <= current[2])));
    assert.ok(ascending, "pool order at index " + i + ": " + JSON.stringify(prev) + " -> " + JSON.stringify(current));
  }
});

test("practiceScore reports score, total, unanswered and accuracy", () => {
  const records = [
    { correct: true },
    { correct: true },
    { correct: false },
  ];
  const scored = CQP.practiceScore(records, { plannedCount: 5 });
  assert.equal(scored.correct, 2);
  assert.equal(scored.total, 5);
  assert.equal(scored.unanswered, 2);
  assert.equal(scored.score, 2);
  assert.equal(scored.maxScore, 5);
  assert.equal(scored.accuracy, 66.7, "accuracy is over answered questions only");
  const empty = CQP.practiceScore([], { plannedCount: 3 });
  assert.equal(empty.accuracy, null);
  assert.equal(empty.unanswered, 3);
  const noPlan = CQP.practiceScore(records);
  assert.equal(noPlan.total, 3);
  assert.equal(noPlan.unanswered, 0);
  assert.equal(noPlan.accuracy, 66.7);
});
