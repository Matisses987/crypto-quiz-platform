// t37: application version 1.0.0 -> 1.1.0 must stay backward compatible.
// The bank / store / export schema versions are frozen at 1.0.0, so a legacy export file
// and a legacy localStorage snapshot written by 1.0.0 must still load, and the shipped UI
// must show the new app version together with the unchanged bank version.
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
import { CQP } from "../src/core/index.mjs";
import { cn_VERSION, cn_BANK_SCHEMA_VERSION, cn_STORE_SCHEMA_VERSION, cn_EXPORT_SCHEMA_VERSION } from "../src/core/constants.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const realBankPath = path.join(root, "src", "data", "bank.json");
const fixturePath = path.join(here, "fixtures", "bank.sample.json");
// t46 O-01：临时产物写系统临时目录，绝不落在交付目录 dist/
const artifactPath = path.join(os.tmpdir(), "__cqp_version_test.html");
const bank = JSON.parse(fs.readFileSync(fs.existsSync(realBankPath) ? realBankPath : fixturePath, "utf8"));
const BANK_VERSION = bank.bankVersion;

// 旧版本（1.0.0）的文件/快照代表值：只用来构造「历史数据」，**不是**对当前应用版本的断言。
// 当前应用版本一律用 CQP.VERSION 断言，所以将来再升版时本文件无需改动。
const LEGACY_APP_VERSION = "1.0.0";
// 三个 schema 版本是冻结口径（动它会让队友已导出的文件被判 E_VERSION）。
const FROZEN_SCHEMA = "1.0.0";

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

// 与 app.js 相同的作答记录入参（omit appVersion 时核心应回填当前应用版本）
function mkInput(extra) {
  return Object.assign(
    {
      question: CQP.__test.makeQuestion({ sectionType: "single", answer: ["A"] }),
      myAnswer: ["A"],
      confidence: "confident",
      elapsedMs: 1000,
      mode: "practice_chapter",
      nickname: "小明",
      bankVersion: BANK_VERSION,
      nowISO: "2026-10-05T21:14:03+08:00",
    },
    extra || {}
  );
}

function extractScript(html, id) {
  const start = html.indexOf('<script id="' + id + '"');
  assert.ok(start > 0, "missing script " + id);
  const openEnd = html.indexOf(">", start);
  const close = html.indexOf("</script>", openEnd);
  return html.slice(openEnd + 1, close);
}

function bootApp() {
  const bankPath = fs.existsSync(realBankPath) ? realBankPath : fixturePath;
  const result = build({ bankPath, outPath: artifactPath, reportPath: null });
  assert.equal(result.ok, true, "build must succeed so the shipped artifact can be inspected");
  const html = fs.readFileSync(artifactPath, "utf8");
  const dom = createDom();
  dom.getElementById("bank-data").textContent = extractScript(html, "bank-data");
  const context = vm.createContext(dom.context);
  vm.runInContext(extractScript(html, "cqp-core"), context, { filename: "core.js" });
  dom.window.CQP = context.CQP;
  vm.runInContext(extractScript(html, "cqp-app"), context, { filename: "app.js" });
  return { dom, html, CQP: context.CQP, CQPUI: dom.window.CQPUI };
}

test("t37 version constants: app version is semver, all three schema versions stay frozen", () => {
  assert.equal(CQP.VERSION, cn_VERSION, "facade VERSION must be the constants module value");
  assert.match(CQP.VERSION, /^\d+\.\d+\.\d+$/, "app version must be semver-shaped");
  assert.equal(cn_BANK_SCHEMA_VERSION, FROZEN_SCHEMA);
  assert.equal(cn_STORE_SCHEMA_VERSION, FROZEN_SCHEMA);
  assert.equal(cn_EXPORT_SCHEMA_VERSION, FROZEN_SCHEMA);
  assert.equal(CQP.BANK_SCHEMA_VERSION, FROZEN_SCHEMA);
  assert.equal(CQP.STORE_SCHEMA_VERSION, FROZEN_SCHEMA);
  assert.equal(CQP.EXPORT_SCHEMA_VERSION, FROZEN_SCHEMA);
  assert.equal(bank.schemaVersion, FROZEN_SCHEMA, "bank data schemaVersion must not move with the app version");
  assert.equal(BANK_VERSION, "2026.08-pdf1");
});

