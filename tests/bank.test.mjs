// Bank contract: docs/需求规格.md 5.x / 9.11 / 5.9.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CQP } from "../src/core/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "fixtures", "bank.sample.json");
const realPath = path.join(here, "..", "src", "data", "bank.json");

function loadFixture() {
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("fixture bank validates and covers all four question types", () => {
  const bank = loadFixture();
  const result = CQP.validateBank(bank);
  assert.equal(result.ok, true, JSON.stringify(result.errors.slice(0, 5)));
  assert.equal(bank.questions.length, 38);
  const counts = CQP.countsOf(bank);
  assert.deepEqual(counts.bySectionType, { single: 18, multiple: 9, judge: 9, blank: 2 });
  assert.equal(counts.byChapter.C01, 8);
  const index = CQP.tagIndex(bank);
  assert.ok(Object.keys(index).length > 5);
  for (const tag of Object.keys(index)) {
    const ids = index[tag];
    assert.deepEqual(ids, ids.slice().sort(), "tag index ids must be sorted");
  }
});

test("validateBank reports structural problems", () => {
  const bank = loadFixture();

  const badTag = clone(bank);
  badTag.questions[0].tags = ["不存在标签"];
  assert.ok(CQP.validateBank(badTag).errors.some((e) => e.code === "E_Q_TAG_VOCAB"));

  const uncategorized = clone(bank);
  uncategorized.questions[0].tags = ["未分类"];
  assert.ok(CQP.validateBank(uncategorized).errors.some((e) => e.code === "E_Q_TAGS_UNCATEGORIZED"));

  const dupId = clone(bank);
  dupId.questions[1].id = dupId.questions[0].id;
  assert.ok(CQP.validateBank(dupId).errors.some((e) => e.code === "E_Q_ID_DUP"));

  const badEnum = clone(bank);
  badEnum.questions[0].sectionType = "essay";
  assert.ok(CQP.validateBank(badEnum).errors.some((e) => e.code === "E_Q_SECTION"));

  const modeMismatch = clone(bank);
  const mismatchIndex = modeMismatch.questions.findIndex((q) => q.id === "Q-C05-S-0002");
  modeMismatch.questions[mismatchIndex].responseMode = "single";
  assert.ok(CQP.validateBank(modeMismatch).errors.some((e) => e.code === "E_Q_MODE_MISMATCH"));

  const badCount = clone(bank);
  badCount.chapters[0].sections[0].count = 99;
  const badCountCodes = CQP.validateBank(badCount).errors.map((e) => e.code);
  assert.ok(badCountCodes.indexOf("E_CHAPTER_SECTION_COUNT") >= 0, badCountCodes.join(","));
  assert.ok(badCountCodes.indexOf("E_CHAPTER_TOTAL") >= 0, badCountCodes.join(","));

  const badAnswer = clone(bank);
  const judgeIndex = badAnswer.questions.findIndex((q) => q.sectionType === "judge");
  badAnswer.questions[judgeIndex].answer = ["T"];
  assert.ok(CQP.validateBank(badAnswer).errors.some((e) => e.code === "E_Q_JUDGE_ANSWER"));

  const unsorted = clone(bank);
  const multipleIndex = unsorted.questions.findIndex((q) => q.sectionType === "multiple");
  unsorted.questions[multipleIndex].answer = ["C", "A", "B"];
  assert.ok(CQP.validateBank(unsorted).errors.some((e) => e.code === "E_Q_ANSWER_SORT"));

  const missingInconsistent = clone(bank);
  missingInconsistent.questions[0].answerStatus = "missing";
  assert.ok(CQP.validateBank(missingInconsistent).errors.some((e) => e.code === "E_Q_ANSWER_MISSING_INCONSISTENT"));
});

test("validateBank rejects a wrong schema version", () => {
  const bank = loadFixture();
  bank.schemaVersion = "2.0.0";
  const result = CQP.validateBank(bank);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === "E_BANK_SCHEMA"));
});

test("index helpers expose chapters, questions and counts", () => {
  const bank = loadFixture();
  const question = CQP.questionById(bank, "Q-C01-S-0001");
  assert.equal(question.chapterName, "密码法律法规");
  assert.equal(CQP.questionById(bank, "Q-NOPE-S-0001"), null);
  const chapters = CQP.chapterIndex(bank);
  assert.equal(chapters.C01.length, 8);
  assert.deepEqual(chapters.C01.slice(0, 2).map((q) => q.sectionType), ["single", "single"]);
  const tagCounts = CQP.tagCounts(bank);
  assert.equal(tagCounts["密码法"], 4);
  assert.equal(CQP.expectedDifficulty({ partCode: "P", sectionType: "blank" }), 3);
  assert.equal(CQP.expectedDifficulty({ partCode: "B", sectionType: "judge" }), 1);
  const report = CQP.buildReport(bank);
  assert.equal(report.countsByChapter.C01, 8);
  assert.ok(report.fallbackTagged > 0);
});

test("real bank satisfies the frozen count table (T-05-01/T-05-02)", (t) => {
  if (!fs.existsSync(realPath)) {
    t.skip("src/data/bank.json not available");
    return;
  }
  const bank = JSON.parse(fs.readFileSync(realPath, "utf8"));
  const result = CQP.validateBank(bank);
  assert.equal(result.ok, true, JSON.stringify(result.errors.slice(0, 8)));
  const expect = CQP.__test.expectCounts;
  assert.equal(bank.questions.length, expect.theoryBlocks);
  assert.equal(bank.source.pages, expect.pages);
  const counts = CQP.countsOf(bank);
  assert.deepEqual(counts.bySectionType, expect.bySectionType);
  assert.deepEqual(counts.byResponseMode, expect.byResponseMode);
  assert.deepEqual(counts.byChapter, expect.byChapter);

  const byId = new Map(bank.questions.map((q) => [q.id, q]));
  let missing = 0;
  let needsReview = 0;
  let printedNull = 0;
  let mismatch = 0;
  const judgeAnswers = { 对: 0, 错: 0 };
  const tagSet = new Set(CQP.TAG_VOCAB);
  for (const q of bank.questions) {
    if (q.answerStatus !== "ok") missing += 1;
    if (q.needsReview) needsReview += 1;
    if (q.printedNo === null) printedNull += 1;
    if (q.sectionType !== q.responseMode) mismatch += 1;
    if (q.sectionType === "judge") judgeAnswers[q.answer[0]] += 1;
    assert.equal(q.tags.length >= 1 && q.tags.length <= 3, true, q.id);
    for (const tag of q.tags) assert.ok(tagSet.has(tag), q.id + " tag " + tag);
  }
  assert.equal(missing, expect.answerMissing);
  assert.equal(needsReview, expect.needsReview);
  assert.equal(printedNull, expect.printedNoNull);
  assert.equal(mismatch, expect.sectionResponseMismatch);
  assert.deepEqual(judgeAnswers, expect.judgeAnswer);
  for (const id of expect.needsReviewIds) assert.equal(byId.get(id).needsReview, true, id);
  for (const id of expect.mismatchIds) assert.notEqual(byId.get(id).sectionType, byId.get(id).responseMode, id);
  assert.equal(byId.get("Q-C05-S-0060").printedNo, null);
  assert.equal(byId.get("Q-C05-F-0007").answer[0], "16", "spec v1.1.0: the answer is filled in");
  assert.equal(byId.get("Q-C05-F-0007").reviewReason, "answer_missing");
  // the missing-answer pool exclusion no longer removes anything
  assert.equal(CQP.candidates({ bank }).length, expect.theoryBlocks);
});
