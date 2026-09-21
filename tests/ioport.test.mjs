// Export / import / merge / team statistics: docs/需求规格.md 7.x, 8.5, 8.6, 9.12.
import test from "node:test";
import assert from "node:assert/strict";
import { CQP } from "../src/core/index.mjs";

const mkQ = CQP.__test.makeQuestion;
const mkR = CQP.__test.makeRecord;

function bankOf(ids) {
  return {
    schemaVersion: "1.0.0",
    bankVersion: "fixture-1",
    generatedAt: "2026-09-16T20:00:00+08:00",
    source: { fileName: "密码赛题库.pdf", pages: 199, theoryBlocks: ids.length, printedQuestions: ids.length, excludedCount: 12, excludedReason: "x" },
    chapters: [],
    questions: ids.map((id, index) => {
      const chapter = id.slice(2, 5);
      const code = id.slice(6, 7);
      const type = { S: "single", M: "multiple", J: "judge", F: "blank" }[code];
      const answer = type === "judge" ? ["对"] : type === "blank" ? ["SM4"] : type === "multiple" ? ["A", "B"] : ["A"];
      return mkQ({ id, chapterCode: chapter, sectionType: type, seq: index + 1, answer });
    }),
  };
}

const BANK = bankOf(["Q-C01-S-0001", "Q-C01-M-0001", "Q-C01-J-0001", "Q-C05-S-0001", "Q-C05-F-0001"]);

function emptyStore() {
  return CQP.emptyStore();
}

function withRecords(records) {
  const store = emptyStore();
  store.meta.nickname = "小明";
  store.meta.deviceId = "d-7f3a91c2";
  store.records = records;
  return store;
}

function rec(qid, overrides) {
  return mkR(Object.assign({ qid }, overrides || {}));
}

test("exportFileName follows the frozen pattern", () => {
  const nowISO = "2026-10-06T22:30:15+08:00";
  const expectedStamp = CQP.localStamp(new Date(Date.parse(nowISO)));
  assert.equal(
    CQP.exportFileName({ nickname: "小明", scope: "day", from: "2026-10-06", to: null, nowISO }),
    "密码赛学习记录_小明_单日2026-10-06_" + expectedStamp + ".json"
  );
  assert.equal(
    CQP.exportFileName({ nickname: "小明", scope: "range", from: "2026-10-04", to: "2026-10-06", nowISO }),
    "密码赛学习记录_小明_2026-10-04至2026-10-06_" + expectedStamp + ".json"
  );
  assert.equal(
    CQP.exportFileName({ nickname: "小明", scope: "all", from: null, to: null, nowISO }),
    "密码赛学习记录_小明_全部_" + expectedStamp + ".json"
  );
  assert.equal(
    CQP.exportFileName({ nickname: 'a/b:c*d?e"f<g>h|i\\jklmnopqrstuvwxyz', scope: "all", nowISO }),
    "密码赛学习记录_a_b_c_d_e_f_g_h_i_jk_全部_" + expectedStamp + ".json",
    "invalid characters become _ and the nickname is truncated to 20 characters"
  );
  assert.throws(() => CQP.exportFileName({ nickname: "小明", scope: "week" }), TypeError);
});

test("exportPayload filters by local natural day (T-07-01)", () => {
  const store = withRecords([
    rec("Q-C01-S-0001", { ts: "2026-10-04T23:59:59+08:00", localDate: "2026-10-04" }),
    rec("Q-C01-S-0001", { ts: "2026-10-05T00:00:01+08:00", localDate: "2026-10-05", myAnswer: ["B"] }),
    rec("Q-C01-S-0001", { ts: "2026-10-05T23:59:59+08:00", localDate: "2026-10-05" }),
    rec("Q-C01-S-0001", { ts: "2026-10-06T09:00:00+08:00", localDate: "2026-10-06" }),
    rec("Q-C01-S-0001", { ts: "2026-10-06T10:00:00+08:00", localDate: "2026-10-06" }),
    rec("Q-C01-S-0001", { ts: "2026-10-06T11:00:00+08:00", localDate: "2026-10-06" }),
  ]);
  store.overrides = CQP.setOverride(store.overrides, "Q-C05-F-0001", { answer: ["16"], updatedBy: "小明" });

  const day = CQP.exportPayload({ store, scope: "day", from: "2026-10-05", nickname: "小明", nowISO: "2026-10-06T22:30:15+08:00" });
  assert.equal(day.kind, "cqp-export");
  assert.equal(day.schemaVersion, "1.0.0");
  assert.equal(day.range.scope, "day");
  assert.equal(day.range.from, "2026-10-05");
  assert.equal(day.range.to, "2026-10-05");
  assert.equal(day.counts.records, 2);
  assert.equal(day.records.length, 2);
  assert.ok(day.records.every((r) => r.localDate === "2026-10-05"));
  assert.equal(day.counts.overrides, 1, "overlay is exported in full regardless of date");
  assert.equal(day.exportedBy.nickname, "小明");
  assert.equal(day.exportedBy.deviceId, "d-7f3a91c2");

  const range = CQP.exportPayload({ store, scope: "range", from: "2026-10-04", to: "2026-10-06", nickname: "小明" });
  assert.equal(range.counts.records, 6);
  const all = CQP.exportPayload({ store, scope: "all", nickname: "小明" });
  assert.equal(all.counts.records, 6);
  assert.equal(all.range.from, null);
  assert.equal(all.range.to, null);
  assert.throws(() => CQP.exportPayload({ store, scope: "range", from: "2026-10-06", to: "2026-10-05", nickname: "小明" }), RangeError);
  assert.throws(() => CQP.exportPayload({ store, scope: "day", from: "2026-10-05", nickname: " " }), TypeError);
});

