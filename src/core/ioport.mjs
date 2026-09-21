// 导出 / 导入 / 合并去重（docs/需求规格.md 6.6 / 7.x / 9.12）
import {
  cn_EXPORT_KIND,
  cn_EXPORT_SCHEMA_VERSION,
  cn_ISO_RE_SRC,
  cn_QID_RE_SRC,
  cn_STORAGE_KEYS,
  cn_STORE_SCHEMA_VERSION,
  cn_TYPES,
  cn_VERSION,
} from "./constants.mjs";
import { tm_isoNow, tm_isIsoTs, tm_localDateOf, tm_localStamp, tm_filterByDate, tm_dateInScope } from "./time.mjs";
import { rc_recordKey } from "./records.mjs";

const io_QID_RE = new RegExp(cn_QID_RE_SRC);
const io_ISO_RE = new RegExp(cn_ISO_RE_SRC);

// 当前生效题库注册表（导出/导入时用于未知 qid 判定）
let io_registeredBank = null;

export function io_registerBank(bank) {
  if (bank === null || bank === undefined) {
    io_registeredBank = null;
    return null;
  }
  if (!bank || !Array.isArray(bank.questions)) {
    throw new TypeError("setBank(bank): bank.questions must be an array");
  }
  io_registeredBank = bank;
  return bank;
}

export function io_getRegisteredBank() {
  return io_registeredBank;
}

export function io_sanitizeNickname(nickname) {
  const raw = nickname === undefined || nickname === null ? "" : String(nickname);
  const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_").trim();
  const cut = cleaned.slice(0, 20);
  return cut.length > 0 ? cut : "未命名";
}

export function io_rangeLabel(scope, from, to) {
  if (scope === "day") return "单日" + String(from);
  if (scope === "range") return String(from) + "至" + String(to);
  if (scope === "all") return "全部";
  throw new TypeError('rangeLabel(scope, from, to): scope must be "day" | "range" | "all"');
}

// CQP.exportFileName({nickname, scope, from, to, nowISO})
export function io_exportFileName(input) {
  if (!input || typeof input !== "object") throw new TypeError("exportFileName(input): input must be an object");
  const scope = input.scope;
  if (scope !== "day" && scope !== "range" && scope !== "all") {
    throw new TypeError('exportFileName(input): input.scope must be "day" | "range" | "all"');
  }
  const nick = io_sanitizeNickname(input.nickname);
  const label = io_rangeLabel(scope, input.from, input.to);
  const now = input.nowISO ? new Date(Date.parse(input.nowISO)) : new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("exportFileName(input): input.nowISO is not parseable");
  return "密码赛学习记录_" + nick + "_" + label + "_" + tm_localStamp(now) + ".json";
}

function io_validateScope(scope, from, to) {
  if (scope !== "day" && scope !== "range" && scope !== "all") {
    throw new TypeError('exportPayload(input): input.scope must be "day" | "range" | "all"');
  }
  if (scope === "day") {
    if (typeof from !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      throw new TypeError("exportPayload(input): input.from must be YYYY-MM-DD for scope day");
    }
  }
  if (scope === "range") {
    if (typeof from !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      throw new TypeError("exportPayload(input): input.from must be YYYY-MM-DD for scope range");
    }
    if (typeof to !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new TypeError("exportPayload(input): input.to must be YYYY-MM-DD for scope range");
    }
    if (from > to) throw new RangeError("exportPayload(input): from must not be later than to");
  }
}

