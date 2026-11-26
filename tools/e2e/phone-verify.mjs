#!/usr/bin/env node
/**
 * 手机部署验收：用无头 Chrome 打开手机上的服务，跑一遍真实登录 + 刷题 + 切题库。
 *
 *   node tools/e2e/phone-verify.mjs http://192.168.137.246:3010
 *
 * 前置：PC 上已有一个带 --remote-debugging-port=9333 的 Chrome（脚本会复用）。
 */
import fs from "node:fs";
import path from "node:path";

const BASE = (process.argv[2] || "http://192.168.137.246:3010").replace(/\/+$/, "");
const OUT = path.resolve("data/shots");
const USER = process.argv[3] || "";
const PASS = process.argv[4] || "";

let pass = 0;
let fail = 0;
function ok(label, extra) {
  pass += 1;
  console.log("  ok   " + label + (extra ? "  " + extra : ""));
}
function bad(label, extra) {
  fail += 1;
  console.log("  FAIL " + label + (extra ? "  " + extra : ""));
}
function check(cond, label, extra) {
  if (cond) ok(label, extra);
  else bad(label, extra);
}

async function cdpTargets() {
  const res = await fetch("http://127.0.0.1:9333/json/list");
  return res.json();
}

async function openTab(url) {
  const res = await fetch("http://127.0.0.1:9333/json/new?" + encodeURIComponent(url), {
    method: "PUT",
  });
  if (!res.ok) throw new Error("cannot open tab: " + res.status);
  return res.json();
}

async function closeTab(id) {
  await fetch("http://127.0.0.1:9333/json/close/" + id).catch(() => {});
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return {
    ready,
    events,
    send(method, params) {
      seq += 1;
      const id = seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
      });
    },
    close() {
      ws.close();
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalJs(conn, expression) {
  const res = await conn.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(
      "eval failed: " + (res.exceptionDetails.exception?.description || res.exceptionDetails.text)
    );
  }
  return res.result.value;
}

async function shot(conn, name) {
  const res = await conn.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(res.data, "base64"));
  console.log("  shot: " + name);
}

