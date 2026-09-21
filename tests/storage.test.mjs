// Storage adapter and store migration: docs/需求规格.md 4.1 / 6.6 / 9.13.
import test from "node:test";
import assert from "node:assert/strict";
import { CQP } from "../src/core/index.mjs";

function memoryBackend(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    map,
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    get length() { return map.size; },
    key(index) { return Array.from(map.keys())[index]; },
  };
}

function useBackend(backend) {
  CQP.__test.setStorageBackend(backend);
  CQP.__test.resetMemoryStore();
}

test("storage round-trips a store through the backend", () => {
  const backend = memoryBackend();
  useBackend(backend);
  const store = CQP.emptyStore();
  store.meta.nickname = "小明";
  store.records = [CQP.__test.makeRecord({ nickname: "小明", correct: false, myAnswer: ["B"] })];
  store.wrongbook = CQP.wrongbookApply({}, store.records[0], "2026-10-05T21:00:00+08:00").book;
  const saved = CQP.storage.save(store);
  assert.equal(saved.ok, true);
  assert.deepEqual(CQP.storage.keys().sort(), Object.values(CQP.STORAGE_KEYS).sort());
  const loaded = CQP.storage.load();
  assert.equal(loaded.meta.nickname, "小明");
  assert.equal(loaded.records.length, 1);
  assert.equal(Object.keys(loaded.wrongbook).length, 1);
  assert.equal(loaded.wrongbook["Q-C01-S-0001"].state, "active");
  assert.equal(CQP.storage.probe().available, true);
});

test("storage.load returns an empty store when nothing is stored", () => {
  useBackend(memoryBackend());
  const loaded = CQP.storage.load();
  assert.equal(loaded.records.length, 0);
  assert.deepEqual(loaded.wrongbook, {});
  assert.equal(loaded.overrides.items && Object.keys(loaded.overrides.items).length, 0);
  assert.deepEqual(loaded.meta, CQP.emptyStore().meta);
});

test("storage.load raises E_STORE_PARSE on corrupted JSON", () => {
  useBackend(memoryBackend({ "cqp.v1.records": "{not json" }));
  assert.throws(
    () => CQP.storage.load(),
    (err) => err.code === "E_STORE_PARSE" && typeof err.message === "string"
  );
});

test("storage.load raises E_VERSION for an incompatible major version", () => {
  useBackend(memoryBackend({ "cqp.v1.meta": JSON.stringify({ schemaVersion: "2.0.0", nickname: "小明" }) }));
  assert.throws(() => CQP.storage.load(), (err) => err.code === "E_VERSION");
});

test("storage.save reports E_QUOTA without touching other keys", () => {
  const backend = memoryBackend();
  const original = backend.setItem;
  backend.setItem = function (key, value) {
    if (key === CQP.STORAGE_KEYS.records) {
      const error = new Error("quota");
      error.name = "QuotaExceededError";
      error.code = 22;
      throw error;
    }
    return original.call(backend, key, value);
  };
  useBackend(backend);
  const store = CQP.emptyStore();
  store.records = [CQP.__test.makeRecord()];
  const result = CQP.storage.save(store);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "E_QUOTA");
  assert.equal(backend.getItem(CQP.STORAGE_KEYS.records), null);
  assert.ok(backend.getItem(CQP.STORAGE_KEYS.meta), "earlier keys were written before the failure");
});

test("storage.save reports E_DENIED for a generic failure", () => {
  const backend = memoryBackend();
  backend.setItem = function () { throw new Error("denied"); };
  useBackend(backend);
  const result = CQP.storage.save(CQP.emptyStore());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "E_DENIED");
  assert.equal(CQP.storage.probe().available, false);
});

test("storage.save reports E_DENIED when no backend exists", () => {
  CQP.__test.setStorageBackend(null);
  CQP.__test.resetMemoryStore();
  const result = CQP.storage.save(CQP.emptyStore());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "E_DENIED");
});

test("storage.reset clears only cqp.v1 keys", () => {
  const backend = memoryBackend({ "other.key": "keep me" });
  useBackend(backend);
  CQP.storage.save(CQP.emptyStore());
  CQP.storage.reset();
  assert.equal(backend.getItem("other.key"), "keep me");
  assert.equal(CQP.storage.keys().length, 0);
});

test("migrateStore fills defaults for 1.x data", () => {
  const raw = {
    meta: { schemaVersion: "1.0.0", nickname: "小明" },
    records: [{ qid: "Q-C01-S-0001", nickname: "小明", ts: "2026-10-05T10:00:00+08:00" }],
    wrongbook: { "Q-C01-S-0001": { addedAt: "2026-10-05T10:00:00+08:00" } },
  };
  const result = CQP.migrateStore(raw);
  assert.equal(result.migrated, true);
  assert.equal(result.store.meta.nickname, "小明");
  assert.equal(result.store.records.length, 1);
  assert.equal(result.store.wrongbook["Q-C01-S-0001"].state, "active");
  assert.equal(result.store.wrongbook["Q-C01-S-0001"].confidentStreak, 0);
  assert.equal(result.store.wrongbook["Q-C01-S-0001"].attemptsSinceAdd, 0);
  assert.deepEqual(result.store.overrides.items, {});
  assert.deepEqual(result.store.sessions, []);
});

test("migrateStore refuses an incompatible major version", () => {
  const result = CQP.migrateStore({ meta: { schemaVersion: "3.0.0" } });
  assert.equal(result.error.code, "E_VERSION");
  assert.equal(result.store.records.length, 0);
});

test("memory store helpers keep records unique and sorted", () => {
  CQP.__test.resetMemoryStore();
  const store = CQP.getStore();
  const first = CQP.__test.makeRecord({ ts: "2026-10-05T12:00:00+08:00" });
  const second = CQP.__test.makeRecord({ ts: "2026-10-05T11:00:00+08:00", qid: "Q-C01-S-0002" });
  assert.equal(CQP.appendRecord(store, first).added, true);
  assert.equal(CQP.appendRecord(store, second).added, true);
  assert.equal(CQP.appendRecord(store, first).added, false, "same recordKey is the same fact");
  assert.deepEqual(store.records.map((r) => r.ts), ["2026-10-05T11:00:00+08:00", "2026-10-05T12:00:00+08:00"]);
  CQP.touchMeta(store, { nickname: "小明" }, "2026-10-05T12:00:00+08:00");
  assert.equal(store.meta.nickname, "小明");
  assert.match(store.meta.deviceId, /^d-[0-9a-f]{8}$/);
  assert.equal(store.meta.createdAt, "2026-10-05T12:00:00+08:00");
  const session = { sessionId: "mock-1", submittedAt: "2026-10-05T20:00:00+08:00" };
  assert.equal(CQP.appendSession(store, session).added, true);
  assert.equal(CQP.appendSession(store, { ...session, submittedAt: "2026-10-05T21:00:00+08:00" }).added, false);
  assert.equal(store.sessions.length, 1);
  assert.equal(store.sessions[0].submittedAt, "2026-10-05T21:00:00+08:00");
  CQP.setStore(store);
  assert.equal(CQP.getStore().records.length, 2);
  assert.throws(() => CQP.setStore(null), TypeError);
  assert.ok(CQP.storeSize(store) > 100);
});