test("exportPayload filters mock sessions by submission day", () => {
  const store = withRecords([]);
  store.sessions = [
    { sessionId: "mock-a", nickname: "小明", submittedAt: "2026-10-05T20:00:00+08:00", result: { score: 70 } },
    { sessionId: "mock-b", nickname: "小明", submittedAt: "2026-10-06T20:00:00+08:00", result: { score: 80 } },
  ];
  const day = CQP.exportPayload({ store, scope: "day", from: "2026-10-05", nickname: "小明" });
  assert.equal(day.counts.sessions, 1);
  assert.equal(day.mockSessions[0].sessionId, "mock-a");
  const all = CQP.exportPayload({ store, scope: "all", nickname: "小明" });
  assert.equal(all.counts.sessions, 2);
});

test("validateImport rejects hard errors with frozen codes (T-07-03)", () => {
  const store = withRecords([rec("Q-C01-S-0001")]);
  const before = JSON.stringify(store);
  const good = CQP.exportPayload({ store, scope: "all", nickname: "小明" });

  assert.equal(CQP.validateImport("not json at all").errors[0].code, "E_PARSE");
  assert.equal(CQP.validateImport("").errors[0].code, "E_PARSE");
  assert.equal(CQP.validateImport('{"kind":"other"}').errors[0].code, "E_KIND");
  const badVersion = JSON.parse(JSON.stringify(good));
  badVersion.schemaVersion = "2.0.0";
  assert.equal(CQP.validateImport(badVersion).errors[0].code, "E_VERSION");
  const badSchema = JSON.parse(JSON.stringify(good));
  delete badSchema.counts;
  assert.equal(CQP.validateImport(badSchema).errors[0].code, "E_SCHEMA");
  const badCounts = JSON.parse(JSON.stringify(good));
  badCounts.counts.records = 99;
  assert.equal(CQP.validateImport(badCounts).errors[0].code, "E_COUNTS");

  assert.equal(JSON.stringify(store), before, "local store untouched by validation");
  const ok = CQP.validateImport(good);
  assert.equal(ok.ok, true);
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.payload.kind, "cqp-export");
});

test("mergeImport skips malformed records and repairs localDate (T-07-04)", () => {
  const store = withRecords([]);
  const payload = CQP.exportPayload({ store, scope: "all", nickname: "小明" });
  payload.records = [
    { qid: "Q-C01-S-0001", nickname: "小明", ts: "nope", localDate: "2026-10-05", myAnswer: ["A"], correct: true, confidence: "confident" },
    { qid: "Q-C01-S-0001", nickname: "小明", ts: "2026-10-05T10:00:00+08:00", localDate: "2026-10-05", myAnswer: "A", correct: true, confidence: "confident" },
    { qid: "Q-C01-S-0001", nickname: "小明", ts: "2026-10-05T11:00:00+08:00", localDate: "2026-01-01", myAnswer: ["A"], correct: true, confidence: "confident" },
    { qid: "Q-C99-S-0001", nickname: "小明", ts: "2026-10-05T12:00:00+08:00", localDate: "2026-10-05", myAnswer: ["A"], correct: true, confidence: "confident" },
    { qid: "Q-C01-S-0001", nickname: "小红", ts: "2026-10-05T13:00:00+08:00", localDate: "2026-10-05", myAnswer: ["A"], correct: false, confidence: "guessed", bankVersion: "old-1" },
  ];
  payload.counts.records = payload.records.length;
  const target = withRecords([]);
  const merged = CQP.mergeImport({ store: target, payload, questions: BANK.questions, bankVersion: "fixture-1" });
  assert.equal(merged.report.ok, true);
  assert.equal(merged.report.skipped.length, 2);
  assert.equal(merged.report.skipped[0].reason, "bad_ts");
  assert.equal(merged.report.skipped[1].reason, "bad_myAnswer");
  assert.equal(merged.report.importedRecords, 2);
  assert.equal(merged.report.repaired.length, 1);
  assert.equal(merged.report.repaired[0].from, "2026-01-01");
  assert.equal(merged.report.repaired[0].to, "2026-10-05");
  assert.equal(merged.report.unknownQids.length, 1);
  assert.equal(merged.report.unknownQids[0].qid, "Q-C99-S-0001");
  assert.equal(merged.report.versionMismatch.length, 1);
  assert.equal(merged.store.records.length, 2);
  assert.ok(!merged.store.records.some((r) => r.qid === "Q-C99-S-0001"), "unknown qids are not stored");
  assert.equal(merged.store.records[0].localDate, "2026-10-05");
  assert.equal(merged.store.records[1].nickname, "小红");
  assert.deepEqual(merged.report.nicknames, ["小红", "小明"]);
});

