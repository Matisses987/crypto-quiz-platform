// Attempt records: docs/需求规格.md 6.2 / 9.5.
import test from "node:test";
import assert from "node:assert/strict";
import { CQP } from "../src/core/index.mjs";

const q = CQP.__test.makeQuestion;

function baseInput(overrides) {
  return Object.assign(
    {
      question: q({ sectionType: "single", answer: ["B"] }),
      myAnswer: ["B"],
      confidence: "confident",
      elapsedMs: 12400,
      mode: "practice_chapter",
      nickname: "小明",
      bankVersion: "2026.08-pdf1",
      // 故意给一个旧版本值：旧记录/旧导出里的 appVersion 必须原样透传（当前应用版本见 CQP.VERSION）
      appVersion: "1.0.0",
      nowISO: "2026-10-05T21:14:03+08:00",
    },
    overrides || {}
  );
}

test("makeRecord fills ts, localDate, recordKey, correct, color", () => {
  const input = baseInput();
  const record = CQP.makeRecord(input);
  assert.equal(record.recordKey, "小明\u0001Q-C01-S-0001\u00012026-10-05T21:14:03+08:00");
  assert.equal(record.qid, "Q-C01-S-0001");
  assert.equal(record.ts, "2026-10-05T21:14:03+08:00");
  assert.equal(record.localDate, "2026-10-05");
  assert.equal(record.mode, "practice_chapter");
  assert.equal(record.sessionId, null);
  assert.deepEqual(record.myAnswer, ["B"]);
  assert.equal(record.correct, true);
  assert.equal(record.confidence, "confident");
  assert.equal(record.color, "green");
  assert.equal(record.elapsedMs, 12400);
  assert.equal(record.bankVersion, "2026.08-pdf1");
  // t37：断言「按输入透传」，不写死应用版本号（旧版本记录不会被改写）
  assert.equal(record.appVersion, input.appVersion);
});

test("makeRecord defaults appVersion to the current CQP.VERSION", () => {
  const input = baseInput();
  delete input.appVersion;
  assert.equal(CQP.makeRecord(input).appVersion, CQP.VERSION);
  assert.match(CQP.VERSION, /^\d+\.\d+\.\d+$/);
});

test("makeRecord derives yellow/red colours", () => {
  const guessed = CQP.makeRecord(baseInput({ confidence: "guessed" }));
  assert.equal(guessed.color, "yellow");
  const wrong = CQP.makeRecord(baseInput({ myAnswer: ["A"] }));
  assert.equal(wrong.correct, false);
  assert.equal(wrong.color, "red");
  const wrongGuessed = CQP.makeRecord(baseInput({ myAnswer: ["A"], confidence: "guessed" }));
  assert.equal(wrongGuessed.color, "red");
});

test("makeRecord sorts and de-duplicates multiple answers", () => {
  const question = q({ sectionType: "multiple", answer: ["A", "B", "D"] });
  const record = CQP.makeRecord(baseInput({ question, myAnswer: ["D", "A", "A", "B"] }));
  assert.deepEqual(record.myAnswer, ["A", "B", "D"]);
  assert.equal(record.correct, true);
});

test("makeRecord keeps raw blank input untouched", () => {
  const question = q({ sectionType: "blank", answer: ["SM4"] });
  const record = CQP.makeRecord(baseInput({ question, myAnswer: [" Sm4  "] }));
  assert.deepEqual(record.myAnswer, [" Sm4  "]);
  assert.equal(record.correct, true);
});

test("makeRecord clamps elapsedMs to 24h", () => {
  const record = CQP.makeRecord(baseInput({ elapsedMs: 999999999999 }));
  assert.equal(record.elapsedMs, 86400000);
  const rounded = CQP.makeRecord(baseInput({ elapsedMs: 1200.6 }));
  assert.equal(rounded.elapsedMs, 1201);
});

test("makeRecord rejects bad input", () => {
  assert.throws(() => CQP.makeRecord(baseInput({ elapsedMs: -1 })), RangeError);
  assert.throws(() => CQP.makeRecord(baseInput({ elapsedMs: Number.NaN })), RangeError);
  assert.throws(() => CQP.makeRecord(baseInput({ confidence: "maybe" })), TypeError);
  assert.throws(() => CQP.makeRecord(baseInput({ mode: "exam" })), TypeError);
  assert.throws(() => CQP.makeRecord(baseInput({ nickname: "  " })), TypeError);
  assert.throws(() => CQP.makeRecord(baseInput({ nickname: "abcdefghijklmnopqrstu" })), RangeError);
  assert.throws(() => CQP.makeRecord(baseInput({ myAnswer: [1] })), TypeError);
});

test("recordKey is nickname + \\u0001 + qid + \\u0001 + ts", () => {
  const key = CQP.recordKey({ nickname: "小明", qid: "Q-C01-S-0002", ts: "2026-10-05T21:14:03+08:00" });
  assert.equal(key, "小明\u0001Q-C01-S-0002\u00012026-10-05T21:14:03+08:00");
  assert.throws(() => CQP.recordKey({ qid: "Q-C01-S-0002", ts: "x" }), TypeError);
  assert.throws(() => CQP.recordKey({ nickname: "a", ts: "x" }), TypeError);
});

test("statsOfRecords counts attempts, correct/wrong and confidence split", () => {
  const stats = CQP.statsOfRecords([
    { correct: true, confidence: "confident", ts: "2026-10-05T10:00:00+08:00" },
    { correct: true, confidence: "guessed", ts: "2026-10-05T11:00:00+08:00" },
    { correct: false, confidence: "confident", ts: "2026-10-05T12:00:00+08:00" },
  ]);
  assert.equal(stats.attempts, 3);
  assert.equal(stats.correct, 2);
  assert.equal(stats.wrong, 1);
  assert.equal(stats.guessedCorrect, 1);
  assert.equal(stats.confidentCorrect, 1);
  assert.equal(stats.firstTs, "2026-10-05T10:00:00+08:00");
  assert.equal(stats.lastTs, "2026-10-05T12:00:00+08:00");
});