// CQP.exportPayload({store, scope, from, to, nickname, nowISO, bankVersion?})
export function io_exportPayload(input) {
  if (!input || typeof input !== "object") throw new TypeError("exportPayload(input): input must be an object");
  const store = input.store;
  if (!store || typeof store !== "object") throw new TypeError("exportPayload(input): input.store must be an object");
  const scope = input.scope;
  const from = input.from === undefined ? null : input.from;
  const to = input.to === undefined ? null : input.to;
  io_validateScope(scope, from, to);
  const nowISO = input.nowISO === undefined || input.nowISO === null ? tm_isoNow() : input.nowISO;
  const meta = store.meta && typeof store.meta === "object" ? store.meta : {};
  const nickname = input.nickname === undefined || input.nickname === null ? meta.nickname : input.nickname;
  if (typeof nickname !== "string" || nickname.trim().length === 0) {
    throw new TypeError("exportPayload(input): input.nickname must be a non-empty string");
  }
  const records = tm_filterByDate(Array.isArray(store.records) ? store.records : [], { scope, from, to });
  const allSessions = Array.isArray(store.sessions) ? store.sessions : [];
  const sessions = allSessions.filter((s) => {
    if (!s || typeof s.submittedAt !== "string") return false;
    let local;
    try {
      local = tm_localDateOf(s.submittedAt);
    } catch (err) {
      return false;
    }
    return tm_dateInScope(local, { scope, from, to });
  });
  const overrides =
    store.overrides && typeof store.overrides === "object" && store.overrides.items
      ? { schemaVersion: store.overrides.schemaVersion || cn_STORE_SCHEMA_VERSION, items: store.overrides.items }
      : { schemaVersion: cn_STORE_SCHEMA_VERSION, items: {} };
  const bankVersion =
    typeof input.bankVersion === "string" && input.bankVersion.length > 0
      ? input.bankVersion
      : typeof meta.bankVersion === "string" && meta.bankVersion.length > 0
        ? meta.bankVersion
        : records.length > 0 && typeof records[0].bankVersion === "string"
          ? records[0].bankVersion
          : "unknown";

  return {
    kind: cn_EXPORT_KIND,
    schemaVersion: cn_EXPORT_SCHEMA_VERSION,
    appVersion: cn_VERSION,
    bankVersion,
    exportedAt: nowISO,
    exportedBy: { nickname, deviceId: typeof meta.deviceId === "string" ? meta.deviceId : "d-00000000" },
    range: { scope, from: scope === "all" ? null : from, to: scope === "all" ? null : scope === "day" ? from : to },
    counts: {
      records: records.length,
      sessions: sessions.length,
      overrides: Object.keys(overrides.items).length,
    },
    records,
    mockSessions: sessions,
    overrides,
  };
}

// CQP.rescueExport({raw, bankVersion, nowISO, reason, detectedSchemaVersion}) -> 抢救导出 payload
// t41 F-03：本地 meta.schemaVersion 不兼容 / 数据 JSON 损坏时，应用进入只读阻断态（不写盘），
// 导出入口改为用 CQP.storage.readRaw() 的原样字符串在这里组装文件：
//   · 能解析的键 → 结构化导出（records / mockSessions / overrides / 昵称 / deviceId）；
//   · 解析不了的键 → 以**原始字符串**放进 rescue.rawKeys，保证用户能手工抢救；
//   · schemaVersion 用磁盘上检测到的值（而不是当前版本），避免这份文件被误当成正常备份。
export function io_rescueExport(input) {
  const opts = io_isPlainObject(input) ? input : {};
  const raw = io_isPlainObject(opts.raw) ? opts.raw : {};
  const nowISO = typeof opts.nowISO === "string" ? opts.nowISO : tm_isoNow();
  const parsed = {};
  const unparsable = [];
  const rawKeys = {};
  for (const key of Object.keys(raw)) {
    const text = raw[key];
    if (text === null || text === undefined || text === "") continue;
    try {
      parsed[key] = JSON.parse(text);
    } catch (err) {
      unparsable.push(key);
      rawKeys[key] = String(text);
    }
  }
  const meta = io_isPlainObject(parsed[cn_STORAGE_KEYS.meta]) ? parsed[cn_STORAGE_KEYS.meta] : {};
  const records = Array.isArray(parsed[cn_STORAGE_KEYS.records]) ? parsed[cn_STORAGE_KEYS.records] : [];
  const sessions = Array.isArray(parsed[cn_STORAGE_KEYS.sessions]) ? parsed[cn_STORAGE_KEYS.sessions] : [];
  const overrides = io_isPlainObject(parsed[cn_STORAGE_KEYS.overrides])
    ? parsed[cn_STORAGE_KEYS.overrides]
    : { schemaVersion: cn_STORE_SCHEMA_VERSION, items: {} };
  const overlayItems = io_isPlainObject(overrides.items) ? overrides.items : {};
  const detected =
    typeof opts.detectedSchemaVersion === "string" && opts.detectedSchemaVersion.length > 0
      ? opts.detectedSchemaVersion
      : typeof meta.schemaVersion === "string" && meta.schemaVersion.length > 0
        ? meta.schemaVersion
        : "unknown";
  const nickname = typeof meta.nickname === "string" ? io_sanitizeNickname(meta.nickname) : "";
  return {
    kind: cn_EXPORT_KIND,
    schemaVersion: detected,
    appVersion: cn_VERSION,
    bankVersion: typeof opts.bankVersion === "string" && opts.bankVersion.length > 0 ? opts.bankVersion : "unknown",
    exportedAt: nowISO,
    rescue: {
      blocked: true,
      reason: typeof opts.reason === "string" && opts.reason.length > 0 ? opts.reason : "E_VERSION",
      note: "只读抢救导出：本次运行没有写入任何数据；本文件由浏览器本地存储（cqp.v1.*）的原始内容直接生成。",
      detectedSchemaVersion: detected,
      unparsableKeys: unparsable,
      rawKeys,
    },
    exportedBy: { nickname: nickname.length > 0 ? nickname : "未命名", deviceId: typeof meta.deviceId === "string" ? meta.deviceId : "d-00000000" },
    range: { scope: "all", from: null, to: null },
    counts: { records: records.length, sessions: sessions.length, overrides: Object.keys(overlayItems).length },
    records,
    mockSessions: sessions,
    overrides,
  };
}