test("t37 export / record / meta carry the current app version with the frozen schemas", () => {
  const store = CQP.emptyStore();
  store.meta.nickname = "小明";
  store.records = [CQP.makeRecord(mkInput({ myAnswer: ["A"] }))];

  const payload = CQP.exportPayload({
    store,
    scope: "all",
    nickname: "小明",
    bankVersion: BANK_VERSION,
    nowISO: "2026-10-06T22:30:15+08:00",
  });
  assert.equal(payload.kind, "cqp-export");
  assert.equal(payload.schemaVersion, FROZEN_SCHEMA, "export schema stays 1.0.0");
  assert.equal(payload.appVersion, CQP.VERSION, "export carries the current app version");
  assert.equal(payload.bankVersion, BANK_VERSION);

  // 新建作答记录：核心缺省即当前应用版本（app.js 亦显式传 CQP.VERSION）
  const record = CQP.makeRecord(mkInput({ myAnswer: ["A"] }));
  assert.equal(record.appVersion, CQP.VERSION);

  // store meta：schemaVersion 冻结，appVersion 在写入时刷新为当前版本
  const touched = CQP.touchMeta(CQP.emptyStore(), { nickname: "小明" }, "2026-10-05T12:00:00+08:00");
  assert.equal(touched.meta.schemaVersion, FROZEN_SCHEMA);
  assert.equal(touched.meta.appVersion, CQP.VERSION);
});

test("t37 legacy 1.0.0 export file still validates (no E_VERSION) and merges with correct team stats", () => {
  // 队友用旧版导出的文件：schemaVersion 1.0.0（冻结）+ appVersion 1.0.0（旧应用版本）
  const legacyStore = CQP.emptyStore();
  legacyStore.meta.nickname = "小红";
  legacyStore.meta.deviceId = "d-1a2b3c4d";
  legacyStore.records = [
    CQP.makeRecord(mkInput({ nickname: "小红", myAnswer: ["B"], nowISO: "2026-10-05T10:00:00+08:00" })),
    CQP.makeRecord(mkInput({ nickname: "小红", myAnswer: ["A"], nowISO: "2026-10-05T11:00:00+08:00" })),
  ];
  const legacyFile = CQP.exportPayload({
    store: legacyStore,
    scope: "all",
    nickname: "小红",
    bankVersion: BANK_VERSION,
    nowISO: "2026-10-06T22:30:15+08:00",
  });
  legacyFile.appVersion = LEGACY_APP_VERSION;
  // 旧版导出的文件里，逐条作答记录也带着旧的应用版本
  legacyFile.records = legacyFile.records.map((r) => Object.assign({}, r, { appVersion: LEGACY_APP_VERSION }));
  const text = JSON.stringify(legacyFile);
  assert.ok(text.indexOf('"schemaVersion":"' + FROZEN_SCHEMA + '"') >= 0, "legacy file keeps schema 1.0.0");
  assert.ok(text.indexOf('"appVersion":"' + LEGACY_APP_VERSION + '"') >= 0, "legacy file keeps appVersion 1.0.0");

  const validated = CQP.validateImport(text);
  assert.equal(validated.ok, true, "legacy file must pass validation: " + JSON.stringify(validated.errors));
  assert.equal(validated.errors.length, 0);
  assert.equal(validated.errors.filter((e) => e.code === "E_VERSION").length, 0, "no E_VERSION for a 1.x file");

  // 本地已有一条小明的错答 → 合并后团队易错题（≥2 人答错）应命中 Q-C01-S-0001
  const target = CQP.emptyStore();
  target.meta.nickname = "小明";
  target.meta.deviceId = "d-7f3a91c2";
  target.records = [CQP.makeRecord(mkInput({ nickname: "小明", myAnswer: ["B"], nowISO: "2026-10-05T09:00:00+08:00" }))];
  const merged = CQP.mergeImport({
    store: target,
    payload: validated.payload,
    questions: bank.questions,
    bankVersion: BANK_VERSION,
    fileName: "legacy-1.0.0.json",
  });
  assert.equal(merged.report.ok, true);
  assert.equal(merged.report.importedRecords, 2, "both legacy records are imported");
  assert.equal(merged.report.duplicates, 0);
  assert.equal(merged.report.skipped.length, 0, JSON.stringify(merged.report.skipped));
  assert.equal(merged.store.records.length, 3);

  const stats = CQP.teamStats({ records: merged.store.records, questions: bank.questions });
  const row = stats.teamWrongQuestions.filter((r) => r.qid === "Q-C01-S-0001")[0];
  assert.ok(row, "Q-C01-S-0001 must be listed as a team wrong question");
  assert.equal(row.wrongUsers, 2);
  assert.equal(row.wrongUserNames.length, 2);
  assert.ok(row.wrongUserNames.indexOf("小红") >= 0 && row.wrongUserNames.indexOf("小明") >= 0);
  assert.equal(stats.members.length, 2);
  assert.deepEqual(stats.members.map((m) => m.nickname).slice().sort(), ["小明", "小红"].sort());

  // 旧记录里的旧 appVersion 原样保留（不被拒收、也不影响统计）
  const imported = merged.store.records.filter((r) => r.nickname === "小红")[0];
  assert.equal(imported.appVersion, LEGACY_APP_VERSION);
});

