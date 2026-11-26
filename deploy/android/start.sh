#!/data/data/com.termux/files/usr/bin/sh
# 启动密练服务器（Termux）
set -e
cd "$(dirname "$0")"
mkdir -p log data
if [ -f log/server.pid ] && kill -0 "$(cat log/server.pid)" 2>/dev/null; then
  echo "已在运行：pid=$(cat log/server.pid)"
  exit 0
fi
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true
nohup node server/index.js >> log/server.log 2>&1 &
echo $! > log/server.pid
sleep 2
if kill -0 "$(cat log/server.pid)" 2>/dev/null; then
  echo "已启动：pid=$(cat log/server.pid)"
  tail -4 log/server.log
else
  echo "启动失败，日志："
  tail -20 log/server.log
  exit 1
fi