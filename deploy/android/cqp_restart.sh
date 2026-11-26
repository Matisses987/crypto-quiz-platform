#!/system/bin/sh
# ============================================================
# cqp_restart.sh — 密码赛刷题平台 一键重启（root 或 Termux 均可调用）
#
#   su -c 'sh /data/local/tmp/cqp/cqp_restart.sh'
#
# 设计要点：
#   * 用 pidfile 精确 kill，禁止模糊匹配（本机还跑着 MC / OJ，不能误杀）
#   * 数据目录权限放到 777 + 事后 chown 回 u0_a298，root 起也不会把库锁死
#   * 起完自检 /api/health，失败打印日志尾部
# ============================================================
set -u
H=/data/data/com.termux/files/home
P=/data/data/com.termux/files/usr
APP=$H/cqp-app
LOG=$APP/log
PF=$LOG/server.pid
PORT=3010

mkdir -p "$LOG" "$APP/data"
umask 000

export HOME=$H
export PREFIX=$P
export PATH=$P/bin:/system/bin
export LD_LIBRARY_PATH=$P/lib
export TMPDIR=$P/tmp
export TZ=Asia/Shanghai
mkdir -p "$TMPDIR" 2>/dev/null

is_ours() {
  pid=${1:-}
  [ -n "$pid" ] || return 1
  [ -d "/proc/$pid" ] || return 1
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
  case "$cmd" in *"server/index.js"*) return 0;; esac
  return 1
}

# ---- 1. 停 ----
if [ -f "$PF" ]; then
  pid=$(cat "$PF" 2>/dev/null)
  if is_ours "$pid"; then
    kill "$pid" 2>/dev/null
    i=0
    while [ $i -lt 25 ] && [ -d "/proc/$pid" ]; do sleep 0.2; i=$((i+1)); done
    [ -d "/proc/$pid" ] && kill -9 "$pid" 2>/dev/null
    echo "[cqp] 已停止旧进程 pid=$pid"
  fi
  rm -f "$PF"
fi
for d in /proc/[0-9]*; do
  pid=${d#/proc/}
  is_ours "$pid" && { kill -9 "$pid" 2>/dev/null; echo "[cqp] 清理残留 pid=$pid"; }
done
sleep 1

# ---- 2. 权限 ----
chown -R u0_a298:u0_a298 "$APP" 2>/dev/null
chmod 777 "$APP/data" "$LOG" 2>/dev/null
chmod -R u+rwX,g+rwX "$APP" 2>/dev/null

# ---- 3. 起 ----
cd "$APP" || { echo "[cqp] 找不到 $APP"; exit 1; }
nohup node server/index.js >> "$LOG/server.log" 2>&1 &
NEWPID=$!
echo "$NEWPID" > "$PF"
echo "[cqp] 启动 pid=$NEWPID（端口 $PORT）"

# ---- 4. 自检 ----
code=""
i=0
while [ $i -lt 60 ]; do
  sleep 0.5
  code=$("$P/bin/curl" -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" 2>/dev/null)
  [ "$code" = "200" ] && break
  i=$((i+1))
done

if [ "$code" = "200" ]; then
  IP=$(ip -4 addr show wlan0 2>/dev/null | sed -n 's/.*inet \([0-9.]*\)\/.*/\1/p' | head -1)
  echo "[cqp] 健康检查通过"
  echo "[cqp] 本机   http://127.0.0.1:$PORT"
  [ -n "$IP" ] && echo "[cqp] 局域网 http://$IP:$PORT"
else
  echo "[cqp] 健康检查失败（code=${code:-none}），日志尾部："
  tail -15 "$LOG/server.log" 2>/dev/null
fi

# ---- 5. 属主还原（root 起过之后） ----
chown -R u0_a298:u0_a298 "$APP" 2>/dev/null
chmod 777 "$APP/data" "$LOG" 2>/dev/null