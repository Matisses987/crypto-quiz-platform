#!/system/bin/sh
# ============================================================
# cqp-autostart: 开机自动恢复「密码赛刷题平台」(node server/index.js :3010)
#   放置: /data/adb/service.d/cqp-autostart.sh   (root, 0755)
#
# 与 oj-autostart.sh 同风格：不依赖 Termux App 是否启动。
# node 直接用 Termux 的二进制（root 可执行，无需 nsenter），
# 起完由 cqp_restart.sh 把数据目录 chown 回 u0_a298，
# 之后用户在 Termux 里手动 ./start.sh 也不会写不动库。
# ============================================================

(
  while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 2; done
  sleep 20

  H=/data/data/com.termux/files/home
  LOG=$H/cqp-app/log/autostart.log
  mkdir -p "$H/cqp-app/log"
  echo "=== $(date '+%F %T') autostart begin ===" >> "$LOG"

  # 等网络就绪（非必需，但让 /api/health 自检更可靠）
  i=0
  while [ $i -lt 30 ]; do
    ping -c 1 -W 2 223.5.5.5 > /dev/null 2>&1 && break
    sleep 5; i=$((i+1))
  done
  echo "$(date '+%F %T') network ready after ${i} tries" >> "$LOG"

  ATTEMPT=0
  while [ $ATTEMPT -lt 3 ]; do
    ATTEMPT=$((ATTEMPT+1))
    echo "--- $(date '+%F %T') attempt $ATTEMPT ---" >> "$LOG"
    /system/bin/sh /data/local/tmp/cqp/cqp_restart.sh >> "$LOG" 2>&1

    CODE=$(/data/data/com.termux/files/usr/bin/curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3010/api/health 2>/dev/null)
    echo "$(date '+%F %T') attempt $ATTEMPT code=$CODE" >> "$LOG"
    [ "$CODE" = "200" ] && { echo "$(date '+%F %T') autostart SUCCESS" >> "$LOG"; break; }
    [ $ATTEMPT -lt 3 ] && sleep 30
  done

  echo "=== $(date '+%F %T') autostart end ===" >> "$LOG"
) > /dev/null 2>&1 &