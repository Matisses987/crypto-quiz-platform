// 服务端学习数据（user_stores）的合并语义。
//
// 离线单文件时代，学习数据只在 localStorage 里，冲突处理是「本地覆盖」。
// 服务端版是「一台设备一份副本 + 乐观锁 rev」：客户端提交 baseRev，若与
// 服务器当前 rev 不同就说明另一台设备先写过，此时必须走 mergeDocs 合并，
// 不能直接覆盖（否则另一台设备的记录会静默丢失）。
//
// 这里直接跑 server/ 的真实函数（:memory: 库），不起 HTTP 服务。
// Console output is English ASCII (repo convention); Chinese stays in comments.
import test from "node:test";
import assert from "node:assert/strict";
import { CQP } from "../src/core/index.mjs";
import { one, run, nowIso } from "../server/db.js";
import { readStore, writeStore, clearStore, importExport, resolveSlug } from "../server/routes-data.js";
import { mergeWrongbook, emptyDoc, normalizeDoc } from "../server/store-doc.js";
import { ensureServerSandbox, bankWithAnswers } from "./helpers/serverapp.mjs";

ensureServerSandbox();
const bank = bankWithAnswers();
const BANK_VERSION = bank.bankVersion;

let seq = 0;
function makeUser(nickname) {
  seq += 1;
  const username = "storeuser" + String(seq).padStart(3, "0");
  const res = run(
    "INSERT INTO users (username, pass_hash, display_name, role, disabled, created_at) VALUES (?, ?, ?, 'user', 0, ?)",
    username,
    "test-only-hash",
    nickname,
    nowIso()
  );
  return { id: res.lastId, username, displayName: nickname, role: "user" };
}

function questionsFor(qids) {
  return new Set(qids);
}

function mkRecord(question, nickname, nowISO, extra) {
  return CQP.makeRecord(
    Object.assign(
      {
        question,
        myAnswer: question.answer.slice(),
        confidence: "confident",
        elapsedMs: 1500,
        mode: "practice_chapter",
        nickname,
        bankVersion: BANK_VERSION,
        nowISO,
      },
      extra || {}
    )
  );
}

function pickQid(sectionType, n) {
  const list = bank.questions.filter((q) => q.sectionType === sectionType && q.answerStatus === "ok");
  return list[n % list.length];
}

/* ------------------------------------------------------------------ 乐观锁 */

test("server store: first write on an empty store is a plain write, not a merge", () => {
  const user = makeUser("小明");
  const before = readStore(user.id, "builtin");
  assert.equal(before.rev, 0, "no row yet => rev 0");
  assert.deepEqual(before.store.records, []);
  assert.equal(before.updatedAt, null);

  const question = pickQid("single", 0);
  const doc = CQP.emptyStore();
  doc.meta.nickname = "小明";
  doc.records = [mkRecord(question, "小明", "2026-10-05T10:00:00+08:00")];

  const out = writeStore(user.id, { baseRev: 0, bankSlug: "builtin", store: doc });
  assert.equal(out.merged, false, "baseRev matches => fast path");
  assert.equal(out.rev, 1, "rev bumps to 1");
  assert.equal(out.store.records.length, 1);
  assert.equal(out.store.meta.nickname, "小明");

  const after = readStore(user.id, "builtin");
  assert.equal(after.rev, 1);
  assert.equal(after.store.records.length, 1);
  assert.equal(after.store.records[0].qid, question.id);
});

test("server store: a stale baseRev merges instead of overwriting the other device's records", () => {
  const user = makeUser("小明");
  const q1 = pickQid("single", 1);
  const q2 = pickQid("judge", 1);

  // 设备 A：从 rev 0 写一条
  const docA = CQP.emptyStore();
  docA.meta.nickname = "小明";
  docA.meta.deviceId = "d-aaaaaaaa";
  docA.records = [mkRecord(q1, "小明", "2026-10-05T10:00:00+08:00")];
  const a = writeStore(user.id, { baseRev: 0, bankSlug: "builtin", store: docA });
  assert.equal(a.merged, false);
  assert.equal(a.rev, 1);

  // 设备 B 还停在 rev 0，写出自己的那一条
  const docB = CQP.emptyStore();
  docB.meta.nickname = "小明";
  docB.meta.deviceId = "d-bbbbbbbb";
  docB.records = [mkRecord(q2, "小明", "2026-10-05T10:05:00+08:00")];
  const b = writeStore(user.id, { baseRev: 0, bankSlug: "builtin", store: docB });

  assert.equal(b.merged, true, "stale baseRev must take the merge path");
  assert.equal(b.rev, 2, "rev still bumps once per accepted write");
  assert.equal(b.added.records, 1, "one record imported from device B");
  assert.ok(b.report, "merge path returns the full report");
  assert.equal(b.report.merged, true);
  assert.equal(b.store.records.length, 2, "both devices' records survive");
  const qids = b.store.records.map((r) => r.qid).sort();
  assert.deepEqual(qids, [q1.id, q2.id].sort());

  const after = readStore(user.id, "builtin");
  assert.equal(after.rev, 2);
  assert.equal(after.store.records.length, 2);
  assert.equal(after.store.meta.deviceId, "d-aaaaaaaa", "device id keeps the stored copy, not the incoming one");
});

test("server store: writing the same document twice is idempotent (no duplicate records)", () => {
  const user = makeUser("小明");
  const question = pickQid("single", 2);
  const doc = CQP.emptyStore();
  doc.meta.nickname = "小明";
  doc.records = [mkRecord(question, "小明", "2026-10-05T11:00:00+08:00")];

  const first = writeStore(user.id, { baseRev: 0, bankSlug: "builtin", store: doc });
  assert.equal(first.merged, false);
  assert.equal(first.store.records.length, 1);

  // 第二次故意用过期 baseRev，逼它走合并路径
  const second = writeStore(user.id, { baseRev: 0, bankSlug: "builtin", store: doc });
  assert.equal(second.merged, true);
  assert.equal(second.store.records.length, 1, "same recordKey => still one record");
  assert.equal(second.added.records, 0);
  assert.equal(second.report.duplicates, 1, "counted as a duplicate, not a new record");
  assert.equal(second.rev, 2);
});

/* -------------------------------------------------------------- 错题本 LWW */

test("server store: wrongbook keeps the newest entry per qid (LWW by last touch)", () => {
  const user = makeUser("小明");
  const qOld = pickQid("single", 3);
  const qNew = pickQid("single", 4);

  const base = CQP.emptyStore();
  base.wrongbook = {
    [qOld.id]: {
      addedAt: "2026-10-05T09:00:00+08:00",
      lastWrongAt: "2026-10-05T09:00:00+08:00",
      state: "active",
      confidentStreak: 0,
      attemptsSinceAdd: 1,
      correctSinceAdd: 0,
    },
  };
  const w0 = writeStore(user.id, { baseRev: 0, bankSlug: "builtin", store: base });
  assert.equal(w0.rev, 1);

  // 另一台设备把 qOld 手动移出（更晚），并新加 qNew
  const device = emptyDoc();
  device.wrongbook = {
    [qOld.id]: {
      addedAt: "2026-10-05T09:00:00+08:00",
      lastWrongAt: "2026-10-05T09:00:00+08:00",
      removedAt: "2026-10-05T12:00:00+08:00",
      removedReason: "manual",
      state: "removed",
      confidentStreak: 0,
      attemptsSinceAdd: 1,
      correctSinceAdd: 0,
    },
    [qNew.id]: {
      addedAt: "2026-10-05T12:30:00+08:00",
      lastWrongAt: "2026-10-05T12:30:00+08:00",
      state: "active",
      confidentStreak: 0,
      attemptsSinceAdd: 1,
      correctSinceAdd: 0,
    },
  };
  // records 为空 => 走只合错题本的短路分支
  const w1 = writeStore(user.id, { baseRev: 0, bankSlug: "builtin", store: device });
  assert.equal(w1.merged, true);
  assert.equal(w1.store.wrongbook[qOld.id].state, "removed", "newer removal wins");
  assert.equal(w1.store.wrongbook[qOld.id].removedReason, "manual");
  assert.equal(w1.store.wrongbook[qNew.id].state, "active", "new entry is added");

  // 反向再来一次：旧设备提交更早的 active 状态，不得复活
  const stale = emptyDoc();
  stale.wrongbook = {
    [qOld.id]: {
      addedAt: "2026-10-05T09:00:00+08:00",
      lastWrongAt: "2026-10-05T09:00:00+08:00",
      state: "active",
      confidentStreak: 0,
      attemptsSinceAdd: 1,
      correctSinceAdd: 0,
    },
  };
  const w2 = writeStore(user.id, { baseRev: 0, bankSlug: "builtin", store: stale });
  assert.equal(w2.store.wrongbook[qOld.id].state, "removed", "older active entry must not resurrect a removed one");
});

test("server store: mergeWrongbook breaks timestamp ties by confidentStreak", () => {
  const ts = "2026-10-05T12:00:00+08:00";
  const left = {
    "Q-C01-S-0001": { addedAt: ts, lastWrongAt: ts, state: "active", confidentStreak: 1, attemptsSinceAdd: 3, correctSinceAdd: 1 },
  };
  const right = {
    "Q-C01-S-0001": { addedAt: ts, lastWrongAt: ts, state: "active", confidentStreak: 2, attemptsSinceAdd: 4, correctSinceAdd: 2 },
  };
  const merged = mergeWrongbook(left, right);
  assert.equal(merged["Q-C01-S-0001"].confidentStreak, 2, "larger streak wins on a tie");
  assert.equal(merged["Q-C01-S-0001"].attemptsSinceAdd, 4, "the whole entry follows the streak, not per-field max");

  // 时间戳无法解析时同样退回 streak 比较
  const noTs = mergeWrongbook(
    { "Q-C01-S-0001": { state: "active", confidentStreak: 3 } },
    { "Q-C01-S-0001": { state: "active", confidentStreak: 0 } }
  );
  assert.equal(noTs["Q-C01-S-0001"].confidentStreak, 3, "no timestamps => keep the larger streak");
});

/* ------------------------------------------------------------ 题库间隔离 */

test("server store: different bank slugs never share records", () => {
  const user = makeUser("小明");
  const q1 = pickQid("single", 5);
  const q2 = pickQid("judge", 5);

  const docA = CQP.emptyStore();
  docA.meta.nickname = "小明";
  docA.records = [mkRecord(q1, "小明", "2026-10-05T10:00:00+08:00")];
  const a = writeStore(user.id, { baseRev: 0, bankSlug: "builtin", store: docA });
  assert.equal(a.bankSlug, "builtin");
  assert.equal(a.rev, 1);

  const docB = CQP.emptyStore();
  docB.meta.nickname = "小明";
  docB.records = [mkRecord(q2, "小明", "2026-10-05T10:00:00+08:00")];
  const b = writeStore(user.id, { baseRev: 0, bankSlug: "bank-b", store: docB });
  assert.equal(b.bankSlug, "bank-b");
  assert.equal(b.rev, 1, "a new slug starts its own rev counter");
  assert.equal(b.merged, false, "first write on a fresh slug is a plain write");

  const builtin = readStore(user.id, "builtin");
  const other = readStore(user.id, "bank-b");
  assert.equal(builtin.rev, 1);
  assert.equal(builtin.store.records.length, 1);
  assert.equal(builtin.store.records[0].qid, q1.id);
  assert.equal(other.rev, 1);
  assert.equal(other.store.records.length, 1);
  assert.equal(other.store.records[0].qid, q2.id);

  // 清空一个题库不影响另一个
  const cleared = clearStore(user.id, "builtin");
  assert.equal(cleared.rev, 2);
  assert.deepEqual(cleared.store.records, []);
  assert.equal(readStore(user.id, "bank-b").store.records.length, 1, "clearing builtin must not touch bank-b");
});

/* -------------------------------------------------------------- 导入接口 */

test("server store: importing an export file merges records and the wrongbook", () => {
  const user = makeUser("小明");
  const q1 = pickQid("single", 6);
  const q2 = pickQid("judge", 6);

  const local = CQP.emptyStore();
  local.meta.nickname = "小明";
  local.records = [mkRecord(q1, "小明", "2026-10-04T09:00:00+08:00", { myAnswer: ["Z"] , confidence: "guessed" })];
  writeStore(user.id, { baseRev: 0, bankSlug: "builtin", store: local });

  // 队友导出的文件：一条记录 + 一条错题本条目（旧版导出会带 wrongbook）
  const teammate = CQP.emptyStore();
  teammate.meta.nickname = "小红";
  teammate.meta.deviceId = "d-cccccccc";
  teammate.records = [
    mkRecord(q2, "小红", "2026-10-05T10:00:00+08:00", { myAnswer: ["Z"] }),
    mkRecord(q1, "小红", "2026-10-05T10:05:00+08:00", { myAnswer: ["Z"] }),
  ];
  teammate.wrongbook = {
    [q2.id]: {
      addedAt: "2026-10-05T10:00:00+08:00",
      lastWrongAt: "2026-10-05T10:00:00+08:00",
      state: "active",
      confidentStreak: 0,
      attemptsSinceAdd: 1,
      correctSinceAdd: 0,
    },
  };
  const payload = CQP.exportPayload({
    store: teammate,
    scope: "all",
    nickname: "小红",
    bankVersion: BANK_VERSION,
    nowISO: "2026-10-05T11:00:00+08:00",
  });
  payload.wrongbook = teammate.wrongbook;

  const out = importExport(user.id, { bankSlug: "builtin", payload, fileName: "team.json" });
  assert.equal(out.rev, 2);
  assert.equal(out.report.importedRecords, 2, "both teammate records are imported");
  assert.equal(out.report.duplicates, 0);
  assert.equal(out.report.wrongbookAdded, 1, "wrongbook from the file is merged, not dropped");
  assert.equal(out.store.records.length, 3, "local + 2 imported");
  assert.equal(out.store.wrongbook[q2.id].state, "active");
  assert.equal(out.store.imports.length, 1);
  assert.equal(out.store.imports[0].fileName, "team.json");

  const after = readStore(user.id, "builtin");
  assert.equal(after.rev, 2);
  assert.equal(after.store.records.length, 3);
});

test("server store: re-importing the same file adds nothing and reports duplicates", () => {
  const user = makeUser("小明");
  const q1 = pickQid("single", 7);
  const teammate = CQP.emptyStore();
  teammate.meta.nickname = "小红";
  teammate.records = [mkRecord(q1, "小红", "2026-10-05T10:00:00+08:00")];
  const payload = CQP.exportPayload({
    store: teammate,
    scope: "all",
    nickname: "小红",
    bankVersion: BANK_VERSION,
    nowISO: "2026-10-05T11:00:00+08:00",
  });

  const first = importExport(user.id, { bankSlug: "builtin", payload, fileName: "team.json" });
  assert.equal(first.report.importedRecords, 1);
  assert.equal(first.report.duplicates, 0);

  const second = importExport(user.id, { bankSlug: "builtin", payload, fileName: "team.json" });
  assert.equal(second.report.importedRecords, 0, "nothing new on the second import");
  assert.equal(second.report.duplicates, 1, "the record is reported as a duplicate");
  assert.equal(second.store.records.length, 1, "records do not double");
  assert.equal(second.store.imports.length, 1, "the import log entry is deduped by fileName+importedAt");
  assert.equal(second.rev, 2, "rev still advances (the write happened)");
});

/* ------------------------------------------------------------------ 护栏 */

test("server store: bad input is rejected with the documented messages", () => {
  const user = makeUser("小明");
  assert.throws(() => writeStore(user.id, { baseRev: 0, bankSlug: "builtin", store: null }), /store 必须是对象/);
  assert.throws(() => writeStore(user.id, { baseRev: 0, bankSlug: "builtin", store: "nope" }), /store 必须是对象/);
  assert.throws(() => resolveSlug("bad slug!"), /题库标识不合法/);
  assert.throws(
    () => writeStore(user.id, { baseRev: 0, bankSlug: "builtin", store: { records: [], pad: "x".repeat(9 * 1024 * 1024) } }),
    /学习数据过大/
  );
  // 被拒的写入不留痕迹
  assert.equal(readStore(user.id, "builtin").rev, 0);
});

test("server store: readStore on an unknown user returns the empty document", () => {
  const ghost = readStore(999999, "builtin");
  assert.equal(ghost.rev, 0);
  assert.equal(ghost.updatedAt, null);
  const empty = emptyDoc();
  assert.deepEqual(Object.keys(ghost.store).sort(), Object.keys(empty).sort());
  assert.deepEqual(ghost.store.records, []);
  assert.equal(ghost.store.meta.nickname, "");
  assert.deepEqual(normalizeDoc(null).records, []);
});

test("server store: questions filter drops unknown qids and reports them", () => {
  const user = makeUser("小明");
  const q1 = pickQid("single", 8);
  const ghostQid = "Q-C01-S-0099"; // 形状合法但题库里没有（真·未知 qid）

  const doc = CQP.emptyStore();
  doc.meta.nickname = "小明";
  doc.records = [
    mkRecord(q1, "小明", "2026-10-05T10:00:00+08:00"),
    CQP.makeRecord({
      question: Object.assign({}, q1, { id: ghostQid }),
      myAnswer: q1.answer.slice(),
      confidence: "confident",
      elapsedMs: 1000,
      mode: "practice_chapter",
      nickname: "小明",
      bankVersion: BANK_VERSION,
      nowISO: "2026-10-05T10:01:00+08:00",
    }),
  ];

  // baseRev 故意过期 => 合并分支才做未知 qid 过滤
  writeStore(user.id, { baseRev: 0, bankSlug: "builtin", store: CQP.emptyStore() });
  const out = writeStore(user.id, { baseRev: 0, bankSlug: "builtin", store: doc });
  assert.equal(out.merged, true);
  const kept = out.store.records.map((r) => r.qid);
  assert.ok(kept.indexOf(q1.id) >= 0, "known qid is kept");
  assert.equal(kept.indexOf(ghostQid), -1, "unknown qid is filtered out");
  assert.equal(out.report.unknownQids.length, 1, "unknown qid is reported");
  assert.equal(out.report.unknownQids[0].qid, ghostQid);
  assert.ok(questionsFor([q1.id]).has(q1.id));
});

test("server store: rev and updatedAt are persisted on the row itself", () => {
  const user = makeUser("小明");
  const doc = CQP.emptyStore();
  doc.meta.nickname = "小明";
  writeStore(user.id, { baseRev: 0, bankSlug: "builtin", store: doc });
  const row = one("SELECT rev, updated_at, doc FROM user_stores WHERE user_id = ? AND bank_slug = ?", user.id, "builtin");
  assert.ok(row, "row exists after the first write");
  assert.equal(row.rev, 1);
  assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/, "stored timestamp keeps the local offset");
  assert.equal(JSON.parse(row.doc).meta.nickname, "小明");
});
