// 作答记录构造与主键（docs/需求规格.md 6.2 / 9.5）
import { cn_CONFIDENCES, cn_MODES, cn_MAX_ELAPSED_MS, cn_VERSION } from "./constants.mjs";
import { tm_isoNow, tm_localDateOf } from "./time.mjs";
import { jd_judge, jd_color, jd_responseModeOf } from "./judge.mjs";

// CQP.recordKey({nickname, qid, ts}) = nickname + "\u0001" + qid + "\u0001" + ts
export function rc_recordKey(record) {
  if (!record || typeof record !== "object") throw new TypeError("recordKey(record): record must be an object");
  const { nickname, qid, ts } = record;
  if (typeof nickname !== "string" || nickname.length === 0) {
    throw new TypeError("recordKey(record): record.nickname must be a non-empty string");
  }
  if (typeof qid !== "string" || qid.length === 0) {
    throw new TypeError("recordKey(record): record.qid must be a non-empty string");
  }
  if (typeof ts !== "string" || ts.length === 0) {
    throw new TypeError("recordKey(record): record.ts must be a non-empty string");
  }
  return nickname + "\u0001" + qid + "\u0001" + ts;
}

export function rc_normalizeMyAnswer(myAnswer, mode) {
  if (!Array.isArray(myAnswer)) throw new TypeError("makeRecord(input): input.myAnswer must be an array");
  for (const item of myAnswer) {
    if (typeof item !== "string") throw new TypeError("makeRecord(input): input.myAnswer items must be strings");
  }
  if (mode !== "multiple") return myAnswer.slice();
  const seen = new Set();
  const out = [];
  for (const item of myAnswer) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  out.sort();
  return out;
}

// CQP.makeRecord(input)
export function rc_makeRecord(input) {
  if (!input || typeof input !== "object") throw new TypeError("makeRecord(input): input must be an object");
  const question = input.question;
  if (!question || typeof question !== "object" || typeof question.id !== "string") {
    throw new TypeError("makeRecord(input): input.question must be a Question with id");
  }
  if (typeof input.nickname !== "string" || input.nickname.trim().length === 0) {
    throw new TypeError("makeRecord(input): input.nickname must be a non-empty string");
  }
  if (typeof input.nickname === "string" && input.nickname.length > 20) {
    throw new RangeError("makeRecord(input): input.nickname must be 1..20 characters");
  }
  if (cn_CONFIDENCES.indexOf(input.confidence) < 0) {
    throw new TypeError('makeRecord(input): input.confidence must be "confident" | "guessed"');
  }
  if (cn_MODES.indexOf(input.mode) < 0) {
    throw new TypeError("makeRecord(input): input.mode must be one of " + cn_MODES.join(", "));
  }
  const elapsedRaw = input.elapsedMs;
  if (typeof elapsedRaw !== "number" || !Number.isFinite(elapsedRaw)) {
    throw new RangeError("makeRecord(input): input.elapsedMs must be a finite number");
  }
  if (elapsedRaw < 0) throw new RangeError("makeRecord(input): input.elapsedMs must be >= 0");
  const elapsedMs = Math.min(Math.round(elapsedRaw), cn_MAX_ELAPSED_MS);

  const ts = input.nowISO === undefined || input.nowISO === null ? tm_isoNow() : input.nowISO;
  if (typeof ts !== "string") throw new TypeError("makeRecord(input): input.nowISO must be a string");
  const localDate = tm_localDateOf(ts);

  const question2 = { ...question, answer: Array.isArray(question.answer) ? question.answer : [] };
  const mode = jd_responseModeOf(question2);
  const myAnswer = rc_normalizeMyAnswer(input.myAnswer === undefined ? [] : input.myAnswer, mode);
  const verdict = jd_judge(question2, myAnswer);
  const confidence = input.confidence;
  const color = jd_color({ correct: verdict.correct, confidence });

  const record = {
    recordKey: "",
    qid: question2.id,
    nickname: input.nickname,
    ts,
    localDate,
    mode: input.mode,
    sessionId: input.sessionId === undefined ? null : input.sessionId,
    myAnswer,
    correct: verdict.correct,
    confidence,
    color,
    elapsedMs,
    bankVersion: typeof input.bankVersion === "string" ? input.bankVersion : "unknown",
    appVersion: typeof input.appVersion === "string" ? input.appVersion : cn_VERSION,
  };
  record.recordKey = rc_recordKey(record);
  return record;
}

// 逐题统计（学习统计明细用，与 9.6 的 masteryOfAttempts 配套）
export function rc_statsOfRecords(records) {
  const out = {
    attempts: 0,
    correct: 0,
    wrong: 0,
    guessedCorrect: 0,
    confidentCorrect: 0,
    firstTs: null,
    lastTs: null,
  };
  for (const r of records) {
    out.attempts += 1;
    if (r.correct) {
      out.correct += 1;
      if (r.confidence === "guessed") out.guessedCorrect += 1;
      else out.confidentCorrect += 1;
    } else {
      out.wrong += 1;
    }
    if (out.firstTs === null || r.ts < out.firstTs) out.firstTs = r.ts;
    if (out.lastTs === null || r.ts > out.lastTs) out.lastTs = r.ts;
  }
  return out;
}