function io_isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// CQP.validateImport(textOrObject) -> {ok, errors, warnings, payload?}
export function io_validateImport(textOrObject) {
  const errors = [];
  const warnings = [];
  let obj = null;
  if (typeof textOrObject === "string") {
    if (textOrObject.trim().length === 0) {
      errors.push({ code: "E_PARSE", message: "文件不是合法 JSON" });
      return { ok: false, errors, warnings };
    }
    try {
      obj = JSON.parse(textOrObject);
    } catch (err) {
      errors.push({ code: "E_PARSE", message: "文件不是合法 JSON" });
      return { ok: false, errors, warnings };
    }
  } else if (io_isPlainObject(textOrObject)) {
    obj = textOrObject;
  } else {
    errors.push({ code: "E_PARSE", message: "文件不是合法 JSON" });
    return { ok: false, errors, warnings };
  }

  if (!io_isPlainObject(obj) || obj.kind !== cn_EXPORT_KIND) {
    errors.push({ code: "E_KIND", message: "不是本平台的导出文件" });
    return { ok: false, errors, warnings };
  }
  const schemaVersion = obj.schemaVersion;
  if (typeof schemaVersion !== "string" || schemaVersion.split(".")[0] !== "1") {
    errors.push({
      code: "E_VERSION",
      message: "数据版本不兼容（发现 " + String(schemaVersion) + "，程序支持 " + cn_EXPORT_SCHEMA_VERSION + "）",
    });
    return { ok: false, errors, warnings };
  }

  const missing = [];
  const needString = (path, value) => {
    if (typeof value !== "string" || value.length === 0) missing.push(path);
  };
  needString("appVersion", obj.appVersion);
  needString("bankVersion", obj.bankVersion);
  needString("exportedAt", obj.exportedAt);
  if (!io_isPlainObject(obj.exportedBy)) missing.push("exportedBy");
  else needString("exportedBy.nickname", obj.exportedBy.nickname);
  if (!io_isPlainObject(obj.range)) missing.push("range");
  else {
    if (obj.range.scope !== "day" && obj.range.scope !== "range" && obj.range.scope !== "all") missing.push("range.scope");
    for (const key of ["from", "to"]) {
      if (!(key in obj.range)) missing.push("range." + key);
      else if (obj.range[key] !== null && typeof obj.range[key] !== "string") missing.push("range." + key);
    }
  }
  if (!io_isPlainObject(obj.counts)) missing.push("counts");
  else {
    for (const key of ["records", "sessions", "overrides"]) {
      if (!Number.isInteger(obj.counts[key])) missing.push("counts." + key);
    }
  }
  if (!Array.isArray(obj.records)) missing.push("records");
  if (!Array.isArray(obj.mockSessions)) missing.push("mockSessions");
  if (!io_isPlainObject(obj.overrides)) missing.push("overrides");
  else if (!io_isPlainObject(obj.overrides.items)) missing.push("overrides.items");
  if (missing.length > 0) {
    errors.push({ code: "E_SCHEMA", message: "导出文件缺少必填字段或类型不符：" + missing.join(", ") });
    return { ok: false, errors, warnings };
  }

  const counts = obj.counts;
  const countMismatch = [];
  if (counts.records !== obj.records.length) countMismatch.push("records");
  if (counts.sessions !== obj.mockSessions.length) countMismatch.push("sessions");
  if (counts.overrides !== Object.keys(obj.overrides.items).length) countMismatch.push("overrides");
  if (countMismatch.length > 0) {
    errors.push({ code: "E_COUNTS", message: "文件已损坏（计数不一致）：" + countMismatch.join(", ") });
    return { ok: false, errors, warnings };
  }

  return { ok: true, errors, warnings, payload: obj };
}

