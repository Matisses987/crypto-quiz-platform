// t41 F-03: when local data is schema-incompatible or unparsable the app must become
// COMPLETELY read-only — never write the empty in-memory store back to disk (a reload or
// unload used to silently wipe the user's data), and the export entries must read the raw
// disk snapshot so "export a backup first" can actually rescue the data.
// Console output of this suite is English ASCII (repo convention); Chinese stays in comments.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "../tools/build.mjs";
import { createDom } from "./helpers/domshim.mjs";
import { cn_STORAGE_KEYS } from "../src/core/constants.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const realBankPath = path.join(root, "src", "data", "bank.json");
const fixturePath = path.join(here, "fixtures", "bank.sample.json");
// t46 O-01：临时产物写系统临时目录，绝不落在交付目录 dist/
const artifactPath = path.join(os.tmpdir(), "__cqp_blocked_test.html");

const KEY = cn_STORAGE_KEYS;

function extractScript(html, id) {
  const start = html.indexOf('<script id="' + id + '"');
  assert.ok(start > 0, "missing script " + id);
  const openEnd = html.indexOf(">", start);
  const close = html.indexOf("</script>", openEnd);
  return html.slice(openEnd + 1, close);
}

// 启动成品；seed 直接写进 DOM shim 的 localStorage（核心会自动把它当后端用）
function bootApp(seed) {
  const bankPath = fs.existsSync(realBankPath) ? realBankPath : fixturePath;
  const result = build({ bankPath, outPath: artifactPath, reportPath: null });
  assert.equal(result.ok, true);
  const html = fs.readFileSync(artifactPath, "utf8");
  const dom = createDom({ storage: seed || {} });
  dom.getElementById("bank-data").textContent = extractScript(html, "bank-data");
  const context = vm.createContext(dom.context);
  vm.runInContext(extractScript(html, "cqp-core"), context, { filename: "core.js" });
  dom.window.CQP = context.CQP;
  vm.runInContext(extractScript(html, "cqp-app"), context, { filename: "app.js" });
  return { dom, context, CQP: context.CQP, CQPUI: dom.window.CQPUI };
}

// 「旧版本/未来版本」写下的两条合法记录：用来证明阻断时磁盘数据必须原样保留
function twoRecords() {
  return [
    {
      recordKey: "小明\u0001Q-C01-S-0001\u00012026-10-04T10:00:00+08:00",
      qid: "Q-C01-S-0001",
      nickname: "小明",
      ts: "2026-10-04T10:00:00+08:00",
      localDate: "2026-10-04",
      myAnswer: ["B"],
      correct: false,
      confidence: "confident",
      color: "red",
      elapsedMs: 1000,
      mode: "practice_chapter",
      sessionId: null,
      bankVersion: "2026.08-pdf1",
      appVersion: "1.2.0",
    },
    {
      recordKey: "小明\u0001Q-C01-S-0001\u00012026-10-05T10:00:00+08:00",
      qid: "Q-C01-S-0001",
      nickname: "小明",
      ts: "2026-10-05T10:00:00+08:00",
      localDate: "2026-10-05",
      myAnswer: ["A"],
      correct: true,
      confidence: "confident",
      color: "green",
      elapsedMs: 1000,
      mode: "practice_chapter",
      sessionId: null,
      bankVersion: "2026.08-pdf1",
      appVersion: "1.2.0",
    },
  ];
}

// 一个「未来版本」的磁盘快照：meta.schemaVersion=2.0.0（不兼容）+ 2 条合法记录 + 错题本 + 覆盖层
function blockedSeed() {
  return {
    [KEY.meta]: JSON.stringify({
      schemaVersion: "2.0.0",
      appVersion: "1.2.0",
      nickname: "小明",
      deviceId: "d-7f3a91c2",
      createdAt: "2026-10-01T09:00:00+08:00",
      updatedAt: "2026-10-05T22:00:00+08:00",
    }),
    [KEY.records]: JSON.stringify(twoRecords()),
    [KEY.wrongbook]: JSON.stringify({
      "Q-C01-S-0001": { addedAt: "2026-10-04T10:00:00+08:00", state: "active", confidentStreak: 0, attemptsSinceAdd: 0 },
    }),
    [KEY.overrides]: JSON.stringify({ schemaVersion: "1.0.0", items: { "Q-C05-F-0007": { answer: ["16"], updatedAt: "2026-10-05T10:00:00+08:00", updatedBy: "小明" } } }),
    [KEY.sessions]: JSON.stringify([]),
    [KEY.imports]: JSON.stringify([]),
  };
}