test("mergeImport de-duplicates repeated imports (T-07-05, D9 core assertion)", () => {
  const source = withRecords([
    rec("Q-C01-S-0001", { ts: "2026-10-05T10:00:00+08:00" }),
    rec("Q-C01-M-0001", { ts: "2026-10-05T10:01:00+08:00", myAnswer: ["A", "B"] }),
    rec("Q-C01-J-0001", { ts: "2026-10-05T10:02:00+08:00", myAnswer: ["对"] }),
  ]);
  source.meta.nickname = "小红";
  const payload = CQP.exportPayload({ store: source, scope: "all", nickname: "小红" });
  let store = withRecords([]);
  const first = CQP.mergeImport({ store, payload, questions: BANK.questions, fileName: "a.json" });
  assert.equal(first.report.importedRecords, 3);
  assert.equal(first.store.records.length, 3);
  store = first.store;
  const second = CQP.mergeImport({ store, payload, questions: BANK.questions, fileName: "a.json" });
  assert.equal(second.report.importedRecords, 0);
  assert.equal(second.report.duplicates, 3);
  assert.equal(second.store.records.length, 3);
  const third = CQP.mergeImport({ store: second.store, payload, questions: BANK.questions });
  assert.equal(third.store.records.length, 3);
  assert.equal(third.store.imports.length, 2, "import ledger records both attempts");
  assert.equal(third.store.imports[0].fileName, "a.json");
  assert.equal(third.store.imports[0].importedRecords, 3);

  const duplicatedInFile = JSON.parse(JSON.stringify(payload));
  duplicatedInFile.records = [payload.records[0], payload.records[0], payload.records[1]];
  duplicatedInFile.counts.records = 3;
  const inFile = CQP.mergeImport({ store: withRecords([]), payload: duplicatedInFile, questions: BANK.questions });
  assert.equal(inFile.report.importedRecords, 2);
  assert.equal(inFile.report.duplicatesInFile, 1);
});

test("mergeImport merges the overlay last-write-wins (T-07-06)", () => {
  const localOverlay = CQP.setOverride(CQP.emptyStore().overrides, "Q-C05-F-0001", {
    answer: ["16"],
    updatedBy: "小明",
    nowISO: "2026-10-06T09:00:00+08:00",
  });
  const incomingNewer = CQP.setOverride(CQP.emptyStore().overrides, "Q-C05-F-0001", {
    answer: ["16 块"],
    updatedBy: "小红",
    nowISO: "2026-10-06T10:00:00+08:00",
  });
  const store = withRecords([]);
  store.overrides = localOverlay;
  const payload = CQP.exportPayload({ store: withRecords([]), scope: "all", nickname: "小红" });
  payload.overrides = incomingNewer;
  payload.counts.overrides = 1;

  const newer = CQP.mergeImport({ store, payload, questions: BANK.questions });
  assert.equal(newer.report.overridesApplied, 1);
  assert.deepEqual(newer.store.overrides.items["Q-C05-F-0001"].answer, ["16 块"]);
  assert.equal(newer.store.overrides.items["Q-C05-F-0001"].updatedBy, "小红");

  const older = CQP.mergeImport({ store: newer.store, payload: { ...payload, overrides: localOverlay }, questions: BANK.questions });
  assert.equal(older.report.overridesKept, 1);
  assert.deepEqual(older.store.overrides.items["Q-C05-F-0001"].answer, ["16 块"], "older overlay is discarded");
});

