// 个人学习文档（CQP store）的服务端权威副本：归一化、合并、去重
// 设计见 docs/服务器版改造计划.md §4.2 / §4.3
import { CQP } from "../src/core/index.mjs";

const STORE_SCHEMA_VERSION = "1.0.0";
const EXPORT_KIND = "cqp-export";
const EXPORT_SCHEMA_VERSION = "1.0.0";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 空文档，形状与 CQP.emptyStore() 完全一致 */
export function emptyDoc() {
  return {
    meta: {
      schemaVersion: STORE_SCHEMA_VERSION,
      appVersion: CQP.VERSION,
      nickname: "",
      deviceId: "",
      createdAt: null,
      updatedAt: null,
    },
    records: [],
    wrongbook: {},
    overrides: { schemaVersion: STORE_SCHEMA_VERSION, items: {} },
    sessions: [],
    imports: [],
  };
}

/**
 * 把任意来源的文档归一化成合法 store。
 * 不做业务校验（那在 mergeImport 里做），只保证结构不炸。
 */
export function normalizeDoc(raw) {
  const doc = emptyDoc();
  if (!isPlainObject(raw)) return doc;

  const meta = isPlainObject(raw.meta) ? raw.meta : {};
  if (typeof meta.appVersion === "string") doc.meta.appVersion = meta.appVersion;
  if (typeof meta.nickname === "string") doc.meta.nickname = meta.nickname.slice(0, 20);
  if (typeof meta.deviceId === "string") doc.meta.deviceId = meta.deviceId;
  if (typeof meta.createdAt === "string") doc.meta.createdAt = meta.createdAt;
  if (typeof meta.updatedAt === "string") doc.meta.updatedAt = meta.updatedAt;

  if (Array.isArray(raw.records)) {
    doc.records = raw.records.filter((r) => isPlainObject(r) && typeof r.qid === "string");
  }

  if (isPlainObject(raw.wrongbook)) {
    for (const qid of Object.keys(raw.wrongbook)) {
      const entry = raw.wrongbook[qid];
      if (!isPlainObject(entry)) continue;
      const next = { ...entry };
      if (next.state !== "active" && next.state !== "removed") next.state = "active";
      if (typeof next.confidentStreak !== "number") next.confidentStreak = 0;
      if (typeof next.attemptsSinceAdd !== "number") next.attemptsSinceAdd = 0;
      if (typeof next.correctSinceAdd !== "number") next.correctSinceAdd = 0;
      doc.wrongbook[qid] = next;
    }
  }

  if (isPlainObject(raw.overrides) && isPlainObject(raw.overrides.items)) {
    for (const qid of Object.keys(raw.overrides.items)) {
      const item = raw.overrides.items[qid];
      if (isPlainObject(item)) doc.overrides.items[qid] = item;
    }
  }

  if (Array.isArray(raw.sessions)) {
    doc.sessions = raw.sessions.filter((s) => isPlainObject(s) && typeof s.sessionId === "string");
  }

  if (Array.isArray(raw.imports)) {
    doc.imports = raw.imports.filter((i) => isPlainObject(i));
  }

  return doc;
}

/**
 * 条目最后被触碰的毫秒时间戳，用于错题本 LWW 合并。
 *
 * **不能直接比字符串**：CQP 的记录时间是 `YYYY-MM-DDTHH:mm:ss+08:00`（秒级、带偏移），
 * 而 `new Date().toISOString()` 是 `...Z`（毫秒级、UTC）。同一时刻的两种写法字符串序
 * 完全相反（`12:00:00+08:00` > `05:00:00.000Z`），直接比会把「刚移出错题本」判成旧数据。
 */
function lastTouchOf(entry) {
  const stamps = [entry.addedAt, entry.lastWrongAt, entry.removedAt];
  let max = null;
  for (const raw of stamps) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) continue;
    if (max === null || ms > max) max = ms;
  }
  return max;
}

/**
 * 错题本合并：`CQP.mergeImport` 完全不碰 wrongbook（ioport.mjs:337 之后全程不再读），
 * 所以这一层必须自己写。
 *
 * 规则：按 lastTouchOf 取更新的那条整条胜出；时间相同则 confidentStreak 大者胜。
 * **计数字段跟随整条条目，不做逐字段 max** —— 逐字段 max 会造出
 * 「streak=2 但 attemptsSinceAdd=9」这种状态机不可能产生的组合，
 * 之后 wrongbookApply 会基于假状态提前把题移出错题本。
 */
export function mergeWrongbook(left, right) {
  const out = {};
  for (const qid of Object.keys(left || {})) out[qid] = { ...left[qid] };
  for (const qid of Object.keys(right || {})) {
    const incoming = right[qid];
    const existing = out[qid];
    if (!existing) {
      out[qid] = { ...incoming };
      continue;
    }
    const ti = lastTouchOf(incoming);
    const te = lastTouchOf(existing);
    if (ti === null && te === null) {
      // 两边都没有可解析时间戳：退回 streak 比较，再不行保留已存在的
      if ((incoming.confidentStreak || 0) > (existing.confidentStreak || 0)) out[qid] = { ...incoming };
      continue;
    }
    if (te === null) {
      out[qid] = { ...incoming };
      continue;
    }
    if (ti === null) continue;
    if (ti > te) {
      out[qid] = { ...incoming };
    } else if (ti === te && (incoming.confidentStreak || 0) > (existing.confidentStreak || 0)) {
      out[qid] = { ...incoming };
    }
  }
  return out;
}

