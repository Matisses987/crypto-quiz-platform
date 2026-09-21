// Wrongbook state machine: docs/需求规格.md 8.3 / 9.7 table rows 1..10.
import test from "node:test";
import assert from "node:assert/strict";
import { CQP } from "../src/core/index.mjs";

const mk = CQP.__test.makeRecord;
const NOW = "2026-10-05T21:00:00+08:00";
const LATER = "2026-10-06T09:00:00+08:00";

function rec(overrides) {
  return mk(
    Object.assign(
      {
        qid: "Q-C01-S-0001",
        myAnswer: ["A"],
        correct: true,
        confidence: "confident",
        ts: NOW,
        localDate: "2026-10-05",
      },
      overrides || {}
    )
  );
}

test("first wrong answer enters the wrongbook (red)", () => {
  const res = CQP.wrongbookApply({}, rec({ correct: false, myAnswer: ["B"] }), NOW);
  assert.equal(res.action, "added");
  const entry = res.book["Q-C01-S-0001"];
  assert.equal(entry.state, "active");
  assert.equal(entry.addedAt, NOW);
  assert.equal(entry.lastWrongAt, NOW);
  assert.equal(entry.confidentStreak, 0);
  assert.equal(entry.removedAt, null);
  assert.equal(entry.removedReason, null);
});

test("first guessed-correct answer enters the wrongbook (yellow) with lastWrongAt null", () => {
  const res = CQP.wrongbookApply({}, rec({ correct: true, confidence: "guessed" }), NOW);
  assert.equal(res.action, "added");
  assert.equal(res.book["Q-C01-S-0001"].state, "active");
  assert.equal(res.book["Q-C01-S-0001"].lastWrongAt, null);
});

test("confident-correct answer never enters the wrongbook (green)", () => {
  const res = CQP.wrongbookApply({}, rec({ correct: true, confidence: "confident" }), NOW);
  assert.equal(res.action, "none");
  assert.deepEqual(res.book, {});
});

test("two consecutive confident-correct answers auto-remove (auto2)", () => {
  let book = CQP.wrongbookApply({}, rec({ correct: false, myAnswer: ["B"] }), NOW).book;
  const first = CQP.wrongbookApply(book, rec({ correct: true }), LATER);
  assert.equal(first.action, "kept");
  assert.equal(first.book["Q-C01-S-0001"].confidentStreak, 1);
  assert.equal(first.book["Q-C01-S-0001"].state, "active");
  const second = CQP.wrongbookApply(first.book, rec({ correct: true }), LATER);
  assert.equal(second.action, "removed");
  const entry = second.book["Q-C01-S-0001"];
  assert.equal(entry.state, "removed");
  assert.equal(entry.removedReason, "auto2");
  assert.equal(entry.removedAt, LATER);
  assert.equal(entry.confidentStreak, 0);
});

test("a wrong answer breaks the streak (T-08-03)", () => {
  let book = CQP.wrongbookApply({}, rec({ correct: false, myAnswer: ["B"] }), NOW).book;
  book = CQP.wrongbookApply(book, rec({ correct: true }), LATER).book; // streak 1
  const afterWrong = CQP.wrongbookApply(book, rec({ correct: false, myAnswer: ["C"] }), LATER);
  assert.equal(afterWrong.action, "kept");
  assert.equal(afterWrong.book["Q-C01-S-0001"].confidentStreak, 0);
  assert.equal(afterWrong.book["Q-C01-S-0001"].lastWrongAt, LATER);
  const one = CQP.wrongbookApply(afterWrong.book, rec({ correct: true }), LATER);
  assert.equal(one.action, "kept");
  const two = CQP.wrongbookApply(one.book, rec({ correct: true }), LATER);
  assert.equal(two.action, "removed");
});

test("a guessed-correct answer breaks the streak but keeps the entry", () => {
  let book = CQP.wrongbookApply({}, rec({ correct: false, myAnswer: ["B"] }), NOW).book;
  book = CQP.wrongbookApply(book, rec({ correct: true }), LATER).book;
  const guessed = CQP.wrongbookApply(book, rec({ correct: true, confidence: "guessed" }), LATER);
  assert.equal(guessed.action, "kept");
  assert.equal(guessed.book["Q-C01-S-0001"].confidentStreak, 0);
  assert.equal(guessed.book["Q-C01-S-0001"].state, "active");
});

test("manual removal marks removed/manual and blocks re-entry on green", () => {
  const added = CQP.wrongbookApply({}, rec({ correct: false, myAnswer: ["B"] }), NOW).book;
  const removed = CQP.wrongbookRemoveManual(added, "Q-C01-S-0001", LATER);
  assert.equal(removed.action, "removed");
  assert.equal(removed.book["Q-C01-S-0001"].state, "removed");
  assert.equal(removed.book["Q-C01-S-0001"].removedReason, "manual");
  assert.equal(removed.book["Q-C01-S-0001"].removedAt, LATER);
  const green = CQP.wrongbookApply(removed.book, rec({ correct: true }), LATER);
  assert.equal(green.action, "none");
  assert.equal(green.book["Q-C01-S-0001"].state, "removed");
  const again = CQP.wrongbookApply(removed.book, rec({ correct: false, myAnswer: ["B"] }), LATER);
  assert.equal(again.action, "added");
  assert.equal(again.book["Q-C01-S-0001"].state, "active");
  assert.equal(again.book["Q-C01-S-0001"].addedAt, LATER);
  assert.equal(again.book["Q-C01-S-0001"].removedReason, null);
});