test("mergeImport merges overlay ties by updatedBy and de-duplicates sessions", () => {
  const store = withRecords([]);
  store.overrides = CQP.setOverride(CQP.emptyStore().overrides, "Q-C05-F-0001", {
    answer: ["A"],
    updatedBy: "abc",
    nowISO: "2026-10-06T09:00:00+08:00",
  });
  const payload = CQP.exportPayload({ store: withRecords([]), scope: "all", nickname: "小明" });
  payload.overrides = CQP.setOverride(CQP.emptyStore().overrides, "Q-C05-F-0001", {
    answer: ["B"],
    updatedBy: "abd",
    nowISO: "2026-10-06T09:00:00+08:00",
  });
  payload.counts.overrides = 1;
  payload.mockSessions = [
    { sessionId: "mock-1", nickname: "小明", submittedAt: "2026-10-06T20:00:00+08:00", result: { score: 70 } },
    { sessionId: "mock-1", nickname: "小明", submittedAt: "2026-10-06T20:00:00+08:00", result: { score: 70 } },
  ];
  payload.counts.sessions = 2;
  const merged = CQP.mergeImport({ store, payload, questions: BANK.questions });
  assert.equal(merged.report.overridesApplied, 1);
  assert.deepEqual(merged.store.overrides.items["Q-C05-F-0001"].answer, ["B"]);
  assert.equal(merged.report.sessionsImported, 1);
  const again = CQP.mergeImport({ store: merged.store, payload, questions: BANK.questions });
  assert.equal(again.report.sessionsImported, 0);
  assert.equal(again.store.sessions.length, 1);
});

test("personalStats reports counts, accuracy, mastery and wrong questions (T-08-12)", () => {
  const records = [
    rec("Q-C01-S-0001", { nickname: "小明", ts: "2026-10-05T10:00:00+08:00", correct: false, myAnswer: ["B"] }),
    rec("Q-C01-S-0001", { nickname: "小明", ts: "2026-10-05T10:01:00+08:00", correct: true, confidence: "guessed" }),
    rec("Q-C01-M-0001", { nickname: "小明", ts: "2026-10-05T10:02:00+08:00", correct: false, myAnswer: ["A"] }),
    rec("Q-C01-M-0001", { nickname: "小明", ts: "2026-10-05T10:03:00+08:00", correct: false, myAnswer: ["C"] }),
    rec("Q-C01-M-0001", { nickname: "小明", ts: "2026-10-05T10:04:00+08:00", correct: false, myAnswer: ["D"] }),
    rec("Q-C01-J-0001", { nickname: "小红", ts: "2026-10-05T11:00:00+08:00", correct: false, myAnswer: ["错"] }),
  ];
  const stats = CQP.personalStats({ records, questions: BANK.questions, nickname: "小明" });
  assert.equal(stats.answered, 5);
  assert.equal(stats.correct, 1);
  assert.equal(stats.wrong, 4);
  assert.equal(stats.guessedCorrect, 1);
  assert.equal(stats.accuracy, 20);
  assert.equal(stats.mastery.attempts, 5);
  assert.equal(stats.mastery.index, 10);
  assert.equal(stats.mastery.insufficient, false);
  assert.equal(stats.wrongQuestions.length, 2);
  assert.equal(stats.wrongQuestions[0].qid, "Q-C01-M-0001", "three wrongs come first");
  assert.equal(stats.wrongQuestions[1].qid, "Q-C01-S-0001");
  assert.equal(stats.wrongQuestions[0].wrongCount, 3);
  assert.equal(stats.byType.single.answered, 2);
  assert.equal(stats.byChapter.C01.answered, 5);
  const other = CQP.personalStats({ records, questions: BANK.questions, nickname: "小红" });
  assert.equal(other.wrongQuestions.length, 1);
  assert.equal(other.mastery.insufficient, true);
});

