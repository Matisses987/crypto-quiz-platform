#!/data/data/com.termux/files/usr/bin/sh
# 停止密练服务器（Termux）
cd "$(dirname "$0")"
if [ ! -f log/server.pid ]; then
  echo "没有 pid 文件，可能没在运行"
  exit 0
fi
PID="$(cat log/server.pid)"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  sleep 1
  kill -0 "$PID" 2>/dev/null && kill -9 "$PID" || true
  echo "已停止：pid=$PID"
else
  echo "进程已不在：pid=$PID"
fi
rm -f log/server.pid
command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock || true