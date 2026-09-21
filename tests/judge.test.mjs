// Judging boundaries: docs/需求规格.md 9.3 table rows #1..#17, 9.4, and the
// captain decision of 2026-09-19 (full-width folding for blank answers).
import test from "node:test";
import assert from "node:assert/strict";
import { CQP } from "../src/core/index.mjs";

const q = CQP.__test.makeQuestion;

function jq(sectionType, answer) {
  return q({ sectionType, answer });
}

test("judge: single choice exact match (rows 1-3)", () => {
  const question = jq("single", ["C"]);
  assert.equal(question.responseMode, "single");
  assert.deepEqual(CQP.judge(question, ["C"]), {
    correct: true,
    normalizedAnswer: ["C"],
    normalizedResponse: ["C"],
    reason: "exact",
  });
  const wrong = CQP.judge(question, ["A"]);
  assert.equal(wrong.correct, false);
  assert.equal(wrong.reason, "exact");
  const empty = CQP.judge(question, []);
  assert.equal(empty.correct, false);
  assert.equal(empty.reason, "exact");
});

test("judge: single-section question with multi-letter answer uses set_equal (row 4)", () => {
  const question = jq("single", ["A", "B", "C"]);
  assert.equal(question.responseMode, "multiple");
  const res = CQP.judge(question, ["C", "A", "B"]);
  assert.equal(res.correct, true);
  assert.equal(res.reason, "set_equal");
});

test("judge: multiple requires the full set (rows 5, 6, 8)", () => {
  const question = jq("multiple", ["A", "B", "D"]);
  const missing = CQP.judge(question, ["A", "B"]);
  assert.equal(missing.correct, false);
  assert.equal(missing.reason, "set_equal");
  const extra = CQP.judge(question, ["A", "B", "C", "D"]);
  assert.equal(extra.correct, false);
  const blank = CQP.judge(question, []);
  assert.equal(blank.correct, false);
});

test("judge: multiple ignores input order (row 7)", () => {
  const question = jq("multiple", ["A", "B", "D"]);
  const res = CQP.judge(question, ["B", "D", "A"]);
  assert.equal(res.correct, true);
  assert.deepEqual(res.normalizedResponse, ["A", "B", "D"]);
});

test("judge: judge type accepts only 对/错 (rows 9, 10)", () => {
  const question = jq("judge", ["对"]);
  assert.equal(CQP.judge(question, ["对"]).correct, true);
  assert.equal(CQP.judge(question, ["错"]).correct, false);
  assert.equal(CQP.judge(question, ["T"]).correct, false);
  assert.equal(CQP.judge(question, ["true"]).correct, false);
  assert.equal(CQP.judge(question, ["√"]).correct, false);
});

test("judge: blank ignores case and surrounding spaces (rows 11-14)", () => {
  const question = jq("blank", ["SM4"]);
  assert.equal(CQP.judge(question, ["sm4"]).correct, true);
  assert.equal(CQP.judge(question, ["  SM4  "]).correct, true);
  assert.equal(CQP.judge(question, ["SM 4"]).correct, false, "inner space must not be ignored");
  assert.equal(CQP.judge(question, ["128"]).correct, false);
  assert.equal(CQP.judge(jq("blank", ["256"]), ["256"]).correct, true);
});

test("judge: blank accepts any of several answers (row 15)", () => {
  const question = jq("blank", ["SM4", "SM4算法"]);
  const res = CQP.judge(question, ["sm4算法"]);
  assert.equal(res.correct, true);
  assert.equal(res.reason, "string_match");
  assert.deepEqual(res.normalizedAnswer, ["sm4", "sm4算法"]);
});

test("judge: missing answer yields no_answer (row 16)", () => {
  const question = jq("blank", []);
  const res = CQP.judge(question, ["16"]);
  assert.equal(res.correct, false);
  assert.equal(res.reason, "no_answer");
});

test("judge: single-letter multiple-section answer stays correct (row 17)", () => {
  const question = jq("multiple", ["A"]);
  assert.equal(question.responseMode, "single", "derived per 5.3.3");
  const res = CQP.judge(question, ["A"]);
  assert.equal(res.correct, true);
});

test("judge: invalid response shape", () => {
  const question = jq("single", ["A"]);
  assert.equal(CQP.judge(question, "A").reason, "invalid_response");
  assert.equal(CQP.judge(question, ["A", 1]).reason, "invalid_response");
  assert.equal(CQP.judge(question, ["A", 1]).correct, false);
});

test("norm: fold width, trim, lowercase (captain decision 2026-09-19)", () => {
  assert.equal(CQP.DEFAULTS.blankFoldWidth, true);
  assert.equal(CQP.norm(" SM4 "), "sm4");
  assert.equal(CQP.norm(" Sm4 "), "sm4");
  assert.equal(CQP.norm("SM 4"), "sm 4");
  assert.equal(CQP.norm("ＳＭ４"), "sm4");
  assert.equal(CQP.norm("２５６"), "256");
  assert.equal(CQP.norm("　ａ　"), "a");
  assert.equal(CQP.norm("ＳＭ４", { foldWidth: false }), "ｓｍ４");
});

test("foldWidth: only width folding, no inner-space removal", () => {
  assert.equal(CQP.foldWidth("ａ１　ｂ"), "a1 b");
  assert.equal(CQP.foldWidth("SM4"), "SM4");
  assert.equal(CQP.foldWidth("中文"), "中文");
});

test("judge: full-width input accepted for blank (captain decision)", () => {
  const question = jq("blank", ["SM4"]);
  assert.equal(CQP.judge(question, ["ＳＭ４"]).correct, true);
  assert.equal(CQP.judge(jq("blank", ["256"]), ["２５６"]).correct, true);
  assert.equal(CQP.judge(question, ["　ｓｍ４　"]).correct, true);
  assert.equal(CQP.judge(question, ["SM5"]).correct, false);
});

test("judge: full-width folding can be switched off", () => {
  const question = jq("blank", ["SM4"]);
  assert.equal(CQP.judge(question, ["ＳＭ４"], { foldWidth: false }).correct, false);
  assert.equal(CQP.judge(question, ["sm4"], { foldWidth: false }).correct, true);
});

test("color + isWrongEntry follow the three-colour rule", () => {
  assert.equal(CQP.color({ correct: true, confidence: "confident" }), "green");
  assert.equal(CQP.color({ correct: true, confidence: "guessed" }), "yellow");
  assert.equal(CQP.color({ correct: false, confidence: "confident" }), "red");
  assert.equal(CQP.color({ correct: false, confidence: "guessed" }), "red");
  assert.equal(CQP.isWrongEntry({ correct: true, confidence: "confident" }), false);
  assert.equal(CQP.isWrongEntry({ correct: true, confidence: "guessed" }), true);
  assert.equal(CQP.isWrongEntry({ correct: false, confidence: "confident" }), true);
  assert.equal(CQP.isWrongEntry({ correct: false, confidence: "guessed" }), true);
});

test("type errors are raised instead of silent undefined", () => {
  assert.throws(() => CQP.norm(5), TypeError);
  assert.throws(() => CQP.color({ correct: "yes", confidence: "confident" }), TypeError);
  assert.throws(() => CQP.color({ correct: true, confidence: "sure" }), TypeError);
  assert.throws(() => CQP.judge({ answer: ["A"] }, ["A"]), TypeError);
});

test("answerText renders the frozen answer form", () => {
  assert.equal(CQP.answerText(jq("single", ["B"])), "B");
  assert.equal(CQP.answerText(jq("multiple", ["A", "B"])), "AB");
  assert.equal(CQP.answerText(jq("judge", ["对"])), "对");
  assert.equal(CQP.answerText(jq("blank", ["SM4", "SM4算法"])), "SM4 / SM4算法");
  assert.equal(CQP.answerText(jq("blank", [])), "（缺答案）");
});