// 直接读 shim 的 localStorage（DOMStorage 直读证据）
function diskSnapshot(dom) {
  const out = {};
  for (const name of Object.keys(KEY)) out[KEY[name]] = dom.storageMap.has(KEY[name]) ? dom.storageMap.get(KEY[name]) : null;
  return out;
}

// 供报告引用的 ASCII trace：每个键的长度 + 关键字段（CQP_BLOCKED_TRACE=1 时打印）
function traceDisk(tag, dom) {
  const lines = [];
  const snap = diskSnapshot(dom);
  for (const key of Object.keys(snap)) {
    const text = snap[key];
    lines.push("  " + key + " len=" + (text === null ? "null" : text.length));
  }
  const meta = snap[KEY.meta] ? JSON.parse(snap[KEY.meta]) : {};
  const records = snap[KEY.records] && snap[KEY.records].startsWith("[") ? JSON.parse(snap[KEY.records]) : null;
  lines.push("  meta.schemaVersion=" + String(meta.schemaVersion) + " meta.nickname=" + String(meta.nickname));
  lines.push("  records.count=" + (records === null ? "unparsable" : records.length));
  return "[blocked-trace] " + tag + "\n" + lines.join("\n");
}

function diskRecords(dom) {
  const text = dom.storageMap.get(KEY.records);
  return text ? JSON.parse(text) : [];
}

test("t41 F-03: schema-blocked data is never written back (pagehide / beforeunload / flush / clear-data)", () => {
  const { dom, CQPUI } = bootApp(blockedSeed());

  // 启动即阻断：横幅出现、内存 store 为空、storageOk 仍为 true（正是旧实现的漏洞）
  assert.equal(CQPUI.state.storageBlocked, true, "must enter read-only rescue mode");
  assert.equal(CQPUI.state.blockedCode, "E_VERSION");
  assert.equal(CQPUI.state.storageOk, true, "storage itself is fine; the DATA is incompatible");
  assert.equal(CQPUI.state.store.records.length, 0, "in-memory store is empty");
  const bootMemory = CQPUI.state.store.records.length;
  const banner = dom.getElementById("banner").textContent;
  assert.ok(banner.indexOf("本次运行不会写入任何数据") >= 0, "banner must state that nothing will be written");
  assert.ok(banner.indexOf("你的数据仍保存在浏览器中") >= 0, "banner must say the data is still on disk");
  // 「本地数据未被改动」只允许在「真的不写盘」时出现：这里同时用上/下面的磁盘逐键对比证明它成立
  assert.ok(banner.indexOf("本地数据未被改动") >= 0, "banner may only claim 'unchanged' together with the read-only promise");

  const before = diskSnapshot(dom);
  const beforeTrace = traceDisk("disk BEFORE unload round-trip", dom);
  assert.equal(JSON.parse(before[KEY.meta]).schemaVersion, "2.0.0");
  assert.equal(JSON.parse(before[KEY.records]).length, 2);

  // ① 卸载兜底（F5 / 关闭标签页会触发的两个事件）
  assert.ok(dom.fireWindow("pagehide") >= 1, "pagehide listener registered");
  assert.ok(dom.fireWindow("beforeunload") >= 1, "beforeunload listener registered");
  assert.deepEqual(diskSnapshot(dom), before, "unload must not touch any cqp.v1.* key");

  // ② 直接调用兜底 flush，以及「内存被改动后 flush」——同样不得落盘
  CQPUI.__test.flushPractice();
  assert.deepEqual(diskSnapshot(dom), before, "flushPractice must not write while blocked");
  CQPUI.state.store.meta.nickname = "入侵者";
  CQPUI.state.store.records.push({ qid: "Q-C99-S-0001", nickname: "入侵者", ts: "2026-10-06T10:00:00+08:00" });
  CQPUI.__test.flushPractice();
  assert.deepEqual(diskSnapshot(dom), before, "mutated memory must still not reach the disk");

  // ③ 危险区「清空本地数据」也必须被拦下（否则会把要抢救的数据删掉）
  CQPUI.__test.action("clear-data");
  assert.ok(dom.getElementById("modalRoot").innerHTML.indexOf("只读抢救模式") > 0, "clear-data is refused in rescue mode");
  assert.deepEqual(diskSnapshot(dom), before, "clear-data must not delete anything while blocked");

  // ④ 再触发一次卸载，磁盘依然逐键相同
  dom.fireWindow("pagehide");
  dom.fireWindow("beforeunload");
  assert.deepEqual(diskSnapshot(dom), before, "second unload round-trip leaves the disk untouched");

  if (process.env.CQP_BLOCKED_TRACE === "1") {
    console.log("[blocked-trace] blockedCode=" + CQPUI.state.blockedCode + " storageOk=" + CQPUI.state.storageOk + " storageBlocked=" + CQPUI.state.storageBlocked);
    console.log("[blocked-trace] memoryRecordsAtBoot=" + bootMemory + " memoryRecordsAfterLocalMutation=" + CQPUI.state.store.records.length);
    console.log(beforeTrace);
    console.log(traceDisk("disk AFTER pagehide+beforeunload+flush+clear-data", dom));
    console.log("[blocked-trace] banner=" + banner);
  }

  fs.rmSync(artifactPath, { force: true });
});

