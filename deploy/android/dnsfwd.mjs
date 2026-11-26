// 极简 DNS 转发：把 127.0.0.1:53 / [::1]:53 上的查询转给上游，供纯 Go 解析器的程序使用。
// 用途：cloudflared 在 Termux 上没有 /etc/resolv.conf，Go 会退化成查询 [::1]:53，必然失败。
import dgram from "node:dgram";

const UPSTREAM = process.env.DNS_UPSTREAM || "223.5.5.5";
const UP_PORT = Number(process.env.DNS_UP_PORT || 53);
const BIND = [
  { type: "udp4", host: "127.0.0.1" },
  { type: "udp6", host: "::1" },
];

let served = 0;

for (const b of BIND) {
  const srv = dgram.createSocket({ type: b.type, ipv6Only: b.type === "udp6" });
  srv.on("message", (msg, rinfo) => {
    const up = dgram.createSocket(b.type === "udp6" ? "udp6" : "udp4");
    up.on("message", (reply) => {
      served += 1;
      try {
        srv.send(reply, rinfo.port, rinfo.address);
      } catch {
        /* 客户端已走开，忽略 */
      }
      up.close();
    });
    up.on("error", () => up.close());
    up.send(msg, UP_PORT, UPSTREAM);
  });
  srv.on("error", (err) => console.error("[dnsfwd] " + b.host + " 失败：" + err.message));
  srv.bind(53, b.host, () => console.log("[dnsfwd] 监听 " + b.host + ":53 -> " + UPSTREAM));
}

setInterval(() => {
  if (served) console.log("[dnsfwd] 已转发 " + served + " 次查询");
  served = 0;
}, 60000);