/**
 * imports 去重：mergeImport 只 push 不查重（ioport.mjs:475–484），
 * 同一份文件重复导入会让统计页「导入过几个队友文件」虚高。
 */
export function dedupeImports(store) {
  const seen = new Set();
  const kept = [];
  for (const item of store.imports || []) {
    const key = String(item.fileName ?? "") + "\u0001" + String(item.importedAt ?? "");
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
  }
  store.imports = kept;
  return store;
}

function toPayload(doc, nickname) {
  return {
    kind: EXPORT_KIND,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    appVersion: CQP.VERSION,
    exportedAt: doc.meta.updatedAt || new Date().toISOString(),
    exportedBy: { nickname: nickname || "", deviceId: doc.meta.deviceId || "d-00000000" },
    range: { scope: "all", from: null, to: null },
    counts: { records: doc.records.length, sessions: doc.sessions.length, overrides: Object.keys(doc.overrides.items).length },
    records: doc.records,
    mockSessions: doc.sessions,
    overrides: doc.overrides,
  };
}

/**
 * 合并两份文档（服务端权威副本 ← 客户端提交）
 *
 * 步骤 A：把 incoming 的 records/sessions/overrides 包成合法 cqp-export payload，
 *         交给 CQP.mergeImport —— 它已负责 recordKey 去重、localDate 重算修复、
 *         未知 qid 过滤、bankVersion 不一致报告、overrides LWW、sessions 去重。
 * 步骤 B：错题本自写 mergeWrongbook（mergeImport 不管）。
 * 步骤 C：imports 去重、meta 收尾。
 *
 * @returns {{store: object, report: object}}
 */
export function mergeDocs(current, incoming, options = {}) {
  const { questions = null, bankVersion = null, nowISO = null, nickname = "" } = options;

  const base = normalizeDoc(current);
  const extra = normalizeDoc(incoming);

  // 没有任何新内容时短路，省掉一次深拷贝 + 排序（PUT 很频繁）
  if (extra.records.length === 0 && extra.sessions.length === 0 && Object.keys(extra.overrides.items).length === 0) {
    const wrongbook = mergeWrongbook(base.wrongbook, extra.wrongbook);
    const changed = JSON.stringify(wrongbook) !== JSON.stringify(base.wrongbook);
    if (!changed) {
      return { store: base, report: { importedRecords: 0, duplicates: 0, wrongbookAdded: 0, merged: false } };
    }
    base.wrongbook = wrongbook;
    if (nowISO && base.meta) base.meta.updatedAt = nowISO;
    return {
      store: base,
      report: { importedRecords: 0, duplicates: 0, wrongbookAdded: 0, merged: true },
    };
  }

  const payload = toPayload(extra, nickname);
  const merged = CQP.mergeImport({
    store: base,
    payload,
    nowISO: nowISO || undefined,
    questions: questions || undefined,
    bankVersion: bankVersion || undefined,
  });

  const next = normalizeDoc(merged.store);

  // 步骤 B：错题本
  const beforeCount = Object.keys(next.wrongbook).length;
  next.wrongbook = mergeWrongbook(next.wrongbook, extra.wrongbook);
  const wrongbookAdded = Object.keys(next.wrongbook).length - beforeCount;

  // 步骤 C：imports 去重 + meta
  dedupeImports(next);
  if (nowISO) next.meta.updatedAt = nowISO;
  if (!next.meta.deviceId && base.meta.deviceId) next.meta.deviceId = base.meta.deviceId;

  return {
    store: next,
    report: {
      importedRecords: merged.report.importedRecords,
      duplicates: merged.report.duplicates + merged.report.duplicatesInFile,
      repaired: merged.report.repaired.length,
      unknownQids: merged.report.unknownQids,
      versionMismatch: merged.report.versionMismatch,
      overridesApplied: merged.report.overridesApplied,
      sessionsImported: merged.report.sessionsImported,
      wrongbookAdded,
      merged: true,
    },
  };
}

/** 把一份旧导出文件（cqp-export）合并进指定用户的文档 */
export function mergeExportInto(current, payload, options = {}) {
  const base = normalizeDoc(current);
  const merged = CQP.mergeImport({
    store: base,
    payload,
    nowISO: options.nowISO || undefined,
    fileName: options.fileName || undefined,
    questions: options.questions || undefined,
    bankVersion: options.bankVersion || undefined,
  });
  const next = normalizeDoc(merged.store);
  // CQP.mergeImport 只合 records / overrides / sessions，完全不碰 wrongbook，
  // 所以老导出（或本项目自己导出的备份）里的错题本必须在这里补合一次，
  // 否则导入后错题本会被静默丢掉。
  if (isPlainObject(payload.wrongbook)) {
    next.wrongbook = mergeWrongbook(next.wrongbook, payload.wrongbook);
  }
  dedupeImports(next);
  const added = Object.values(next.wrongbook).filter((e) => e && e.state === "active").length;
  const before = Object.values(base.wrongbook).filter((e) => e && e.state === "active").length;
  merged.report.wrongbookAdded = Math.max(0, added - before);
  return { store: next, report: merged.report };
}

/** 统计文档规模，用于 /api/me 与后台列表 */
export function docStats(doc) {
  const records = doc.records || [];
  let correct = 0;
  for (const r of records) if (r.correct === true) correct += 1;
  return {
    records: records.length,
    correct,
    wrongbookActive: Object.values(doc.wrongbook || {}).filter((e) => e && e.state === "active").length,
    sessions: (doc.sessions || []).length,
  };
}
