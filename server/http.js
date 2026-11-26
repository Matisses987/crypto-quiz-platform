// HTTP 工具层：路由分发、JSON 读写、静态文件、cookie、客户端 IP
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, msg, details);
export const unauthorized = (msg = "请先登录") => new HttpError(401, msg);
export const forbidden = (msg = "没有权限") => new HttpError(403, msg);
export const notFound = (msg = "资源不存在") => new HttpError(404, msg);
export const conflict = (msg, details) => new HttpError(409, msg, details);
export const tooMany = (msg = "操作过于频繁，请稍后再试") => new HttpError(429, msg);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".ico ": "image/x-icon",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export function sendJson(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

export function sendText(res, status, text, headers) {
  const body = String(text);
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(body);
}

export function sendError(res, err, log) {
  if (err instanceof HttpError) {
    sendJson(res, err.status, err.details ? { error: err.message, details: err.details } : { error: err.message });
    return;
  }
  if (log) log(err);
  sendJson(res, 500, { error: "服务器内部错误" });
}

/** 读取请求体，带大小上限 */
export async function readBody(req, limit = config.maxBody) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared && declared > limit) throw new HttpError(413, "请求体过大");
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      req.destroy();
      throw new HttpError(413, "请求体过大");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit = config.maxBody) {
  const ctype = String(req.headers["content-type"] || "");
  // CSRF 防线之一：写操作必须声明 JSON，跨站表单无法伪造该 Content-Type
  if (!/^application\/json\b/i.test(ctype)) {
    throw new HttpError(415, "请求必须使用 application/json");
  }
  const buf = await readBody(req, limit);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw badRequest("请求体不是合法 JSON");
  }
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function buildCookie(name, value, { maxAgeSec, secure = config.cookieSecure } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (maxAgeSec !== undefined) parts.push(`Max-Age=${maxAgeSec}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookieHeader(name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * 客户端 IP。
 * - trustProxy=false（默认，TCP 隧道场景）：frpc 的 TCP 转发不会附带 X-Forwarded-For，
 *   服务端只能看到 127.0.0.1，此时返回 loopback 标记，限流层必须改用「按用户名」通道。
 * - trustProxy=true（HTTP/HTTPS 隧道）：信任 X-Forwarded-For 首段。
 */
export function clientIp(req) {
  const socketIp = normalizeIp(req.socket && req.socket.remoteAddress);
  if (!config.trustProxy) {
    return { ip: socketIp, loopback: isLoopback(socketIp), trustProxy: false };
  }
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const candidate = normalizeIp(xff) || socketIp;
  return { ip: candidate, loopback: isLoopback(candidate), trustProxy: true };
}

function normalizeIp(ip) {
  if (!ip) return "";
  const v = String(ip).trim();
  if (v.startsWith("::ffff:")) return v.slice(7);
  if (v === "::1") return "127.0.0.1";
  return v;
}

function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "";
}

/** 同源校验（CSRF）：有 Origin 就比 Origin，否则比 Referer */
export function assertSameOrigin(req) {
  const host = String(req.headers.host || "");
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const extract = (value) => {
    try {
      const u = new URL(value);
      return u.host;
    } catch {
      return null;
    }
  };
  if (origin) {
    const oHost = extract(origin);
    if (oHost && host && oHost === host) return;
    throw forbidden("跨站请求被拒绝");
  }
  if (referer) {
    const rHost = extract(referer);
    if (rHost && host && rHost === host) return;
    throw forbidden("跨站请求被拒绝");
  }
  // 两个头都缺：非浏览器客户端（curl/测试）放行，浏览器一定会带其中之一
}

const STATIC_ALLOW = new Set([
  "index.html",
  "app.css",
  "app.js",
  "tokens.css",
  "favicon.svg",
  "favicon.ico",
  "manifest.webmanifest",
]);

/** 静态资源：只允许 public/ 下白名单文件，拒绝 ../ 与任意子目录 */
export function serveStatic(req, res, urlPath) {
  const name = urlPath.replace(/^\/+/, "") || "index.html";
  if (name.includes("..") || name.includes("\\") || name.includes("\0")) {
    sendText(res, 400, "错误的路径");
    return true;
  }
  if (!STATIC_ALLOW.has(name)) return false;
  const file = path.join(config.publicDir, name);
  if (!fs.existsSync(file)) return false;
  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(file);
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag, ...SECURITY_HEADERS });
    res.end();
    return true;
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": body.length,
    ETag: etag,
    "Cache-Control": name === "index.html" ? "no-cache" : "public, max-age=300",
    ...SECURITY_HEADERS,
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'",
  });
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}

/** 简易路由表：注册 {method, path 或正则, handler} */
export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    routes.push({ method, pattern, handler });
  };
  return {
    get: (p, h) => add("GET", p, h),
    post: (p, h) => add("POST", p, h),
    put: (p, h) => add("PUT", p, h),
    delete: (p, h) => add("DELETE", p, h),
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) continue;
        if (typeof route.pattern === "string") {
          if (route.pattern === pathname) return { handler: route.handler, params: {} };
          continue;
        }
        const m = route.pattern.exec(pathname);
        if (m) return { handler: route.handler, params: m.groups || {} };
      }
      return null;
    },
    size: () => routes.length,
  };
}

/** 路径参数模式：/api/banks/:slug → 正则 */
export function route(pattern) {
  const keys = [];
  const src = pattern
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  const re = new RegExp(`^${src}/?$`);
  return {
    exec(pathname) {
      const m = re.exec(pathname);
      if (!m) return null;
      const groups = {};
      keys.forEach((k, i) => {
        groups[k] = decodeURIComponent(m[i + 1]);
      });
      return { groups };
    },
  };
}