function io_checkRecordShape(record) {
  if (!io_isPlainObject(record)) return "bad_record";
  if (typeof record.qid !== "string" || !io_QID_RE.test(record.qid)) return "bad_qid";
  if (typeof record.ts !== "string" || !io_ISO_RE.test(record.ts)) return "bad_ts";
  if (!Array.isArray(record.myAnswer) || record.myAnswer.some((x) => typeof x !== "string")) return "bad_myAnswer";
  if (record.confidence !== "confident" && record.confidence !== "guessed") return "bad_confidence";
  if (typeof record.correct !== "boolean") return "bad_correct";
  return null;
}

function io_cloneStore(store) {
  return JSON.parse(JSON.stringify(store));
}

function io_compareUpdatedAt(a, b) {
  const x = typeof a === "string" ? a : "";
  const y = typeof b === "string" ? b : "";
  if (x === y) return 0;
  return x > y ? 1 : -1;
}

function io_normalizeOverrideItem(item) {
  const src = io_isPlainObject(item) ? item : {};
  return {
    answer: Array.isArray(src.answer) && src.answer.length >= 1 ? src.answer.filter((x) => typeof x === "string") : null,
    tags: null,
    difficulty: src.difficulty === 1 || src.difficulty === 2 || src.difficulty === 3 ? src.difficulty : null,
    flagged: src.flagged === true,
    note: typeof src.note === "string" ? src.note.slice(0, 200) : "",
    updatedAt: typeof src.updatedAt === "string" ? src.updatedAt : tm_isoNow(),
    updatedBy: typeof src.updatedBy === "string" ? src.updatedBy : "",
    rev: Number.isInteger(src.rev) && src.rev >= 1 ? src.rev : 1,
  };
}

