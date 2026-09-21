// Correction overlay: docs/需求规格.md 6.4 / 9.10 / 11.1 (P9).
import test from "node:test";
import assert from "node:assert/strict";
import { CQP } from "../src/core/index.mjs";

const mkQ = CQP.__test.makeQuestion;

function smallBank() {
  return {
    schemaVersion: "1.0.0",
    bankVersion: "fixture-1",
    generatedAt: "2026-09-16T20:00:00+08:00",
    source: { fileName: "密码赛题库.pdf", pages: 199, theoryBlocks: 2, printedQuestions: 2, excludedCount: 12, excludedReason: "x" },
    chapters: [
      {
        chapterCode: "C01",
        partCode: "B",
        partName: "基础题",
        chapterName: "密码法律法规",
        chapterTotal: 1,
        sections: [{ sectionType: "single", typeName: "单选题", count: 1 }],
      },
      {
        chapterCode: "C05",
        partCode: "P",
        partName: "专业题",
        chapterName: "密码学",
        chapterTotal: 1,
        sections: [{ sectionType: "blank", typeName: "填空题", count: 1 }],
      },
    ],
    questions: [
      mkQ({ chapterCode: "C01", sectionType: "single", seq: 1, answer: ["B"], stem: "法规题（ ）" }),
      mkQ({ chapterCode: "C05", sectionType: "blank", seq: 1, answer: [], answerStatus: "missing", rawAnswer: null, needsReview: true, reviewReason: "answer_missing", stem: "密钥长度为 ______ 比特" }),
    ],
  };
}

test("setOverride increments rev and normalises the patch", () => {
  let overrides = CQP.emptyStore().overrides;
  const first = CQP.setOverride(overrides, "Q-C05-F-0001", {
    answer: ["16"],
    flagged: true,
    note: "题干含“可以切 16 块”",
    updatedBy: "小明",
    nowISO: "2026-10-06T09:12:00+08:00",
  });
  const item = first.items["Q-C05-F-0001"];
  assert.deepEqual(item.answer, ["16"]);
  assert.equal(item.tags, null);
  assert.equal(item.difficulty, null);
  assert.equal(item.flagged, true);
  assert.equal(item.updatedBy, "小明");
  assert.equal(item.updatedAt, "2026-10-06T09:12:00+08:00");
  assert.equal(item.rev, 1);

  overrides = first;
  const second = CQP.setOverride(overrides, "Q-C05-F-0001", { answer: ["16 块"], updatedBy: "小明", nowISO: "2026-10-06T10:00:00+08:00" });
  assert.equal(second.items["Q-C05-F-0001"].rev, 2);
  assert.deepEqual(second.items["Q-C05-F-0001"].answer, ["16 块"]);
  assert.equal(overrides.items["Q-C05-F-0001"].rev, 1, "input overlay object is not mutated");
});

test("setOverride treats an empty answer array as no answer override", () => {
  const overrides = CQP.setOverride(CQP.emptyStore().overrides, "Q-C01-S-0001", { answer: [], updatedBy: "小明" });
  assert.equal(overrides.items["Q-C01-S-0001"].answer, null);
});

test("setOverride can restore the original answer while keeping the flag (T-11-05)", () => {
  let overrides = CQP.emptyStore().overrides;
  overrides = CQP.setOverride(overrides, "Q-C05-F-0001", { answer: ["16"], flagged: true, updatedBy: "小明" });
  overrides = CQP.setOverride(overrides, "Q-C05-F-0001", { answer: null, updatedBy: "小明", nowISO: "2026-10-06T11:00:00+08:00" });
  const item = overrides.items["Q-C05-F-0001"];
  assert.equal(item.answer, null);
  assert.equal(item.flagged, true);
  assert.equal(item.rev, 2);
});