async function main() {
  console.log("=== phone verify: " + BASE + " ===");
  const health = await fetch(BASE + "/api/health").then((r) => r.json());
  check(health.ok === true, "手机上的服务健康", JSON.stringify(health));

  const page = await fetch(BASE + "/", { redirect: "follow" });
  const html = await page.text();
  check(page.status === 200, "首页 200");
  check(html.indexOf("cqp-app") >= 0, "首页是服务端版产物（含 app 脚本）");
  check(html.indexOf("bank-data") < 0, "产物不内联题库");

  const tab = await openTab(BASE + "/");
  const conn = connect(tab.webSocketDebuggerUrl);
  await conn.ready;
  await conn.send("Page.enable");
  await conn.send("Runtime.enable");
  await conn.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });

  // 等页面真正落地：新标签页刚建好时 document 还是 about:blank，
  // 这时候 fetch("/api/...") 会报 "Failed to parse URL from /api/auth/login"。
  // 注意别等 readyState === "complete"：走公网隧道时单文件解析很慢，
  // readyState 会长时间停在 "loading"，但 #main 已经在了、应用也已经启动。
  //
  // 关键：脚本启动之后还要再拉 /api/banks 与 /api/store，走隧道时这两步
  // 可能各要几百毫秒到几秒。只等 "CQPUI 存在" 就往下跑，会撞上
  // state.bankSlug === "" / banks 还是 0 的中间态 —— 那时 renderBankSwitcher()
  // 认为只有 0 个题库，直接把宿主清空，题库下拉根本不存在。
  //
  // 再一个坑：Page.reload 之后，第一次 evaluate 往往还打在**旧文档**上，
  // 旧文档当然是 loaded:true，于是立刻就返回了，接着读到的全是被清空的状态。
  // 所以记下旧文档的 performance.timeOrigin，等它变成另一个值（= 换了新文档）
  // 并且新文档自己也 loaded 了，才算数。
  //
  // 第三个坑：**登录前不能要求 loaded**。未登录时 /api/banks 返回 401，
  // state.bank / state.store 永远不会就位，等它必然超时。
  async function waitForPage(minTimeOrigin, timeoutMs = 90000, opts = {}) {
    const needLoaded = opts.needLoaded !== false;
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        const st = await evalJs(
          conn,
          `(() => {
             const ui = window.CQPUI;
             const s = ui && ui.state;
             return { href: location.href, ready: document.readyState,
               hasApp: !!document.getElementById("main"), booted: !!ui,
               origin: Math.round(performance.timeOrigin || 0),
               page: s ? s.page : null, bankSlug: s ? s.bankSlug : null,
               banks: s && s.banks ? s.banks.length : 0,
               loaded: !!(s && s.bank && s.store) };
           })()`
        );
        last = st;
        const landed = st.href.startsWith(BASE) && st.hasApp && st.booted;
        const fresh = !minTimeOrigin || st.origin !== minTimeOrigin;
        // 不能用 readyState === "complete" 当兜底：隧道下 readyState 早就 complete，
        // 而 /api/banks 与 /api/store 还没回来（banks=0、bank/store 都 false），
        // 那时候往下跑，题库下拉是空的。必须等到 bank 与 store 都就位。
        if (landed && fresh && (!needLoaded || st.loaded)) return st;
      } catch (err) {
        /* 页面切换中，evaluate 可能失败，继续等 */
      }
      await sleep(300);
    }
    throw new Error("page did not load: " + BASE + " last=" + JSON.stringify(last));
  }
  await waitForPage(0, 90000, { needLoaded: !(USER && PASS) });
  await sleep(300);

  try {
    // 登录
    if (USER && PASS) {
      const body = JSON.stringify({ username: USER, password: PASS });
      const login = await evalJs(
        conn,
        `(async () => {
          const r = await fetch("/api/auth/login", {method:"POST", headers:{"Content-Type":"application/json"}, body:${JSON.stringify(body)}});
          return r.status + " " + (await r.text());
        })()`
      );
      check(login.startsWith("200"), "登录成功", login.slice(0, 80));
      // 登录后必须重新载入页面（前端要在 boot 时读 /api/me），
      // 但隧道下这次载入要好几秒，不能只 sleep 一个定值就往下走。
      // 先记下旧文档的 timeOrigin，等新文档（另一个 timeOrigin）启动完成。
      const oldOrigin = await evalJs(conn, `Math.round(performance.timeOrigin || 0)`);
      await conn.send("Page.reload");
      await waitForPage(oldOrigin);
      await sleep(300);
    }

    const state = await evalJs(
      conn,
      `(() => {
        const ui = window.CQPUI;
        return { has: !!ui, user: ui && ui.state.user ? ui.state.user.username : null,
                 role: ui && ui.state.user ? ui.state.user.role : null,
                 page: ui && ui.state.page, bankSlug: ui && ui.state.bankSlug };
      })()`
    );
    check(state.has === true, "前端已启动");
    check(!!state.user, "已登录", "user=" + state.user + " role=" + state.role);

    const navCount = await evalJs(conn, `document.querySelectorAll("#nav button").length`);
    check(navCount >= 8, "导航按钮齐全", "count=" + navCount);

    const banks = await evalJs(
      conn,
      `(async () => (await (await fetch("/api/banks")).json()).banks.map(b => b.slug + ":" + b.questionCount))()`
    );
    check(banks.length >= 3, "三个题库都在", banks.join(" "));

    // 切到 crypto 题库
    const switched = await evalJs(
      conn,
      `(async () => {
         const sel = document.querySelector('select[data-act="bank-switch"]');
         if (!sel) return "no-select";
         sel.value = "crypto";
         sel.dispatchEvent(new Event("change", {bubbles:true}));
         await new Promise(r => setTimeout(r, 1500));
         return window.CQPUI.state.bankSlug + "|" + (window.CQPUI.state.bank ? window.CQPUI.state.bank.title : "");
       })()`
    );
    check(String(switched).startsWith("crypto"), "题库切换器可用", String(switched));
    await shot(conn, "phone-crypto-home");

    // 开始一组练习
    const practice = await evalJs(
      conn,
      `(async () => {
         const ui = window.CQPUI;
         ui.go("setup");
         await new Promise(r => setTimeout(r, 300));
         const start = document.querySelector('[data-act="start-practice"]');
         if (!start) return "no-start";
         start.click();
         await new Promise(r => setTimeout(r, 1500));
         return (ui.state.practice ? "practice:" + ui.state.practice.questions.length : "no-practice");
       })()`
    );
    check(String(practice).startsWith("practice:"), "开始一组练习", String(practice));

    const answered = await evalJs(
      conn,
      `(async () => {
         const ui = window.CQPUI;
         const p = ui.state.practice;
         if (!p) return "no-practice";
         const q = p.questions[p.idx];
         const box = document.querySelector('input[name="opt"]');
         if (box) { box.checked = true; box.dispatchEvent(new Event("change", {bubbles:true})); }
         await new Promise(r => setTimeout(r, 200));
         const btn = document.querySelector('[data-act="prac-submit"]');
         if (!btn) return "no-submit";
         btn.click();
         await new Promise(r => setTimeout(r, 1200));
         const item = ui.__test.practiceItem(p.idx);
         return (item && item.submitted ? "submitted" : "not-submitted") + "|" + (item && item.correct ? "correct" : "wrong");
       })()`
    );
    check(String(answered).startsWith("submitted"), "提交判分成功（服务端判分）", String(answered));
    await shot(conn, "phone-practice-answered");

    // 服务端真的存了记录
    const stored = await evalJs(
      conn,
      `(async () => {
         const r = await fetch("/api/store?bank=crypto");
         const d = await r.json();
         return d.store.records.length;
       })()`
    );
    check(Number(stored) > 0, "作答记录已存到手机上的库", "records=" + stored);

    // 模拟考确认页（小题库降级）
    const mock = await evalJs(
      conn,
      `(async () => {
         window.CQPUI.go("mock");
         await new Promise(r => setTimeout(r, 900));
         const txt = document.getElementById("main").innerText;
         return txt.indexOf("题库不足 100 题") >= 0 ? "degraded" : "full100";
       })()`
    );
    check(mock === "degraded", "小题库模拟考按实际题数显示", mock);
    await shot(conn, "phone-mock-setup");

    const errors = conn.events.filter(
      (e) => e.method === "Runtime.exceptionThrown" || (e.method === "Runtime.consoleAPICalled" && e.params.type === "error")
    );
    check(errors.length === 0, "无 console error / 未捕获异常", errors.length ? JSON.stringify(errors[0]).slice(0, 200) : "");
  } finally {
    conn.close();
    await closeTab(tab.id);
  }

  console.log("");
  if (fail === 0) console.log("=== phone verify: ALL PASS (" + pass + ") ===");
  else console.log("=== phone verify: " + fail + " FAILED / " + (pass + fail) + " ===");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("phone verify crashed:", err && err.message ? err.message : err);
  process.exit(1);
});
