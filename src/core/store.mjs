// Store 形状、内存态与迁移（docs/需求规格.md 6.1 / 6.6 / 9.13）
import { cn_STORE_SCHEMA_VERSION, cn_TYPES, cn_VERSION } from "./constants.mjs";
import { tm_isoNow } from "./time.mjs";
import { rc_recordKey } from "./records.mjs";

export function sr_emptyStore() {
  return {
    meta: {
      schemaVersion: cn_STORE_SCHEMA_VERSION,
      appVersion: cn_VERSION,
      nickname: "",
      deviceId: "",
      createdAt: null,
      updatedAt: null,
    },
    records: [],
    wrongbook: {},
    overrides: { schemaVersion: cn_STORE_SCHEMA_VERSION, items: {} },
    sessions: [],
    imports: [],
  };
}

export function sr_newDeviceId() {
  const g = typeof globalThis !== "undefined" ? globalThis : {};
  let hex = "";
  if (g.crypto && typeof g.crypto.getRandomValues === "function") {
    const buf = new Uint8Array(4);
    g.crypto.getRandomValues(buf);
    for (const b of buf) hex += b.toString(16).padStart(2, "0");
  } else {
    for (let i = 0; i < 4; i += 1) hex += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
  }
  return "d-" + hex;
}

function sr_isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// CQP.migrateStore(raw) -> {store, migrated, error?}
export function sr_migrateStore(raw) {
  const empty = sr_emptyStore();
  if (raw === null || raw === undefined) return { store: empty, migrated: false };
  if (!sr_isObject(raw)) return { store: empty, migrated: false, error: { code: "E_STORE_SHAPE" } };
  const rawMeta = sr_isObject(raw.meta) ? raw.meta : null;
  if (rawMeta && typeof rawMeta.schemaVersion === "string" && rawMeta.schemaVersion.split(".")[0] !== "1") {
    return { store: sr_emptyStore(), migrated: false, error: { code: "E_VERSION" } };
  }

  const store = sr_emptyStore();
  let migrated = false;
  const meta = store.meta;
  if (rawMeta) {
    if (typeof rawMeta.schemaVersion === "string") meta.schemaVersion = rawMeta.schemaVersion;
    if (typeof rawMeta.appVersion === "string") meta.appVersion = rawMeta.appVersion;
    if (typeof rawMeta.nickname === "string") meta.nickname = rawMeta.nickname.slice(0, 20);
    if (typeof rawMeta.deviceId === "string") meta.deviceId = rawMeta.deviceId;
    if (typeof rawMeta.createdAt === "string") meta.createdAt = rawMeta.createdAt;
    if (typeof rawMeta.updatedAt === "string") meta.updatedAt = rawMeta.updatedAt;
    if (typeof rawMeta.schemaVersion !== "string" || typeof rawMeta.nickname !== "string") migrated = true;
  } else {
    migrated = true;
  }

  store.records = Array.isArray(raw.records) ? raw.records.filter((r) => sr_isObject(r)) : [];
  if (!Array.isArray(raw.records)) migrated = true;

  store.wrongbook = sr_isObject(raw.wrongbook) ? raw.wrongbook : {};
  for (const qid of Object.keys(store.wrongbook)) {
    const entry = store.wrongbook[qid];
    if (!sr_isObject(entry)) {
      delete store.wrongbook[qid];
      migrated = true;
      continue;
    }
    if (entry.state !== "active" && entry.state !== "removed") {
      entry.state = "active";
      migrated = true;
    }
    if (typeof entry.confidentStreak !== "number") entry.confidentStreak = 0;
    if (typeof entry.attemptsSinceAdd !== "number") entry.attemptsSinceAdd = 0;
    if (typeof entry.correctSinceAdd !== "number") entry.correctSinceAdd = 0;
  }

  if (sr_isObject(raw.overrides) && sr_isObject(raw.overrides.items)) {
    store.overrides.items = raw.overrides.items;
    for (const qid of Object.keys(store.overrides.items)) {
      const item = store.overrides.items[qid];
      if (!sr_isObject(item)) {
        delete store.overrides.items[qid];
        migrated = true;
        continue;
      }
      if (!Array.isArray(item.answer) || item.answer.length === 0) item.answer = null;
      item.tags = null;
      if (item.difficulty !== 1 && item.difficulty !== 2 && item.difficulty !== 3) item.difficulty = null;
      item.flagged = item.flagged === true;
      if (typeof item.note !== "string") item.note = "";
      if (!Number.isInteger(item.rev) || item.rev < 1) {
        item.rev = 1;
        migrated = true;
      }
      if (typeof item.updatedAt !== "string") item.updatedAt = tm_isoNow();
      if (typeof item.updatedBy !== "string") item.updatedBy = "";
    }
    if (typeof raw.overrides.schemaVersion !== "string") migrated = true;
  } else {
    migrated = true;
  }

  store.sessions = Array.isArray(raw.sessions) ? raw.sessions.filter((s) => sr_isObject(s)) : [];
  if (!Array.isArray(raw.sessions)) migrated = true;
  store.imports = Array.isArray(raw.imports) ? raw.imports.filter((s) => sr_isObject(s)) : [];
  if (!Array.isArray(raw.imports)) migrated = true;

  return { store, migrated };
}

