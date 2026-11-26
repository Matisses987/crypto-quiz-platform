// 服务端版 UI harness：把 `build({ target: "server" })` 的产物跑进 DOM shim，
// 并把 `fetch` 换成**直接调用 server/* 真实实现**的桩（同一个 :memory: 库）。
//
// 为什么不用假数据：服务端语义（rev 乐观锁、mergeDocs 合并、服务端判分、模拟考落库）
// 正是这批测试要验证的东西。桩里另写一份合并逻辑，测的就变成桩而不是产品。
//
// 用法：
//   const app = await createServerApp({ nickname: "小明" });
//   app.CQPUI.go("io");
//   await app.settle();          // 跑干微任务 + 触发 250ms 防抖的 PUT
//   app.serverStore().records;   // 服务端权威副本
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "../../tools/build.mjs";
import { createDom } from "./domshim.mjs";
import { openDb, one, run, nowIso } from "../../server/db.js";
import { ensureBuiltinBank, servedBank, listBanks, BUILTIN_SLUG } from "../../server/banks.js";
import {
  readStore,
  writeStore,
  clearStore,
  importExport,
  gradePractice,
  fetchAnswers,
  teamSummary,
  resolveSlug,
} from "../../server/routes-data.js";
import { startMock, currentMock, saveResponses, submitMock, abandonMock, listMocks } from "../../server/mock.js";
import { HttpError } from "../../server/http.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, "..", "..");
export const realBankPath = path.join(root, "src", "data", "bank.json");

/* ------------------------------------------------------------------ 构建产物 */

let artifactCache = null;

/** 服务端目标产物：没有 bank-data，app.js 全走 /api/* */
export function serverArtifact() {
  if (artifactCache) return artifactCache;
  const report = build({ target: "server", write: false, reportPath: null });
  artifactCache = {
    report,
    html: report.html,
    coreJs: extractScript(report.html, "cqp-core"),
    appJs: extractScript(report.html, "cqp-app"),
  };
  return artifactCache;
}

export function extractScript(html, id) {
  const start = html.indexOf('<script id="' + id + '"');
  if (start < 0) throw new Error("missing script " + id);
  const openEnd = html.indexOf(">", start);
  const close = html.indexOf("</script>", openEnd);
  if (openEnd < 0 || close < 0) throw new Error("malformed script " + id);
  return html.slice(openEnd + 1, close);
}

/* --------------------------------------------------------------- 服务端沙箱 */

let sandboxReady = false;

/** 每个测试文件是一个独立进程，所以这里用 :memory: 库 + 内置题库种子即可 */
export function ensureServerSandbox() {
  if (sandboxReady) return;
  openDb(":memory:");
  ensureBuiltinBank();
  sandboxReady = true;
}

const realBank = JSON.parse(fs.readFileSync(realBankPath, "utf8"));

/** 真题库（带 answer/explanation）—— 测试侧要拿标准答案只能从这里，下发的是脱答案版本 */
export function bankWithAnswers() {
  return realBank;
}

let userSeq = 0;

function createTestUser(nickname, username) {
  userSeq += 1;
  const uname = username || "tester" + String(userSeq).padStart(3, "0");
  run(
    "INSERT INTO users (username, pass_hash, display_name, role, created_at) VALUES (?, ?, ?, 'user', ?)",
    uname,
    "test-only-hash",
    nickname,
    nowIso()
  );
  const row = one("SELECT id, username, display_name, role FROM users WHERE username = ?", uname);
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role };
}

/* -------------------------------------------------------------------- 时钟 */