test("setOverride validates patch content", () => {
  const overrides = CQP.emptyStore().overrides;
  assert.throws(() => CQP.setOverride(overrides, "Q-C01-S-0001", { updatedBy: "" }), TypeError);
  assert.throws(() => CQP.setOverride(overrides, "Q-C01-S-0001", { answer: "A", updatedBy: "小明" }), TypeError);
  assert.throws(() => CQP.setOverride(overrides, "Q-C01-S-0001", { answer: [1], updatedBy: "小明" }), TypeError);
  assert.throws(() => CQP.setOverride(overrides, "Q-C01-S-0001", { difficulty: 4, updatedBy: "小明" }), TypeError);
  assert.throws(() => CQP.setOverride(overrides, "Q-C01-S-0001", { flagged: "yes", updatedBy: "小明" }), TypeError);
  assert.throws(() => CQP.setOverride(overrides, "", { updatedBy: "小明" }), TypeError);
});

test("applyOverrides produces an effective bank without touching the original", () => {
  const bank = smallBank();
  const original = JSON.stringify(bank);
  const overrides = CQP.setOverride(CQP.emptyStore().overrides, "Q-C05-F-0001", {
    answer: ["16"],
    difficulty: 1,
    flagged: true,
    updatedBy: "小明",
  });
  const applied = CQP.applyOverrides(bank, overrides);
  assert.equal(applied.applied, 1);
  const question = applied.bank.questions[1];
  assert.deepEqual(question.answer, ["16"]);
  assert.equal(question.answerStatus, "ok");
  assert.equal(question.difficulty, 1);
  assert.equal(question.flagged, true);
  assert.equal(question.overrideMeta.updatedBy, "小明");
  assert.equal(JSON.stringify(bank), original, "original bank must not be mutated");
  assert.equal(applied.bank.questions[0].overrideMeta, undefined);
});

test("overridden answer makes a previously unanswerable question judgeable (T-11-02)", () => {
  const bank = smallBank();
  const question = bank.questions[1];
  assert.equal(CQP.judge(question, ["16"]).reason, "no_answer");
  const overrides = CQP.setOverride(CQP.emptyStore().overrides, "Q-C05-F-0001", { answer: ["16"], updatedBy: "小明" });
  const effective = CQP.applyOverrides(bank, overrides).bank;
  const verdict = CQP.judge(effective.questions[1], ["１６"]);
  assert.equal(verdict.correct, true);
  assert.equal(verdict.reason, "string_match");
});

test("isFlagged reflects the overlay flag only", () => {
  const overrides = CQP.setOverride(CQP.emptyStore().overrides, "Q-C01-S-0001", { flagged: true, updatedBy: "小明" });
  assert.equal(CQP.isFlagged(overrides, "Q-C01-S-0001"), true);
  assert.equal(CQP.isFlagged(overrides, "Q-C01-S-0002"), false);
  assert.equal(CQP.isFlagged(null, "Q-C01-S-0001"), false);
  assert.equal(CQP.countOverrides(overrides), 1);
});

test("parseAnswerInput splits multi-answers for choice and blank types", () => {
  assert.deepEqual(CQP.parseAnswerInput("ABD", "multiple"), ["A", "B", "D"]);
  assert.deepEqual(CQP.parseAnswerInput("A,B,D", "multiple"), ["A", "B", "D"]);
  assert.deepEqual(CQP.parseAnswerInput("d、a", "multiple"), ["A", "D"]);
  assert.deepEqual(CQP.parseAnswerInput("b", "single"), ["B"]);
  assert.deepEqual(CQP.parseAnswerInput("SM4,SM4算法", "blank"), ["SM4", "SM4算法"]);
  assert.deepEqual(CQP.parseAnswerInput(" 256 ， 128 ", "blank"), ["256", "128"]);
  assert.deepEqual(CQP.parseAnswerInput("", "blank"), []);
});

test("multiple-answer overlay supports both spellings when judging (T-11-03)", () => {
  const bank = smallBank();
  const overrides = CQP.setOverride(CQP.emptyStore().overrides, "Q-C05-F-0001", {
    answer: CQP.parseAnswerInput("SM4,SM4算法", "blank"),
    updatedBy: "小明",
  });
  const effective = CQP.applyOverrides(bank, overrides).bank;
  assert.deepEqual(effective.questions[1].answer, ["SM4", "SM4算法"]);
  assert.equal(CQP.judge(effective.questions[1], ["sm4"]).correct, true);
  assert.equal(CQP.judge(effective.questions[1], ["ＳＭ４算法"]).correct, true);
  assert.equal(CQP.judge(effective.questions[1], ["SM5"]).correct, false);
});
