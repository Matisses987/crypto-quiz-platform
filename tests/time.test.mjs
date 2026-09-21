// Date handling: docs/需求规格.md 8.7 / 9.2 / 7.1.
import test from "node:test";
import assert from "node:assert/strict";
import { CQP } from "../src/core/index.mjs";

test("isoNow renders local ISO-8601 with seconds and offset", () => {
  const date = new Date(2026, 9, 5, 21, 14, 3);
  const iso = CQP.isoNow(date);
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const expectedOffset = sign + String(Math.floor(abs / 60)).padStart(2, "0") + ":" + String(abs % 60).padStart(2, "0");
  assert.equal(iso, "2026-10-05T21:14:03" + expectedOffset);
  assert.equal(iso.indexOf("."), -1, "no milliseconds");
});

test("isoNow rejects invalid dates", () => {
  assert.throws(() => CQP.isoNow(new Date("nope")), TypeError);
  assert.throws(() => CQP.isoNow("2026-10-05"), TypeError);
});

test("localDateOf uses the offset inside the timestamp", () => {
  assert.equal(CQP.localDateOf("2026-10-05T23:30:00+08:00"), "2026-10-05");
  assert.equal(CQP.localDateOf("2026-10-05T23:30:00+00:00"), "2026-10-05");
  assert.equal(CQP.localDateOf("2026-10-05T00:00:01+08:00"), "2026-10-05");
  assert.equal(CQP.localDateOf("2026-10-06T00:30:00+09:00"), "2026-10-06");
  assert.equal(CQP.localDateOf("2026-10-05T23:30:00Z"), "2026-10-05");
  assert.throws(() => CQP.localDateOf("2026-10-05"), TypeError);
  assert.throws(() => CQP.localDateOf(20261005), TypeError);
});

test("filterByDate day scope uses the stored localDate", () => {
  const records = [
    { localDate: "2026-10-04" },
    { localDate: "2026-10-05" },
    { localDate: "2026-10-05" },
    { localDate: "2026-10-06" },
  ];
  assert.deepEqual(
    CQP.filterByDate(records, { scope: "day", from: "2026-10-05" }).map((r) => r.localDate),
    ["2026-10-05", "2026-10-05"]
  );
});

test("filterByDate range is inclusive and keeps order", () => {
  const records = [
    { localDate: "2026-10-03" },
    { localDate: "2026-10-04" },
    { localDate: "2026-10-05" },
    { localDate: "2026-10-06" },
    { localDate: "2026-10-07" },
  ];
  const range = CQP.filterByDate(records, { scope: "range", from: "2026-10-04", to: "2026-10-06" });
  assert.equal(range.length, 3);
  assert.deepEqual(range.map((r) => r.localDate), ["2026-10-04", "2026-10-05", "2026-10-06"]);
  const all = CQP.filterByDate(records, { scope: "all" });
  assert.equal(all.length, 5);
  assert.notEqual(all, records, "must return a copy");
});

test("filterByDate guards invalid input", () => {
  const records = [{ localDate: "2026-10-05" }];
  assert.throws(() => CQP.filterByDate(records, { scope: "day" }), TypeError);
  assert.throws(() => CQP.filterByDate(records, { scope: "range", from: "2026-10-06", to: "2026-10-05" }), RangeError);
  assert.throws(() => CQP.filterByDate(records, { scope: "week" }), TypeError);
  assert.throws(() => CQP.filterByDate(records, { scope: "day", from: "2026-10-5" }), TypeError);
  assert.throws(() => CQP.filterByDate("x", { scope: "all" }), TypeError);
});

test("dateInScope mirrors filterByDate semantics", () => {
  assert.equal(CQP.dateInScope("2026-10-05", { scope: "day", from: "2026-10-05" }), true);
  assert.equal(CQP.dateInScope("2026-10-06", { scope: "day", from: "2026-10-05" }), false);
  assert.equal(CQP.dateInScope("2026-10-06", { scope: "range", from: "2026-10-05", to: "2026-10-06" }), true);
  assert.equal(CQP.dateInScope("2026-10-07", { scope: "range", from: "2026-10-05", to: "2026-10-06" }), false);
  assert.equal(CQP.dateInScope("2026-10-07", { scope: "all" }), true);
});

test("localStamp renders YYYYMMDD-HHmmss", () => {
  const stamp = CQP.localStamp(new Date(2026, 9, 6, 22, 30, 15));
  assert.equal(stamp, "20261006-223015");
});

test("diffMs computes milliseconds between ISO strings", () => {
  assert.equal(CQP.diffMs("2026-10-05T21:00:00+08:00", "2026-10-05T21:00:10+08:00"), 10000);
  assert.equal(CQP.diffMs("2026-10-05T21:00:00+08:00", "2026-10-05T21:00:00+09:00"), -3600000);
  assert.throws(() => CQP.diffMs("x", "y"), TypeError);
});
