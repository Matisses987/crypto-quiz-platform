// 时间与本地自然日（docs/需求规格.md 8.7 / 9.2 / 7.1）
import { cn_DATE_RE_SRC, cn_ISO_RE_SRC } from "./constants.mjs";

const tm_ISO_RE = new RegExp(cn_ISO_RE_SRC);
const tm_DATE_RE = new RegExp(cn_DATE_RE_SRC);

export function tm_pad2(n) {
  return String(n).padStart(2, "0");
}

export function tm_pad4(n) {
  return String(n).padStart(4, "0");
}

// CQP.isoNow(date?) -> "YYYY-MM-DDTHH:mm:ss±HH:mm"（本机时区，秒级、不带毫秒）
export function tm_isoNow(date) {
  let d;
  if (date === undefined || date === null) {
    d = new Date();
  } else if (date instanceof Date) {
    d = date;
  } else {
    throw new TypeError("isoNow(date): date must be a Date");
  }
  const t = d.getTime();
  if (!Number.isFinite(t)) throw new TypeError("isoNow(date): date is invalid");
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  return (
    tm_pad4(d.getFullYear()) +
    "-" +
    tm_pad2(d.getMonth() + 1) +
    "-" +
    tm_pad2(d.getDate()) +
    "T" +
    tm_pad2(d.getHours()) +
    ":" +
    tm_pad2(d.getMinutes()) +
    ":" +
    tm_pad2(d.getSeconds()) +
    sign +
    tm_pad2(Math.floor(abs / 60)) +
    ":" +
    tm_pad2(abs % 60)
  );
}

// "YYYYMMDD-HHmmss"（导出文件名与模拟赛 id 用，本机时区）
export function tm_localStamp(date) {
  let d;
  if (date === undefined || date === null) d = new Date();
  else if (date instanceof Date) d = date;
  else throw new TypeError("localStamp(date): date must be a Date");
  if (!Number.isFinite(d.getTime())) throw new TypeError("localStamp(date): date is invalid");
  return (
    tm_pad4(d.getFullYear()) +
    tm_pad2(d.getMonth() + 1) +
    tm_pad2(d.getDate()) +
    "-" +
    tm_pad2(d.getHours()) +
    tm_pad2(d.getMinutes()) +
    tm_pad2(d.getSeconds())
  );
}

export function tm_isIsoTs(value) {
  return typeof value === "string" && tm_ISO_RE.test(value);
}

export function tm_isDateString(value) {
  return typeof value === "string" && tm_DATE_RE.test(value);
}

// CQP.localDateOf(tsISO) -> "YYYY-MM-DD"（按该串自身偏移的当地日期）
export function tm_localDateOf(tsISO) {
  if (typeof tsISO !== "string") throw new TypeError("localDateOf(tsISO): tsISO must be a string");
  if (!tm_ISO_RE.test(tsISO)) throw new TypeError("localDateOf(tsISO): tsISO is not ISO-8601 with offset");
  return tsISO.slice(0, 10);
}

// CQP.filterByDate(records, {scope, from?, to?})
export function tm_filterByDate(records, opt) {
  if (!Array.isArray(records)) throw new TypeError("filterByDate(records, opt): records must be an array");
  if (!opt || typeof opt !== "object") throw new TypeError("filterByDate(records, opt): opt must be an object");
  const scope = opt.scope;
  if (scope !== "day" && scope !== "range" && scope !== "all") {
    throw new TypeError('filterByDate(records, opt): opt.scope must be "day" | "range" | "all"');
  }
  if (scope === "day" || scope === "range") {
    if (!tm_isDateString(opt.from)) {
      throw new TypeError("filterByDate(records, opt): opt.from must be YYYY-MM-DD for scope " + scope);
    }
  }
  if (scope === "range") {
    if (!tm_isDateString(opt.to)) {
      throw new TypeError("filterByDate(records, opt): opt.to must be YYYY-MM-DD for scope range");
    }
    if (opt.from > opt.to) throw new RangeError("filterByDate(records, opt): from must not be later than to");
  }
  if (scope === "all") return records.slice();
  if (scope === "day") return records.filter((r) => r && r.localDate === opt.from);
  return records.filter((r) => r && r.localDate >= opt.from && r.localDate <= opt.to);
}

// CQP.dateInScope(localDate, {scope, from, to})：与 filterByDate 同一口径，供模拟赛按交卷日筛选
export function tm_dateInScope(localDate, opt) {
  if (typeof localDate !== "string") throw new TypeError("dateInScope(localDate, opt): localDate must be a string");
  if (!opt || typeof opt !== "object") throw new TypeError("dateInScope(localDate, opt): opt must be an object");
  const scope = opt.scope;
  if (scope === "all") return true;
  if (scope === "day") return localDate === opt.from;
  if (scope === "range") return localDate >= opt.from && localDate <= opt.to;
  throw new TypeError('dateInScope(localDate, opt): opt.scope must be "day" | "range" | "all"');
}

// 毫秒差（用于用时统计）；非法串抛 TypeError
export function tm_diffMs(fromISO, toISO) {
  if (typeof fromISO !== "string" || typeof toISO !== "string") {
    throw new TypeError("diffMs(fromISO, toISO): arguments must be ISO-8601 strings");
  }
  const a = Date.parse(fromISO);
  const b = Date.parse(toISO);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new TypeError("diffMs(fromISO, toISO): arguments are not parseable ISO-8601 strings");
  }
  return b - a;
}
