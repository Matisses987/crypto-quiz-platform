#!/data/data/com.termux/files/usr/bin/sh
# ============================================================
# tunnel-sakura.sh — 用 SakuraFrp 固定端口把 3010 暴露到公网
#
#   ./tunnel-sakura.sh --bg     后台跑（自带断线重连循环）
#   ./tunnel-sakura.sh --stop   停
#   ./tunnel-sakura.sh          前台跑
#
# 与 cloudflared 的 quick tunnel 不同，SakuraFrp 的远程端口是固定的，
# 域名也固定（frp-bar.com:32614 这种），所以适合长期挂着。
#
# 配置来源（三选一，优先级从高到低）：
#   FRPC_BIN      frpc 可执行文件，默认 $HOME/mcserver/frpc/frpc
#   FRP_TOKEN     SakuraFrp 访问密钥
#   FRP_TUNNEL    隧道 ID（逗号分隔可写多条）
# ============================================================
set -u
cd "$(dirname "$0")" || exit 1
APP=$(pwd)
LOG=$APP/log
mkdir -p "$LOG"

: "${HOME:=/data/data/com.termux/files/home}"
: "${PREFIX:=/data/data/com.termux/files/usr}"
case ":$PATH:" in *":$PREFIX/bin:"*) ;; *) PATH=$PREFIX/bin:$PATH;; esac
export HOME PREFIX PATH

FRPC=${FRPC_BIN:-$HOME/mcserver/frpc/frpc}
TOKEN=${FRP_TOKEN:-4v7bq8o7tfuh4wk991tsy1fpgnrlzzk5}
TUNNEL=${FRP_TUNNEL:-29975109}
PIDF=$LOG/frpc.pid
OUT=$LOG/frpc.log

if [ "${1:-}" = "--stop" ]; then
  if [ -f "$PIDF" ]; then
    pid=$(cat "$PIDF" 2>/dev/null)
    [ -n "$pid" ] && kill "$pid" 2>/dev/null && echo "已停止 frpc pid=$pid"
    rm -f "$PIDF"
  fi
  for d in /proc/[0-9]*; do
    pid=${d#/proc/}
    [ -r "$d/cmdline" ] || continue
    cmd=$( { tr '\0' ' ' < "$d/cmdline"; } 2>/dev/null ) || continue
    case "$cmd" in
      *"frpc"*"$TOKEN"*) kill "$pid" 2>/dev/null && echo "已停止残留 frpc pid=$pid" ;;
    esac
  done
  exit 0
fi

[ -x "$FRPC" ] || { echo "找不到 frpc：$FRPC（可用 FRPC_BIN 指定）"; exit 1; }

# 断线重连：frpc 自己会重连，但被服务端踢掉时会退出，外面套一层循环更稳。
# 注意别用 `sh -c "$(declare -f run_loop)"` —— Android 的 sh 是 mksh，
# 没有 declare -f，子进程里根本拿不到函数（踩过：日志一行不写就退出）。
if [ "${1:-}" = "--bg" ]; then
  if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
    echo "已在运行：pid=$(cat "$PIDF")"
    grep -o '>>[^<]*<<' "$OUT" 2>/dev/null | tail -1 | tr -d '<>'
    exit 0
  fi
  nohup sh "$0" --loop > /dev/null 2>&1 &
  echo $! > "$PIDF"
  i=0
  while [ $i -lt 30 ]; do
    sleep 1
    ADDR=$(grep -o '>>[^<]*<<' "$OUT" 2>/dev/null | tail -1 | tr -d '<>')
    [ -n "$ADDR" ] && break
    kill -0 "$(cat "$PIDF")" 2>/dev/null || break
    i=$((i+1))
  done
  if [ -n "$ADDR" ]; then
    echo "$ADDR" > "$LOG/sakura.addr"
    echo "[sakura] 公网地址 http://$ADDR"
  else
    echo "[sakura] 已启动 pid=$(cat "$PIDF")，暂未拿到地址，看 $OUT"
  fi
  exit 0
fi

while :; do
  echo "=== $(date '+%F %T') frpc start ===" >> "$OUT"
  "$FRPC" -f "$TOKEN:$TUNNEL" >> "$OUT" 2>&1
  echo "=== $(date '+%F %T') frpc exited, retry in 10s ===" >> "$OUT"
  sleep 10
done