let sr_memory = null;

// CQP.getStore()
export function sr_getStore() {
  if (sr_memory === null) sr_memory = sr_emptyStore();
  return sr_memory;
}

// CQP.setStore(store)
export function sr_setStore(store) {
  if (!store || typeof store !== "object") throw new TypeError("setStore(store): store must be an object");
  sr_memory = store;
  return sr_memory;
}

export function sr_resetMemoryStore() {
  sr_memory = null;
}

export function sr_clone(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

// 追加作答记录（同 recordKey 视为同一事实，跳过重复）
export function sr_appendRecord(store, record) {
  const key = rc_recordKey(record);
  const exists = store.records.some((r) => {
    try {
      return rc_recordKey(r) === key;
    } catch (err) {
      return false;
    }
  });
  if (exists) return { store, added: false };
  store.records.push(record);
  store.records.sort((a, b) => (a.ts === b.ts ? 0 : a.ts < b.ts ? -1 : 1));
  if (store.meta) store.meta.updatedAt = record.ts;
  return { store, added: true };
}

export function sr_appendSession(store, session) {
  if (!session || typeof session.sessionId !== "string") {
    throw new TypeError("appendSession(store, session): session.sessionId must be a string");
  }
  const idx = store.sessions.findIndex((s) => s && s.sessionId === session.sessionId);
  if (idx >= 0) {
    store.sessions[idx] = session;
    return { store, added: false };
  }
  store.sessions.push(session);
  return { store, added: true };
}

export function sr_touchMeta(store, patch, nowISO) {
  const now = nowISO === undefined || nowISO === null ? tm_isoNow() : nowISO;
  if (!store.meta || typeof store.meta !== "object") store.meta = sr_emptyStore().meta;
  if (patch && typeof patch === "object") {
    for (const key of Object.keys(patch)) store.meta[key] = patch[key];
  }
  if (typeof store.meta.nickname === "string" && store.meta.nickname.length > 20) {
    store.meta.nickname = store.meta.nickname.slice(0, 20);
  }
  if (!store.meta.deviceId) store.meta.deviceId = sr_newDeviceId();
  if (!store.meta.createdAt) store.meta.createdAt = now;
  store.meta.appVersion = cn_VERSION;
  store.meta.schemaVersion = cn_STORE_SCHEMA_VERSION;
  store.meta.updatedAt = now;
  return store;
}

export function sr_storeSize(store) {
  try {
    return JSON.stringify(store).length;
  } catch (err) {
    return 0;
  }
}

export function sr_recordsOfNickname(store, nickname) {
  if (!store || !Array.isArray(store.records)) return [];
  return store.records.filter((r) => r && r.nickname === nickname);
}

export function sr_isKnownType(type) {
  return cn_TYPES.indexOf(type) >= 0;
}