test("manual removal of a missing entry is a no-op", () => {
  const res = CQP.wrongbookRemoveManual({}, "Q-C01-S-0001", NOW);
  assert.equal(res.action, "none");
  assert.deepEqual(res.book, {});
});

test("counters increase correctly and mock records do not touch the book", () => {
  let book = {};
  let res = CQP.wrongbookApply(book, rec({ correct: false, myAnswer: ["B"] }), NOW);
  book = res.book;
  assert.equal(book["Q-C01-S-0001"].attemptsSinceAdd, 1);
  assert.equal(book["Q-C01-S-0001"].correctSinceAdd, 0);
  res = CQP.wrongbookApply(book, rec({ correct: true, confidence: "guessed" }), LATER);
  book = res.book;
  assert.equal(book["Q-C01-S-0001"].attemptsSinceAdd, 2);
  assert.equal(book["Q-C01-S-0001"].correctSinceAdd, 1);
  const mockRec = rec({ qid: "Q-C01-S-0002", correct: false, myAnswer: ["B"], mode: "mock" });
  const mockRes = CQP.wrongbookApply(book, mockRec, LATER);
  assert.equal(mockRes.action, "none");
  assert.equal(mockRes.book["Q-C01-S-0002"], undefined);
  const forced = CQP.wrongbookApply(book, mockRec, LATER, { force: true });
  assert.equal(forced.action, "added");
});

test("wrongbookApply does not mutate the input book", () => {
  const book = CQP.wrongbookApply({}, rec({ correct: false, myAnswer: ["B"] }), NOW).book;
  const snapshot = JSON.stringify(book);
  CQP.wrongbookApply(book, rec({ correct: true }), LATER);
  CQP.wrongbookRemoveManual(book, "Q-C01-S-0001", LATER);
  assert.equal(JSON.stringify(book), snapshot);
});

test("wrongbookList merges entries with questions and supports filters", () => {
  const questions = [
    { id: "Q-C01-S-0001", chapterCode: "C01", sectionType: "single", tags: ["密码法"], stem: "a", answer: ["A"] },
    { id: "Q-C02-S-0001", chapterCode: "C02", sectionType: "single", tags: ["网络安全法"], stem: "b", answer: ["A"] },
    { id: "Q-C05-J-0001", chapterCode: "C05", sectionType: "judge", tags: ["密码学基础"], stem: "c", answer: ["对"] },
  ];
  let book = {};
  book = CQP.wrongbookApply(book, rec({ qid: "Q-C01-S-0001", correct: false, myAnswer: ["B"] }), NOW).book;
  book = CQP.wrongbookApply(
    book,
    rec({ qid: "Q-C02-S-0001", correct: true, confidence: "guessed", ts: LATER }),
    LATER
  ).book;
  book = CQP.wrongbookApply(
    book,
    rec({ qid: "Q-C05-J-0001", correct: false, myAnswer: ["错"], ts: "2026-10-03T10:00:00+08:00" }),
    "2026-10-03T10:00:00+08:00"
  ).book;
  const rows = CQP.wrongbookList(book, questions, { state: "active" });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].qid, "Q-C01-S-0001", "sorted by lastWrongAt desc");
  assert.equal(CQP.wrongbookColorOfEntry(rows[0]), "red");
  assert.equal(rows[1].qid, "Q-C05-J-0001");
  assert.equal(rows[2].qid, "Q-C02-S-0001", "never-wronged entries (lastWrongAt null) come last");
  assert.equal(CQP.wrongbookColorOfEntry(rows[2]), "yellow");
  assert.deepEqual(
    CQP.wrongbookList(book, questions, { chapters: ["C01"] }).map((r) => r.qid),
    ["Q-C01-S-0001"]
  );
  assert.deepEqual(
    CQP.wrongbookList(book, questions, { tags: ["网络安全法"] }).map((r) => r.qid),
    ["Q-C02-S-0001"]
  );
  assert.deepEqual(
    CQP.wrongbookList(book, questions, { colors: ["red"] }).map((r) => r.qid),
    ["Q-C01-S-0001", "Q-C05-J-0001"]
  );
  assert.equal(CQP.wrongbookList(book, questions, { state: "removed" }).length, 0);
  assert.equal(CQP.wrongbookList(book, questions, { state: "all" }).length, 3);
  assert.equal(CQP.wrongbookCountActive(book), 3);
  const removed = CQP.wrongbookRemoveManual(book, "Q-C01-S-0001", LATER).book;
  assert.equal(CQP.wrongbookCountActive(removed), 2);
  assert.deepEqual(
    CQP.wrongbookList(removed, questions, { state: "removed" }).map((r) => r.qid),
    ["Q-C01-S-0001"]
  );
});

test("wrongbookList ignores unknown qids and validates filters", () => {
  const book = CQP.wrongbookApply({}, rec({ correct: false, myAnswer: ["B"] }), NOW).book;
  assert.equal(CQP.wrongbookList(book, [], {}).length, 0);
  assert.throws(() => CQP.wrongbookList(book, [], { state: "gone" }), TypeError);
  assert.throws(() => CQP.wrongbookApply({}, { qid: "Q-C01-S-0001" }, NOW), TypeError);
});