test("t41 F-03: blocked-state export reads the disk snapshot (real records + readable nickname)", () => {
  const { dom, CQPUI, CQP } = bootApp(blockedSeed());

  // 界面：导出页必须给出只读抢救说明与磁盘真实条数
  CQPUI.go("io");
  const ioHtml = dom.getElementById("main").innerHTML;
  assert.ok(ioHtml.indexOf("只读抢救模式") > 0, "io page shows the rescue notice");
  assert.ok(ioHtml.indexOf("本次运行不会写入任何数据") > 0);
  assert.ok(ioHtml.indexOf("小明") > 0, "io page shows the nickname read from disk");
  assert.ok(ioHtml.indexOf("2 条") > 0, "io page shows the disk record count");

  // 抢救 payload：来自磁盘原始数据，而不是空内存 store
  const payload = CQPUI.__test.rescueExport();
  assert.equal(payload.rescue.blocked, true);
  assert.equal(payload.rescue.reason, "E_VERSION");
  assert.equal(payload.schemaVersion, "2.0.0", "rescue file carries the detected on-disk schema version");
  assert.equal(payload.appVersion, CQP.VERSION);
  assert.equal(payload.counts.records, 2);
  assert.equal(payload.records.length, 2);
  assert.equal(payload.exportedBy.nickname, "小明", "nickname must come from the disk meta");
  assert.equal(payload.counts.overrides, 1);
  assert.equal(payload.counts.sessions, 0);
  assert.match(CQPUI.__test.rescueFileName(), /抢救导出/);

  // 走真实下载通路（替换 Blob 捕获文本）
  const captured = [];
  dom.context.Blob = class Blob {
    constructor(parts) { captured.push(String(parts[0])); }
  };
  CQPUI.__test.action("export-backup");
  assert.equal(captured.length, 1, "export-backup must download exactly one file");
  const file = JSON.parse(captured[0]);
  assert.equal(file.counts.records, 2, "the rescue file contains the real disk records");
  assert.equal(file.exportedBy.nickname, "小明");
  assert.equal(file.schemaVersion, "2.0.0");
  assert.equal(file.rescue.blocked, true);

  // 另一个导出入口（按范围导出）同样走抢救路径
  CQPUI.__test.action("export");
  assert.equal(captured.length, 2, "the range export entry also downloads a rescue file");
  assert.equal(JSON.parse(captured[1]).counts.records, 2);

  // 阻断态不写盘：导出本身也不得改动磁盘
  assert.equal(JSON.parse(dom.storageMap.get(KEY.records)).length, 2);
  assert.equal(JSON.parse(dom.storageMap.get(KEY.meta)).schemaVersion, "2.0.0");

  if (process.env.CQP_BLOCKED_TRACE === "1") {
    console.log(
      "[blocked-trace] rescue payload: counts.records=" + payload.counts.records +
        " sessions=" + payload.counts.sessions +
        " overrides=" + payload.counts.overrides +
        " nickname=" + payload.exportedBy.nickname +
        " schemaVersion=" + payload.schemaVersion +
        " rescue.blocked=" + payload.rescue.blocked +
        " firstRecordQid=" + (payload.records[0] ? payload.records[0].qid : "none") +
        " downloads=" + captured.length
    );
  }

  fs.rmSync(artifactPath, { force: true });
});

