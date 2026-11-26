// 用 Chrome DevTools Protocol 直接驱动无头 Chrome：登录 → 逐页截图
// 零依赖：手写 WebSocket 客户端（Node 22+ 自带，这里用 http 升级 + 帧编解码）
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = "http://127.0.0.1:3010";
const OUT = "data/shots";
mkdirSync(OUT, { recursive: true });

const PORT = 9333;
const PROFILE = process.cwd() + "\\data\\chrome-profile";
let chrome = null;

async function ensureChrome() {
  // 已经有一个在跑就直接用（反复调试时省去重启）
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (res.ok) {
      console.log("attach to running chrome");
      return await res.json();
    }
  } catch { /* not running */ }
  chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--hide-scrollbars",
    `--user-data-dir=${PROFILE}`,
    "about:blank",
  ], { stdio: "ignore" });
  return await waitPort();
}

async function waitPort() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch { /* not ready */ }
    await delay(150);
  }
  throw new Error("chrome devtools not ready");
}

// 用 Node 内置的 WebSocket（Node 22+ 全局可用）
async function main() {

// 用 Node 内置的 WebSocket（Node 22+ 全局可用）
  const info = await ensureChrome();
  console.log("devtools ready:", info.Browser);
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
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
      return;
    }
    events.push(msg);
  });
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });

  function send(method, params = {}) {
    const id = (seq += 1);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");

  async function evaluate(expr) {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("eval failed: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }

  async function goto(url) {
    await send("Page.navigate", { url });
    for (let i = 0; i < 120; i += 1) {
      await delay(120);
      const ready = await evaluate("document.readyState").catch(() => "");
      if (ready === "complete") break;
    }
    await delay(400);
  }

  async function shot(name, height = 900) {
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440, height, deviceScaleFactor: 1, mobile: false,
    });
    await delay(250);
    const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const file = `${OUT}/${name}.png`;
    writeFileSync(file, Buffer.from(r.data, "base64"));
    console.log("shot:", file);
    return file;
  }

  // 1) 落地 / 登录页（已登录时先退出，才能截到登录界面）
  await goto(BASE + "/");
  const loggedIn = await evaluate("!!(window.CQPUI && window.CQPUI.state && window.CQPUI.state.user)");
  if (loggedIn) {
    await goto(BASE + "/");
    await evaluate(`(function(){
      var b = document.querySelector('#whoami button[data-act="account"]');
      if (b) { b.click(); return 1; }
      return 0;
    })()`);
    await delay(400);
    await evaluate(`(function(){
      var b = document.querySelector('[data-act="logout"]');
      if (b) { b.click(); return 1; }
      return 0;
    })()`);
    await delay(900);
  }
  await goto(BASE + "/");
  await shot("01-login", 820);

  // 2) 通过真实 UI 注册一个管理员（DB 若是新的）
  const stamp = Date.now().toString(36).slice(-6);
  const user = "shot" + stamp;
  const registered = await evaluate(`
    (function(){
      var tab = document.querySelector('[data-tab="register"]');
      if (!tab) return "already-in";
      tab.click();
      document.getElementById("authUser").value = ${JSON.stringify(user)};
      var nick = document.getElementById("authNick");
      if (nick) nick.value = "截图测试员";
      document.getElementById("authPass").value = "shotpass123";
      document.getElementById("authForm").dispatchEvent(new Event("submit", {cancelable:true, bubbles:true}));
      return "submitted";
    })()
  `);
  console.log("register:", registered);
  await delay(2200);
  const who = await evaluate("(document.getElementById('whoami').textContent||'').trim()");
  console.log("whoami after register:", JSON.stringify(who));
  await shot("02-home", 1100);

  // 3) 各页面
  const pages = [
    ["setup", "03-setup"],
    ["wrongbook", "04-wrongbook"],
    ["stats", "05-stats"],
    ["team", "06-team"],
    ["io", "07-io"],
    ["mock", "08-mock"],
    ["review", "09-review"],
    ["admin", "10-admin"],
  ];
  for (const [page, name] of pages) {
    await evaluate(`
      (function(){
        var b = document.querySelector('#nav button[data-nav="${page}"]');
        if (!b) return "no-nav";
        b.click();
        return "ok";
      })()
    `);
    await delay(900);
    const head = await evaluate("(document.getElementById('main').innerText||'').slice(0,120)");
    console.log(`${page}: ${JSON.stringify(head.replace(/\\s+/g, ' '))}`);
    await shot(name, 1000);
  }

  // 4) 控制台错误检查
  const errors = events
    .filter((e) => e.method === "Runtime.consoleAPICalled" && e.params.type === "error")
    .map((e) => (e.params.args || []).map((a) => a.value || a.description || "").join(" "));
  const exceptions = events
    .filter((e) => e.method === "Runtime.exceptionThrown")
    .map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
  console.log("console errors:", errors.length, JSON.stringify(errors.slice(0, 5)));
  console.log("exceptions:", exceptions.length, JSON.stringify(exceptions.slice(0, 5)));

  ws.close();
  if (chrome) chrome.kill();
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  if (chrome) { try { chrome.kill(); } catch { /* ignore */ } }
  process.exit(1);
});