function makeClock() {
  let seq = 0;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    setTimeout(fn, ms) {
      seq += 1;
      timeouts.set(seq, { fn, ms: Number(ms) || 0 });
      return seq;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    setInterval(fn, ms) {
      seq += 1;
      intervals.set(seq, { fn, ms: Number(ms) || 0 });
      return seq;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    pendingTimeouts() {
      return timeouts.size;
    },
    runTimeouts() {
      const jobs = Array.from(timeouts.values());
      timeouts.clear();
      for (const job of jobs) job.fn();
      return jobs.length;
    },
    intervalFns() {
      return Array.from(intervals.values()).map((job) => job.fn);
    },
    /** 定时器的真实注册信息（含 ms），用来断言「500ms 轮询」这类节奏 */
    intervalJobs() {
      return Array.from(intervals.values()).map((job) => ({ fn: job.fn, ms: job.ms }));
    },
    tickIntervals() {
      const fns = this.intervalFns();
      for (const fn of fns) fn();
      return fns.length;
    },
  };
}

/* ------------------------------------------------------------- fetch 桩 */

function responseOf(status, payload) {
  const text = payload === undefined ? "" : JSON.stringify(payload);
  return {
    status,
    ok: status >= 200 && status < 300,
    text() {
      return Promise.resolve(text);
    },
    json() {
      return Promise.resolve(payload);
    },
  };
}

function splitUrl(url) {
  const q = url.indexOf("?");
  const pathname = q < 0 ? url : url.slice(0, q);
  const query = new URLSearchParams(q < 0 ? "" : url.slice(q + 1));
  return { pathname, query };
}

const ADMIN_EMPTY = {
  "/api/admin/users": { users: [] },
  "/api/admin/banks": { banks: [] },
  "/api/admin/audit": { items: [] },
};

function dispatch(state, method, url, body) {
  const { pathname, query } = splitUrl(url);
  const userId = () => {
    if (!state.user) throw new HttpError(401, "请先登录");
    return state.user.id;
  };

  if (pathname === "/api/me") return { user: state.user, serverTime: nowIso() };

  if (pathname === "/api/banks") {
    userId();
    return { banks: listBanks() };
  }
  if (pathname.startsWith("/api/banks/")) {
    userId();
    const slug = decodeURIComponent(pathname.slice("/api/banks/".length));
    return JSON.parse(servedBank(slug).json);
  }

  if (pathname === "/api/store") {
    if (method === "GET") {
      const doc = readStore(userId(), resolveSlug(query.get("bank")));
      return {
        rev: doc.rev,
        bankSlug: doc.bankSlug,
        store: doc.store,
        serverTime: nowIso(),
        updatedAt: doc.updatedAt,
      };
    }
    if (method === "PUT") return writeStore(userId(), body || {});
    if (method === "DELETE") return clearStore(userId(), resolveSlug(query.get("bank")));
  }

  // 服务端合并导入（records/overrides/sessions 走 CQP.mergeImport，wrongbook 走 LWW）
  if (pathname === "/api/store/import" && method === "POST") return importExport(userId(), body || {});

  if (pathname === "/api/practice/grade" && method === "POST") return gradePractice(userId(), body || {});
  if (pathname === "/api/practice/answers" && method === "POST") return fetchAnswers(userId(), body || {});

  if (pathname === "/api/team/summary") {
    userId();
    return teamSummary(resolveSlug(query.get("bank")));
  }

  if (pathname === "/api/mock/start" && method === "POST") {
    return startMock(userId(), resolveSlug(body && body.bankSlug));
  }
  if (pathname === "/api/mock/current") return { exam: currentMock(userId(), resolveSlug(query.get("bank"))).exam };
  if (pathname === "/api/mock/list") {
    return listMocks(userId(), query.get("bank") ? resolveSlug(query.get("bank")) : "", query.get("limit"));
  }

  const mockRoute = pathname.match(/^\/api\/mock\/([^/]+)\/(responses|submit|abandon)$/);
  if (mockRoute) {
    const uid = userId();
    const examId = decodeURIComponent(mockRoute[1]);
    if (mockRoute[2] === "responses") return saveResponses(uid, examId, body && body.responses);
    if (mockRoute[2] === "submit") return submitMock(uid, examId, body || {});
    return abandonMock(uid, examId);
  }

  if (pathname === "/api/auth/logout") {
    state.user = null;
    return { ok: true };
  }
  if (pathname === "/api/auth/login" || pathname === "/api/auth/register") {
    const username = String((body && body.username) || "").trim();
    const displayName = String((body && body.displayName) || "").trim() || username;
    state.user = createTestUser(displayName, username);
    return { user: state.user };
  }
  if (pathname === "/api/auth/profile") {
    const id = userId();
    const displayName = String((body && body.displayName) || "").slice(0, 20);
    run("UPDATE users SET display_name = ? WHERE id = ?", displayName, id);
    state.user = Object.assign({}, state.user, { displayName });
    return { user: state.user };
  }
  if (pathname === "/api/auth/password") {
    userId();
    return { ok: true };
  }
  if (ADMIN_EMPTY[pathname]) {
    userId();
    return ADMIN_EMPTY[pathname];
  }

  throw new HttpError(404, "资源不存在：" + pathname);
}

/* ------------------------------------------------------------------- 启动 */

/**
 * 启动服务端版 UI。
 * @param {{nickname?:string, username?:string, anonymous?:boolean, bankSlug?:string}} options
 */
export async function createServerApp(options = {}) {
  ensureServerSandbox();
  const bankSlug = options.bankSlug || BUILTIN_SLUG;
  const nickname = options.nickname || "小明";
  const state = { user: options.anonymous ? null : createTestUser(nickname, options.username) };

  const artifact = serverArtifact();
  const dom = createDom();
  const clock = makeClock();
  const calls = [];

  const fetchStub = (input, init) => {
    const opts = init || {};
    const method = String(opts.method || "GET").toUpperCase();
    const url = String(input);
    let body = null;
    if (typeof opts.body === "string") {
      try {
        body = JSON.parse(opts.body);
      } catch {
        body = null;
      }
    }
    calls.push({ method, url, body });
    try {
      return Promise.resolve(responseOf(200, dispatch(state, method, url, body)));
    } catch (err) {
      const status = Number(err && err.status) || 500;
      return Promise.resolve(responseOf(status, { error: (err && err.message) || "服务器内部错误" }));
    }
  };

  // domshim 的 FileReader 只会触发 onerror（离线单文件时代没人走导入路径），
  // 服务端版导入走「选文件 → FileReader.readAsText」，所以这里换成一个能真读文本的桩。
  class TestFileReader {
    readAsText(file) {
      this.result = String(file && file.__text !== undefined ? file.__text : "");
      if (typeof this.onload === "function") this.onload();
    }
  }
  dom.context.FileReader = TestFileReader;
  dom.window.FileReader = TestFileReader;

  dom.context.fetch = fetchStub;
  dom.window.fetch = fetchStub;
  dom.window.setTimeout = (fn, ms) => clock.setTimeout(fn, ms);
  dom.window.clearTimeout = (id) => clock.clearTimeout(id);
  dom.window.setInterval = (fn, ms) => clock.setInterval(fn, ms);
  dom.window.clearInterval = (id) => clock.clearInterval(id);
  dom.context.setTimeout = dom.window.setTimeout;
  dom.context.clearTimeout = dom.window.clearTimeout;
  dom.context.setInterval = dom.window.setInterval;
  dom.context.clearInterval = dom.window.clearInterval;

  const context = vm.createContext(dom.context);
  vm.runInContext(artifact.coreJs, context, { filename: "cqp-core.js" });
  dom.window.CQP = context.CQP;
  vm.runInContext(artifact.appJs, context, { filename: "cqp-app.js" });

  const drain = (times) => {
    let chain = Promise.resolve();
    for (let i = 0; i < times; i += 1) chain = chain.then(() => new Promise((r) => setImmediate(r)));
    return chain;
  };

  async function flush(times = 10) {
    await drain(times);
  }

  async function settle(rounds = 12) {
    for (let i = 0; i < rounds; i += 1) {
      await drain(3);
      if (clock.pendingTimeouts() === 0) {
        if (i > 0) return;
        continue;
      }
      clock.runTimeouts();
    }
  }

  const app = {
    dom,
    context,
    clock,
    calls,
    artifact,
    bankSlug,
    user: state.user,
    get CQP() {
      return context.CQP;
    },
    get CQPUI() {
      return dom.window.CQPUI;
    },
    get state() {
      return dom.window.CQPUI.state;
    },
    main() {
      return dom.getElementById("main").innerHTML;
    },
    nickname() {
      return dom.getElementById("whoami").innerHTML;
    },
    flush,
    settle,
    /** 记录里最后一次匹配的调用 */
    lastCall(pattern) {
      const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
      for (let i = calls.length - 1; i >= 0; i -= 1) {
        if (re.test(calls[i].method + " " + calls[i].url)) return calls[i];
      }
      return null;
    },
    callsMatching(pattern) {
      const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
      return calls.filter((c) => re.test(c.method + " " + c.url));
    },
    /** 服务端权威副本 */
    serverStore() {
      return readStore(state.user.id, bankSlug).store;
    },
    serverRev() {
      return readStore(state.user.id, bankSlug).rev;
    },
    serverUser() {
      return state.user;
    },
    /** 直接读服务端库里的模拟考场次 */
    serverExam(id) {
      return one("SELECT * FROM mock_exams WHERE id = ?", id);
    },
  };

  await settle();
  return app;
}

/* -------------------------------------------------------------- 小工具 */

/** 全角数字/字母 —— 填空题判分要能吃全角输入 */
export function fullWidth(text) {
  return String(text).replace(/[!-~]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).replace(/ /g, "\u3000");
}

/** 造一个只有 getAttribute/closest 的假控件（给 CQPUI.__test.action 用） */
export function fakeActionElement(attributes) {
  const attrs = Object.assign({}, attributes || {});
  const node = {
    tagName: "BUTTON",
    type: "",
    value: "",
    checked: false,
    files: [],
    disabled: false,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    closest(selector) {
      return selector === "[data-act]" && attrs["data-act"] ? node : null;
    },
  };
  return node;
}

/** 从服务端题库里挑一道指定题型的题（带标准答案的版本） */
export function pickQuestion(bank, sectionType, predicate) {
  return bank.questions.find((q) => q.sectionType === sectionType && (!predicate || predicate(q)));
}
