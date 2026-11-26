#!/data/data/com.termux/files/usr/bin/sh
# ============================================================
# tunnel-cloudflared.sh — 用 cloudflared 快速隧道把 3010 暴露到公网
#
#   ./tunnel-cloudflared.sh          前台跑（Ctrl-C 停）
#   ./tunnel-cloudflared.sh --bg     后台跑，URL 落到 log/cloudflared.url
#   ./tunnel-cloudflared.sh --stop   停掉
#
# Termux 上有两个必踩的坑，本脚本都处理了：
#   1) Go 的 DNS 解析器不读 Termux 的配置，直接查 [::1]:53，而 Termux 没有
#      本地 DNS 监听 → 必须先起一个 dnsfwd.mjs 把 53 端口转发出去。
#   2) 找不到根证书 → 必须 export SSL_CERT_FILE=$PREFIX/etc/tls/cert.pem
#      （$PREFIX/etc/ssl/certs/ca-certificates.crt 在 Termux 上不存在）
# 另外 quick tunnel 会偶发 429，脚本自带重试。
# ============================================================
set -u
cd "$(dirname "$0")" || exit 1
APP=$(pwd)
LOG=$APP/log
mkdir -p "$LOG"

# 从 root（开机自启）调用时 HOME / PREFIX / PATH 都可能没有，这里兜底，
# 否则 `set -u` 会直接退出，`$HOME/cloudflared` 会退化成 `/cloudflared`。
: "${HOME:=/data/data/com.termux/files/home}"
: "${PREFIX:=/data/data/com.termux/files/usr}"
case ":$PATH:" in *":$PREFIX/bin:"*) ;; *) PATH=$PREFIX/bin:$PATH;; esac
export HOME PREFIX PATH

CF=${CLOUDFLARED_BIN:-$HOME/cloudflared}
PORT=${PORT:-3010}
URLFILE=$LOG/cloudflared.url

if [ "${1:-}" = "--stop" ]; then
  for f in "$LOG/cloudflared.pid" "$LOG/dnsfwd.pid"; do
    [ -f "$f" ] || continue
    pid=$(cat "$f" 2>/dev/null)
    [ -n "$pid" ] && kill "$pid" 2>/dev/null && echo "已停止 pid=$pid（$(basename "$f")）"
    rm -f "$f"
  done
  # pidfile 可能丢（手工起过、或脚本被 kill），再按 cmdline 精确扫一遍
  for d in /proc/[0-9]*; do
    pid=${d#/proc/}
    [ -r "$d/cmdline" ] || continue
    # 注意：`< file 2>/dev/null` 抑制不了 shell 自己的重定向报错，要整体包一层
    cmd=$( { tr '\0' ' ' < "$d/cmdline"; } 2>/dev/null ) || continue
    case "$cmd" in
      *"cloudflared tunnel --url http://127.0.0.1:$PORT"*|*"cqp-app/dnsfwd.mjs"*)
        kill "$pid" 2>/dev/null && echo "已停止残留 pid=$pid"
        ;;
    esac
  done
  exit 0
fi

[ -x "$CF" ] || { echo "找不到 cloudflared：$CF（可用 CLOUDFLARED_BIN 指定）"; exit 1; }

# ---- 1. DNS 转发（只起一次） ----
need_dns=1
if [ -f "$LOG/dnsfwd.pid" ] && kill -0 "$(cat "$LOG/dnsfwd.pid")" 2>/dev/null; then
  need_dns=0
fi
if [ "$need_dns" = "1" ]; then
  nohup node "$APP/dnsfwd.mjs" >> "$LOG/dnsfwd.log" 2>&1 &
  echo $! > "$LOG/dnsfwd.pid"
  sleep 1
  echo "[tunnel] DNS 转发已起 pid=$(cat "$LOG/dnsfwd.pid")"
fi

# ---- 2. 证书 ----
if [ -z "${SSL_CERT_FILE:-}" ]; then
  for c in "$PREFIX/etc/tls/cert.pem" "$PREFIX/etc/ssl/certs/ca-certificates.crt" /system/etc/security/cacerts; do
    [ -f "$c" ] && { export SSL_CERT_FILE="$c"; break; }
  done
fi
echo "[tunnel] SSL_CERT_FILE=${SSL_CERT_FILE:-未设置}"

# ---- 3. 起隧道（quick tunnel 偶发 429，最多试 4 次） ----
start_fg() {
  "$CF" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate 2>&1 | tee -a "$LOG/cloudflared.log" \
    | while IFS= read -r line; do
        echo "$line"
        case "$line" in
          *https://*.trycloudflare.com*)
            echo "$line" | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | head -1 > "$URLFILE"
            ;;
        esac
      done
}

if [ "${1:-}" = "--bg" ]; then
  rm -f "$URLFILE"
  attempt=1
  while [ $attempt -le 4 ]; do
    # 只认本次新增的日志行，否则会读到上一次运行留下的旧域名
    before=$(wc -l < "$LOG/cloudflared.log" 2>/dev/null || echo 0)
    nohup "$CF" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate >> "$LOG/cloudflared.log" 2>&1 &
    cfpid=$!
    echo "$cfpid" > "$LOG/cloudflared.pid"
    i=0
    while [ $i -lt 45 ]; do
      sleep 1
      tail -n +$((before + 1)) "$LOG/cloudflared.log" 2>/dev/null \
        | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1 > "$URLFILE"
      [ -s "$URLFILE" ] && break
      kill -0 "$cfpid" 2>/dev/null || break
      i=$((i+1))
    done
    if [ -s "$URLFILE" ]; then
      echo "[tunnel] 公网地址 $(cat "$URLFILE")"
      echo "[tunnel] 日志 $LOG/cloudflared.log"
      chown -R u0_a298:u0_a298 "$LOG" 2>/dev/null
      exit 0
    fi
    kill "$cfpid" 2>/dev/null
    if tail -n +$((before + 1)) "$LOG/cloudflared.log" 2>/dev/null | grep -q '429'; then
      echo "[tunnel] 第 $attempt 次被限流（429），等 20 秒重试…"
      sleep 20
    else
      echo "[tunnel] 第 $attempt 次没拿到地址，重试…"
      sleep 5
    fi
    attempt=$((attempt+1))
  done
  echo "[tunnel] 放弃：见 $LOG/cloudflared.log"
  exit 1
fi

start_fg
