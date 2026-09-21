// Mastery index: docs/需求规格.md 8.4 / 9.6 table rows #1..#7.
import test from "node:test";
import assert from "node:assert/strict";
import { CQP } from "../src/core/index.mjs";

function attempts(list) {
  return list.map(([correct, confidence]) => ({ correct, confidence }));
}

test("mastery: empty sample (row 1)", () => {
  const m = CQP.masteryOfAttempts([]);
  assert.equal(m.attempts, 0);
  assert.equal(m.index, null);
  assert.equal(m.insufficient, true);
});

test("mastery: two attempts, insufficient sample (row 2)", () => {
  const m = CQP.masteryOfAttempts(attempts([[true, "confident"], [true, "guessed"]]));
  assert.equal(m.attempts, 2);
  assert.equal(m.index, 75);
  assert.equal(m.insufficient, true);
});

test("mastery: mixed sample (row 3)", () => {
  const m = CQP.masteryOfAttempts(attempts([[true, "confident"], [true, "guessed"], [false, "confident"]]));
  assert.equal(m.attempts, 3);
  assert.equal(m.index, 50);
  assert.equal(m.insufficient, false);
  assert.equal(m.confidentCorrect, 1);
  assert.equal(m.guessedCorrect, 1);
  assert.equal(m.wrong, 1);
});

test("mastery: all guessed correct (row 4)", () => {
  const m = CQP.masteryOfAttempts(attempts([[true, "guessed"], [true, "guessed"], [true, "guessed"]]));
  assert.equal(m.index, 50);
});

test("mastery: all wrong is zero (row 5)", () => {
  const m = CQP.masteryOfAttempts(attempts([[false, "confident"], [false, "guessed"], [false, "confident"]]));
  assert.equal(m.index, 0);
  assert.equal(m.insufficient, false);
});

test("mastery: rounding to one decimal (row 6)", () => {
  const m = CQP.masteryOfAttempts(
    attempts([[true, "confident"], [true, "confident"], [true, "confident"], [true, "guessed"]])
  );
  assert.equal(m.index, 87.5);
});

test("masteryOverall is a weighted average, not a mean of indexes (row 7)", () => {
  const records = [
    { qid: "Q-A", correct: true, confidence: "confident" },
    { qid: "Q-B", correct: true, confidence: "guessed" },
    { qid: "Q-B", correct: false, confidence: "confident" },
  ];
  const overall = CQP.masteryOverall(records);
  assert.equal(overall.attempts, 3);
  assert.equal(overall.index, 50);
  assert.equal(overall.insufficient, false);
  const naiveMean = (100 + 50) / 2;
  assert.notEqual(overall.index, naiveMean);
});

test("mastery of a single question filters by qid", () => {
  const records = [
    { qid: "Q-A", correct: true, confidence: "confident" },
    { qid: "Q-A", correct: true, confidence: "confident" },
    { qid: "Q-A", correct: false, confidence: "confident" },
    { qid: "Q-B", correct: false, confidence: "confident" },
  ];
  const m = CQP.masteryOfQuestion(records, "Q-A");
  assert.equal(m.attempts, 3);
  assert.equal(m.index, 66.7);
  const none = CQP.masteryOfQuestion(records, "Q-Z");
  assert.equal(none.attempts, 0);
  assert.equal(none.index, null);
  assert.equal(none.insufficient, true);
});

test("masteryBy groups records by a key function", () => {
  const questions = [
    { id: "Q-A", chapterCode: "C01", sectionType: "single" },
    { id: "Q-B", chapterCode: "C02", sectionType: "multiple" },
  ];
  const records = [
    { qid: "Q-A", correct: true, confidence: "confident" },
    { qid: "Q-A", correct: true, confidence: "confident" },
    { qid: "Q-A", correct: true, confidence: "guessed" },
    { qid: "Q-B", correct: false, confidence: "confident" },
  ];
  const rows = CQP.masteryBy(records, questions, (item) => item.chapterCode);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { key: "C01", attempts: 3, index: 83.3, insufficient: false });
  assert.deepEqual(rows[1], { key: "C02", attempts: 1, index: 0, insufficient: true });
});

test("groupSummary reports answered/correct/accuracy/mastery", () => {
  const questions = [
    { id: "Q-A", chapterCode: "C01", sectionType: "single" },
    { id: "Q-B", chapterCode: "C01", sectionType: "single" },
  ];
  const records = [
    { qid: "Q-A", correct: true, confidence: "confident" },
    { qid: "Q-B", correct: false, confidence: "confident" },
  ];
  const groups = CQP.groupSummary(records, questions, (item) => item.sectionType);
  assert.equal(groups.single.answered, 2);
  assert.equal(groups.single.correct, 1);
  assert.equal(groups.single.accuracy, 50);
  assert.equal(groups.single.mastery.index, 50);
});

test("mastery: sample-size threshold is exactly 3", () => {
  assert.equal(CQP.MASTERY_MIN_SAMPLES, 3);
  assert.equal(CQP.masteryOfAttempts(attempts([[true, "confident"], [true, "confident"]])).insufficient, true);
  assert.equal(
    CQP.masteryOfAttempts(attempts([[true, "confident"], [true, "confident"], [true, "confident"]])).insufficient,
    false
  );
});

test("mastery: identity attempts === confidentCorrect + guessedCorrect + wrong", () => {
  const m = CQP.masteryOfAttempts(attempts([[true, "confident"], [true, "guessed"], [false, "guessed"]]));
  assert.equal(m.attempts, m.confidentCorrect + m.guessedCorrect + m.wrong);
});

test("masteryOfAttempts rejects malformed input", () => {
  assert.throws(() => CQP.masteryOfAttempts("x"), TypeError);
  assert.throws(() => CQP.masteryOfAttempts([{ correct: "yes" }]), TypeError);
});