test("t41 F-03: unparsable disk content is rescued as raw strings (E_STORE_PARSE)", () => {
  const seed = blockedSeed();
  seed[KEY.records] = "{ 这不是合法 JSON：手工抢救用";
  const { dom, CQPUI } = bootApp(seed);

  assert.equal(CQPUI.state.storageBlocked, true);
  assert.equal(CQPUI.state.blockedCode, "E_STORE_PARSE");
  const banner = dom.getElementById("banner").textContent;
  assert.ok(banner.indexOf("本次运行不会写入任何数据") >= 0);
  assert.ok(banner.indexOf("原始字符串") >= 0, "banner announces the raw-string fallback");

  const payload = CQPUI.__test.rescueExport();
  assert.equal(payload.rescue.unparsableKeys.join(","), KEY.records, "only the damaged key is listed");
  assert.equal(payload.rescue.rawKeys[KEY.records], seed[KEY.records], "unparsable content is kept verbatim");
  assert.equal(payload.counts.records, 0);
  assert.equal(payload.exportedBy.nickname, "小明", "meta is still parsable, so the nickname survives");
  assert.equal(payload.schemaVersion, "2.0.0");

  // 界面明确说明会用原始字符串导出
  CQPUI.go("io");
  const ioHtml = dom.getElementById("main").innerHTML;
  assert.ok(ioHtml.indexOf("无法解析为 JSON") > 0, "io page explains the raw-string rescue");

  // 不写盘
  const before = diskSnapshot(dom);
  dom.fireWindow("pagehide");
  CQPUI.__test.flushPractice();
  assert.deepEqual(diskSnapshot(dom), before, "damaged snapshot stays byte-identical");

  fs.rmSync(artifactPath, { force: true });
});

test("t41 F-03 control: normal storage still persists (submit-to-disk, unload flush, idempotent)", () => {
  const { dom, CQP, CQPUI } = bootApp({});

  // 正常态：没有阻断
  assert.equal(CQPUI.state.storageBlocked, false);
  assert.equal(CQPUI.state.storageOk, true);
  assert.equal(dom.getElementById("banner").textContent, "", "no error banner in the normal path");

  CQPUI.state.store.meta.nickname = "小明";
  CQP.touchMeta(CQPUI.state.store, { nickname: "小明" }, CQP.isoNow());
  CQPUI.render();

  // 提交即落库（真实练习流程）
  const bank = CQP.__test.bank;
  const single = bank.questions.find((q) => q.sectionType === "single" && q.options.length === 4);
  CQPUI.__test.startPractice("practice_chapter", [single], { title: "t41 对照练习" });
  dom.setChecked([single.answer[0]]);
  CQPUI.__test.action("prac-submit");
  assert.equal(CQPUI.state.store.records.length, 1, "record written to memory on submit");
  assert.equal(diskRecords(dom).length, 1, "record written to disk on submit");
  assert.equal(JSON.parse(dom.storageMap.get(KEY.meta)).nickname, "小明", "meta is persisted in the normal path");

  // 卸载兜底照写且幂等
  dom.fireWindow("pagehide");
  assert.equal(diskRecords(dom).length, 1, "unload flush does not duplicate records");
  CQPUI.__test.flushPractice();
  CQPUI.__test.flushPractice();
  assert.equal(diskRecords(dom).length, 1, "flushPractice stays idempotent");
  assert.equal(CQPUI.state.store.records.length, 1);

  // 错题本持久化（答对着不进册；这里改成答错一次，确认错题本照写）
  CQPUI.go("practice");
  CQPUI.__test.action("prac-next");
  const second = bank.questions.find((q) => q.sectionType === "single" && q.options.length === 4 && q.id !== single.id);
  CQPUI.__test.startPractice("practice_chapter", [second], { title: "t41 对照练习 2" });
  dom.setChecked(["Z"]); // 不在选项里 -> 判错 -> 进错题本
  CQPUI.__test.action("prac-submit");
  assert.equal(diskRecords(dom).length, 2, "second record persisted");
  const book = JSON.parse(dom.storageMap.get(KEY.wrongbook));
  assert.equal(book[second.id].state, "active", "wrongbook is persisted in the normal path");

  fs.rmSync(artifactPath, { force: true });
});