test("teamStats lists team wrong questions with 2+ distinct wrong users (T-08-09/10/11)", () => {
  const records = [
    rec("Q-C01-M-0001", { nickname: "小明", ts: "2026-10-05T10:00:00+08:00", correct: false, myAnswer: ["A"] }),
    rec("Q-C01-M-0001", { nickname: "小明", ts: "2026-10-05T10:01:00+08:00", correct: false, myAnswer: ["B"] }),
    rec("Q-C01-M-0001", { nickname: "小明", ts: "2026-10-05T10:02:00+08:00", correct: false, myAnswer: ["C"] }),
    rec("Q-C01-M-0001", { nickname: "小红", ts: "2026-10-05T10:03:00+08:00", correct: false, myAnswer: ["D"] }),
    rec("Q-C01-M-0001", { nickname: "小刚", ts: "2026-10-05T10:04:00+08:00", correct: true, myAnswer: ["A", "B"] }),
    rec("Q-C01-S-0001", { nickname: "小明", ts: "2026-10-05T10:05:00+08:00", correct: false, myAnswer: ["B"] }),
    rec("Q-C05-S-0001", { nickname: "小红", ts: "2026-10-05T10:06:00+08:00", correct: false, myAnswer: ["B"] }),
    rec("Q-C05-S-0001", { nickname: "小红", ts: "2026-10-05T10:07:00+08:00", correct: true, myAnswer: ["A"] }),
  ];
  const stats = CQP.teamStats({ records, questions: BANK.questions });
  assert.equal(stats.minWrongUsers, 2);
  assert.equal(stats.teamWrongQuestions.length, 1);
  const row = stats.teamWrongQuestions[0];
  assert.equal(row.qid, "Q-C01-M-0001");
  assert.equal(row.wrongUsers, 2);
  assert.deepEqual(row.wrongUserNames, ["小红", "小明"]);
  assert.equal(row.wrongCount, 4);
  assert.equal(row.answeredUsers, 3);
  assert.equal(row.wrongRate, 66.7);
  assert.equal(row.insufficient, false);
  const memberNames = stats.members.map((m) => m.nickname);
  assert.deepEqual(memberNames, ["小刚", "小红", "小明"]);
  const xiaoming = stats.members.filter((m) => m.nickname === "小明")[0];
  assert.equal(xiaoming.answered, 4);
  assert.equal(xiaoming.wrongQuestionCount, 2);
  assert.equal(xiaoming.correct, 0);
  const matrixRow = stats.matrix[0];
  assert.equal(matrixRow.qid, "Q-C01-M-0001");
  assert.deepEqual(
    matrixRow.cells.map((c) => c.nickname + ":" + c.cell),
    ["小刚:对", "小红:错", "小明:错"]
  );
});

test("teamStats sorts by wrongUsers then wrongCount then qid (T-08-11)", () => {
  const records = [];
  const push = (qid, nickname, times, correct) => {
    for (let i = 0; i < times; i += 1) {
      records.push(
        rec(qid, {
          nickname,
          ts: "2026-10-05T10:0" + (i % 9) + ":00+08:00",
          correct,
          myAnswer: correct ? ["A"] : ["B"],
        })
      );
    }
  };
  push("Q-C01-S-0001", "小明", 1, false);
  push("Q-C01-S-0001", "小红", 1, false);
  push("Q-C01-S-0001", "小刚", 1, false);
  push("Q-C01-M-0001", "小明", 5, false);
  push("Q-C01-M-0001", "小红", 1, false);
  push("Q-C01-J-0001", "小明", 2, false);
  push("Q-C01-J-0001", "小红", 2, false);
  const stats = CQP.teamStats({ records, questions: BANK.questions });
  assert.deepEqual(stats.teamWrongQuestions.map((r) => r.qid), ["Q-C01-S-0001", "Q-C01-M-0001", "Q-C01-J-0001"]);
  assert.deepEqual(stats.teamWrongQuestions.map((r) => r.wrongUsers), [3, 2, 2]);
  assert.deepEqual(stats.teamWrongQuestions.map((r) => r.wrongCount), [3, 6, 4]);
  const withThreshold3 = CQP.teamStats({ records, questions: BANK.questions, minWrongUsers: 3 });
  assert.equal(withThreshold3.teamWrongQuestions.length, 1);
});

test("personalStats counts mock sessions for the nickname", () => {
  const records = [rec("Q-C01-S-0001", { nickname: "小明", ts: "2026-10-05T10:00:00+08:00" })];
  const sessions = [
    { sessionId: "m1", nickname: "小明", submittedAt: "2026-10-05T20:00:00+08:00", result: { score: 70 } },
    { sessionId: "m2", nickname: "小明", submittedAt: "2026-10-05T21:00:00+08:00", result: { score: 88 } },
    { sessionId: "m3", nickname: "小红", submittedAt: "2026-10-05T21:00:00+08:00", result: { score: 99 } },
  ];
  const stats = CQP.personalStats({ records, questions: BANK.questions, nickname: "小明", sessions });
  assert.equal(stats.mockBest, 88);
  assert.equal(stats.mockCount, 2);
  const none = CQP.personalStats({ records, questions: BANK.questions, nickname: "小刚", sessions });
  assert.equal(none.mockBest, null);
  assert.equal(none.mockCount, 0);
});