// CQP.mergeImport({store, payload, nowISO?, fileName?, questions?, bankVersion?}) -> {store, report}
export function io_mergeImport(input) {
  if (!input || typeof input !== "object") throw new TypeError("mergeImport(input): input must be an object");
  const store = input.store;
  if (!store || typeof store !== "object") throw new TypeError("mergeImport(input): input.store must be an object");
  const payload = input.payload;
  if (!io_isPlainObject(payload)) throw new TypeError("mergeImport(input): input.payload must be an object");
  if (payload.kind !== cn_EXPORT_KIND) {
    throw new TypeError('mergeImport(input): input.payload.kind must be "' + cn_EXPORT_KIND + '"');
  }
  const nowISO = input.nowISO === undefined || input.nowISO === null ? tm_isoNow() : input.nowISO;
  const next = io_cloneStore(store);
  if (!Array.isArray(next.records)) next.records = [];
  if (!io_isPlainObject(next.wrongbook)) next.wrongbook = {};
  if (!Array.isArray(next.sessions)) next.sessions = [];
  if (!Array.isArray(next.imports)) next.imports = [];
  if (!io_isPlainObject(next.overrides)) next.overrides = { schemaVersion: cn_STORE_SCHEMA_VERSION, items: {} };
  if (!io_isPlainObject(next.overrides.items)) next.overrides.items = {};

  const report = {
    ok: true,
    importedRecords: 0,
    duplicates: 0,
    duplicatesInFile: 0,
    skipped: [],
    repaired: [],
    unknownQids: [],
    versionMismatch: [],
    overridesApplied: 0,
    overridesKept: 0,
    sessionsImported: 0,
    nicknames: [],
    errors: [],
  };

  const bank = Array.isArray(input.questions)
    ? { questions: input.questions }
    : io_registeredBank && Array.isArray(io_registeredBank.questions)
      ? io_registeredBank
      : null;
  const knownIds = bank ? new Set(bank.questions.map((q) => q.id)) : null;
  const currentBankVersion = typeof input.bankVersion === "string" ? input.bankVersion : bank ? bank.bankVersion : null;

  const localKeys = new Set();
  for (const r of next.records) {
    try {
      localKeys.add(rc_recordKey(r));
    } catch (err) {
      if (r && typeof r.qid === "string" && typeof r.nickname === "string" && typeof r.ts === "string") {
        localKeys.add(r.nickname + "\u0001" + r.qid + "\u0001" + r.ts);
      }
    }
  }
  const fileKeys = new Set();
  const incoming = [];
  const importedRecordsList = payload.records;
  for (const raw of importedRecordsList) {
    const reason = io_checkRecordShape(raw);
    if (reason) {
      report.skipped.push({ reason, raw: JSON.stringify(raw).slice(0, 300) });
      continue;
    }
    const key = raw.nickname + "\u0001" + raw.qid + "\u0001" + raw.ts;
    if (fileKeys.has(key)) {
      report.duplicatesInFile += 1;
      continue;
    }
    fileKeys.add(key);
    let localDate = raw.localDate;
    const recomputed = tm_localDateOf(raw.ts);
    if (localDate !== recomputed) {
      report.repaired.push({ qid: raw.qid, ts: raw.ts, from: typeof localDate === "string" ? localDate : null, to: recomputed });
      localDate = recomputed;
    }
    if (knownIds && !knownIds.has(raw.qid)) {
      report.unknownQids.push({ qid: raw.qid, nickname: raw.nickname, ts: raw.ts });
      continue;
    }
    if (currentBankVersion && typeof raw.bankVersion === "string" && raw.bankVersion !== currentBankVersion) {
      report.versionMismatch.push({ qid: raw.qid, bankVersion: raw.bankVersion });
    }
    if (localKeys.has(key)) {
      report.duplicates += 1;
      continue;
    }
    const record = {
      recordKey: key,
      qid: raw.qid,
      nickname: raw.nickname,
      ts: raw.ts,
      localDate,
      mode: cn_TYPES.indexOf(raw.mode) >= 0 ? raw.mode : typeof raw.mode === "string" ? raw.mode : "practice_random",
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
      myAnswer: raw.myAnswer.slice(),
      correct: raw.correct,
      confidence: raw.confidence,
      color: raw.color === "green" || raw.color === "yellow" || raw.color === "red" ? raw.color : raw.correct ? (raw.confidence === "guessed" ? "yellow" : "green") : "red",
      elapsedMs: Number.isFinite(raw.elapsedMs) && raw.elapsedMs >= 0 ? Math.round(raw.elapsedMs) : 0,
      bankVersion: typeof raw.bankVersion === "string" ? raw.bankVersion : "unknown",
      appVersion: typeof raw.appVersion === "string" ? raw.appVersion : cn_VERSION,
    };
    incoming.push(record);
    report.importedRecords += 1;
  }

  incoming.sort((a, b) => (a.ts === b.ts ? 0 : a.ts < b.ts ? -1 : 1));
  next.records = next.records.concat(incoming);

  // 覆盖层合并：last-write-wins（updatedAt 较新者胜；相同则 updatedBy 字典序较大者胜）
  const incomingOverrides = io_isPlainObject(payload.overrides) && io_isPlainObject(payload.overrides.items) ? payload.overrides.items : {};
  const mergedItems = {};
  for (const key of Object.keys(next.overrides.items)) mergedItems[key] = next.overrides.items[key];
  for (const qid of Object.keys(incomingOverrides)) {
    const item = io_normalizeOverrideItem(incomingOverrides[qid]);
    const local = mergedItems[qid];
    if (!io_isPlainObject(local)) {
      mergedItems[qid] = item;
      report.overridesApplied += 1;
      continue;
    }
    const cmp = io_compareUpdatedAt(item.updatedAt, local.updatedAt);
    if (cmp > 0) {
      mergedItems[qid] = item;
      report.overridesApplied += 1;
    } else if (cmp < 0) {
      report.overridesKept += 1;
    } else if (item.updatedBy > (typeof local.updatedBy === "string" ? local.updatedBy : "")) {
      mergedItems[qid] = item;
      report.overridesApplied += 1;
    } else {
      report.overridesKept += 1;
    }
  }
  next.overrides = { schemaVersion: cn_STORE_SCHEMA_VERSION, items: mergedItems };

  // 模拟赛合并：按 sessionId 去重，已存在不覆盖
  const existingSessions = new Set();
  for (const s of next.sessions) if (s && typeof s.sessionId === "string") existingSessions.add(s.sessionId);
  const incomingSessions = Array.isArray(payload.mockSessions) ? payload.mockSessions : [];
  for (const s of incomingSessions) {
    if (!io_isPlainObject(s) || typeof s.sessionId !== "string") continue;
    if (existingSessions.has(s.sessionId)) continue;
    existingSessions.add(s.sessionId);
    next.sessions.push(s);
    report.sessionsImported += 1;
  }

  const nickSet = new Set();
  for (const r of incoming) nickSet.add(r.nickname);
  report.nicknames = Array.from(nickSet).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));

  if (typeof input.fileName === "string" && input.fileName.length > 0) {
    next.imports.push({
      fileName: input.fileName,
      importedAt: nowISO,
      nicknames: report.nicknames,
      importedRecords: report.importedRecords,
      duplicates: report.duplicates + report.duplicatesInFile,
      skipped: report.skipped.length,
    });
  }

  if (next.meta && typeof next.meta === "object") next.meta.updatedAt = nowISO;
  return { store: next, report };
}
