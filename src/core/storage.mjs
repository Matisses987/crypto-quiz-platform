// localStorage 适配（docs/需求规格.md 4.1 / 9.13）
import { cn_STORAGE_KEYS, cn_STORAGE_PREFIX } from "./constants.mjs";
import { sr_emptyStore, sr_migrateStore } from "./store.mjs";

let sg_backend = null;

export function sg_setBackend(backend) {
  if (backend !== null && backend !== undefined && typeof backend.getItem !== "function") {
    throw new TypeError("setBackend(backend): backend must provide getItem/setItem/removeItem");
  }
  sg_backend = backend === undefined ? null : backend;
  return sg_backend;
}

function sg_realBackend() {
  try {
    const g = typeof globalThis !== "undefined" ? globalThis : null;
    if (g && g.localStorage) return g.localStorage;
  } catch (err) {
    return null;
  }
  return null;
}

export function sg_backendFor() {
  if (sg_backend) return sg_backend;
  return sg_realBackend();
}

function sg_classifyError(err) {
  const name = err && err.name ? String(err.name) : "";
  const message = err && err.message ? String(err.message) : "";
  const code = err && typeof err.code === "number" ? err.code : 0;
  if (/quota/i.test(name) || /quota/i.test(message) || code === 22 || code === 1014) {
    return { code: "E_QUOTA", message: "本地存储已满（配额超限），请导出备份后清理数据" };
  }
  return { code: "E_DENIED", message: "本地存储不可用，数据无法保存，请立即导出备份" };
}

function sg_storeError(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) err.detail = extra;
  return err;
}

function sg_readKey(backend, key) {
  let text;
  try {
    text = backend.getItem(key);
  } catch (err) {
    throw sg_storeError("E_STORE_PARSE", "读取本地存储失败：" + key);
  }
  if (text === null || text === undefined || text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw sg_storeError("E_STORE_PARSE", "本地存储数据损坏（JSON 解析失败）：" + key, { key, raw: String(text).slice(0, 4000) });
  }
}

// CQP.storage.load()
export function sg_load() {
  const backend = sg_backendFor();
  if (!backend) return sr_emptyStore();
  const raw = {
    meta: sg_readKey(backend, cn_STORAGE_KEYS.meta),
    records: sg_readKey(backend, cn_STORAGE_KEYS.records),
    wrongbook: sg_readKey(backend, cn_STORAGE_KEYS.wrongbook),
    overrides: sg_readKey(backend, cn_STORAGE_KEYS.overrides),
    sessions: sg_readKey(backend, cn_STORAGE_KEYS.sessions),
    imports: sg_readKey(backend, cn_STORAGE_KEYS.imports),
  };
  const migrated = sr_migrateStore(raw);
  if (migrated.error) {
    const message =
      migrated.error.code === "E_VERSION"
        ? "数据版本不兼容（发现 " + String((raw.meta && raw.meta.schemaVersion) || "?") + "，程序支持 1.0.0）"
        : "本地存储结构异常";
    throw sg_storeError(migrated.error.code, message);
  }
  return migrated.store;
}

// CQP.storage.save(store) -> {ok, error?}
export function sg_save(store) {
  if (!store || typeof store !== "object") throw new TypeError("storage.save(store): store must be an object");
  const backend = sg_backendFor();
  const err = sg_classifyError(null);
  if (!backend) {
    return { ok: false, error: { code: "E_DENIED", message: err.message } };
  }
  const entries = [
    [cn_STORAGE_KEYS.meta, store.meta || sr_emptyStore().meta],
    [cn_STORAGE_KEYS.records, Array.isArray(store.records) ? store.records : []],
    [cn_STORAGE_KEYS.wrongbook, store.wrongbook || {}],
    [cn_STORAGE_KEYS.overrides, store.overrides || { schemaVersion: "1.0.0", items: {} }],
    [cn_STORAGE_KEYS.sessions, Array.isArray(store.sessions) ? store.sessions : []],
    [cn_STORAGE_KEYS.imports, Array.isArray(store.imports) ? store.imports : []],
  ];
  for (const [key, value] of entries) {
    try {
      backend.setItem(key, JSON.stringify(value));
    } catch (e) {
      return { ok: false, error: sg_classifyError(e) };
    }
  }
  return { ok: true };
}

// CQP.storage.reset()：仅清空 cqp.v1.* 键
export function sg_reset() {
  const backend = sg_backendFor();
  if (!backend) return;
  for (const key of Object.keys(cn_STORAGE_KEYS)) {
    try {
      backend.removeItem(cn_STORAGE_KEYS[key]);
    } catch (err) {
      /* 忽略：清空失败不影响内存态 */
    }
  }
  if (typeof backend.length === "number" && typeof backend.key === "function") {
    const prefixed = [];
    for (let i = 0; i < backend.length; i += 1) {
      const key = backend.key(i);
      if (typeof key === "string" && key.indexOf(cn_STORAGE_PREFIX) === 0) prefixed.push(key);
    }
    for (const key of prefixed) {
      try {
        backend.removeItem(key);
      } catch (err) {
        /* 忽略 */
      }
    }
  }
}

// CQP.storage.probe() -> {available, mode, error?}
export function sg_probe() {
  const backend = sg_backendFor();
  if (!backend) {
    return { available: false, mode: "none", error: { code: "E_DENIED", message: "本地存储不可用，数据无法保存，请立即导出备份" } };
  }
  const probeKey = cn_STORAGE_PREFIX + "probe";
  try {
    backend.setItem(probeKey, "1");
    const back = backend.getItem(probeKey);
    backend.removeItem(probeKey);
    if (back !== "1") {
      return { available: false, mode: "none", error: { code: "E_DENIED", message: "本地存储不可写，数据无法保存，请立即导出备份" } };
    }
    return { available: true, mode: sg_backend ? "memory" : "localStorage" };
  } catch (e) {
    const err = sg_classifyError(e);
    return { available: false, mode: "none", error: err };
  }
}

export function sg_keys() {
  const backend = sg_backendFor();
  if (!backend) return [];
  const out = [];
  for (const key of Object.keys(cn_STORAGE_KEYS)) {
    try {
      if (backend.getItem(cn_STORAGE_KEYS[key]) !== null) out.push(cn_STORAGE_KEYS[key]);
    } catch (err) {
      /* 忽略 */
    }
  }
  return out;
}

// CQP.storage.readRaw()：原样读取 cqp.v1.* 的磁盘字符串（不解析、不抛错）。
// t41 F-03 用途：本地数据 schema 不兼容或 JSON 损坏时，界面进入只读阻断态（绝不写回），
// 两个导出入口改为直接读这里的内容做「抢救导出」，保证用户能把浏览器里的原始数据取出来。
export function sg_readRaw() {
  const backend = sg_backendFor();
  const out = {};
  for (const name of Object.keys(cn_STORAGE_KEYS)) {
    const key = cn_STORAGE_KEYS[name];
    let value = null;
    try {
      value = backend && typeof backend.getItem === "function" ? backend.getItem(key) : null;
    } catch (err) {
      value = null;
    }
    out[key] = value === undefined || value === null ? null : String(value);
  }
  return out;
}