test("t37 legacy localStorage snapshot (meta.appVersion 1.0.0) loads, stays usable and upgrades on next write", () => {
  const backend = memoryBackend();
  useBackend(backend);
  // 旧版应用写下的数据：meta 里 schemaVersion 1.0.0 + appVersion 1.0.0
  backend.setItem(
    CQP.STORAGE_KEYS.meta,
    JSON.stringify({
      schemaVersion: FROZEN_SCHEMA,
      appVersion: LEGACY_APP_VERSION,
      nickname: "小明",
      deviceId: "d-7f3a91c2",
      createdAt: "2026-10-04T09:00:00+08:00",
      updatedAt: "2026-10-04T09:00:00+08:00",
    })
  );
  backend.setItem(
    CQP.STORAGE_KEYS.records,
    JSON.stringify([
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
        bankVersion: BANK_VERSION,
        appVersion: LEGACY_APP_VERSION,
      },
    ])
  );
  backend.setItem(
    CQP.STORAGE_KEYS.wrongbook,
    JSON.stringify({
      "Q-C01-S-0001": {
        addedAt: "2026-10-04T10:00:00+08:00",
        state: "active",
        confidentStreak: 0,
        attemptsSinceAdd: 0,
      },
    })
  );

  const loaded = CQP.storage.load(); // 不得抛错（不判 E_VERSION）
  assert.equal(loaded.meta.nickname, "小明");
  assert.equal(loaded.meta.schemaVersion, FROZEN_SCHEMA);
  assert.equal(loaded.meta.appVersion, LEGACY_APP_VERSION, "load keeps the stored appVersion (no rewrite on read)");
  assert.equal(loaded.records.length, 1);
  assert.equal(loaded.wrongbook["Q-C01-S-0001"].state, "active");

  // 还能继续作答
  const appended = CQP.appendRecord(loaded, CQP.makeRecord(mkInput({ nickname: "小明", myAnswer: ["A"], nowISO: "2026-10-05T22:00:00+08:00" })));
  assert.equal(appended.added, true);
  assert.equal(appended.store.records.length, 2);

  // 下一次写入 meta → appVersion 升为当前版本，schemaVersion 仍冻结（store 既有行为）
  const touched = CQP.touchMeta(appended.store, { nickname: "小明" }, "2026-10-05T22:05:00+08:00");
  assert.equal(touched.meta.appVersion, CQP.VERSION);
  assert.equal(touched.meta.schemaVersion, FROZEN_SCHEMA);
  assert.equal(CQP.storage.save(touched).ok, true);
  const reloaded = CQP.storage.load();
  assert.equal(reloaded.meta.appVersion, CQP.VERSION);
  assert.equal(reloaded.meta.schemaVersion, FROZEN_SCHEMA);
  assert.equal(reloaded.records.length, 2);
  assert.equal(reloaded.wrongbook["Q-C01-S-0001"].state, "active");
});

test("t37 shipped artifact shows the app version in the brand badge and on the home page", () => {
  const { dom, html, CQP: ACQP, CQPUI } = bootApp();

  // 成品内字符串：构建时 {{APP_VERSION}} / {{BANK_VERSION}} 已替换（无占位符残留）
  assert.ok(
    html.indexOf("v" + ACQP.VERSION + " · 题库 " + BANK_VERSION) >= 0,
    "brand badge must read v<VERSION> · 题库 <bankVersion>"
  );
  assert.equal(html.indexOf("{{APP_VERSION}}"), -1, "no unsubstituted APP_VERSION placeholder");
  assert.equal(html.indexOf("{{BANK_VERSION}}"), -1, "no unsubstituted BANK_VERSION placeholder");

  // 首页「数据与题库」卡片
  CQPUI.state.store.meta.nickname = "小明";
  ACQP.touchMeta(CQPUI.state.store, { nickname: "小明" }, ACQP.isoNow());
  CQPUI.render();
  const home = dom.getElementById("main").innerHTML;
  assert.ok(home.indexOf("数据与题库") >= 0, "home page renders the data card");
  assert.ok(home.indexOf("应用版本") >= 0);
  assert.ok(home.indexOf(ACQP.VERSION) >= 0, "home page shows the current app version");
  assert.ok(home.indexOf(BANK_VERSION) >= 0, "home page still shows the bank version");

  // 统计页渲染正常，且共用同一品牌角标（模板在 #main 之外）
  CQPUI.go("stats");
  assert.ok(dom.getElementById("main").innerHTML.length > 400, "stats page renders");
  const brandAt = html.indexOf('class="brand"');
  assert.ok(brandAt >= 0, "artifact contains the brand badge");
  const brand = html.slice(brandAt, brandAt + 240);
  assert.ok(brand.indexOf("v" + ACQP.VERSION) >= 0, "brand badge in the shipped artifact carries the app version");
  assert.ok(brand.indexOf(BANK_VERSION) >= 0, "brand badge carries the bank version");

  fs.rmSync(artifactPath, { force: true });
});
