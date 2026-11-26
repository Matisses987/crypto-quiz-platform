#!/data/data/com.termux/files/usr/bin/bash
# 密码赛刷题平台 · Termux 一键环境准备（Redmi K50 / Android 14 / APatch root 实测）
#
# 用法（在 Termux 里）：
#   bash termux-setup.sh
#
# 注意：本脚本必须由 Termux 应用自己的 uid 运行。
#   - 在 Termux 终端里直接 `bash termux-setup.sh` ✔
#   - 从 PC `adb shell run-as com.termux ...` 也算 Termux uid（可以），但要显式带环境串
#   - 绝对不要 `su -c` 跑 pkg/apt：Termux 永久禁用了 root 运行 apt
#     （会报 Ability to run this command as root has been disabled permanently for safety purposes.）
set -eu

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
export PREFIX
export HOME="${HOME:-/data/data/com.termux/files/home}"
# Termux 里没有 /tmp，node 与各种构建工具都会找它
export TMPDIR="$PREFIX/tmp"
mkdir -p "$TMPDIR"
export PATH="$PREFIX/bin:/system/bin"

say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

say "环境自检"
printf 'PREFIX = %s\nHOME   = %s\nTMPDIR = %s\n' "$PREFIX" "$HOME" "$TMPDIR"
if [ "$(id -u)" = "0" ]; then
  printf '\033[31m当前是 root。Termux 的 pkg/apt 拒绝了 root 运行，请退出 root 后在 Termux 里重跑。\033[0m\n' >&2
  exit 1
fi

say "换源（中科大镜像，可选）"
if [ -f "$PREFIX/etc/apt/sources.list" ] && ! grep -q 'mirrors.ustc.edu.cn' "$PREFIX/etc/apt/sources.list" 2>/dev/null; then
  printf 'deb https://mirrors.ustc.edu.cn/termux/apt/termux-main stable main\n' > "$PREFIX/etc/apt/sources.list"
  echo "已切到 mirrors.ustc.edu.cn（原源浙大 zju，二者都可用）"
else
  echo "保持现有源：$(cat "$PREFIX/etc/apt/sources.list" 2>/dev/null | tr '\n' ' ')"
fi

say "升级索引"
pkg update -y

say "安装 openssl（必须先装新版）"
# Termux 自带的老 openssl 1:3.2.x 会让 node 报
#   CANNOT LINK EXECUTABLE "node": cannot locate symbol "OSSL_INDICATOR_get_callback"
# --force-confnew 用来避开 openssl.cnf 的交互式 conffile 提问
DEBIAN_FRONTEND=noninteractive pkg install -y -o Dpkg::Options::=--force-confnew openssl

say "安装 Node（Termux 仓库版，非 nodejs.org 的 glibc 预编译包）"
# nodejs-lts 24.22.3 / nodejs 26.13.1，均 >= 22.5 且编译时带 --shared-sqlite，node:sqlite 可用
pkg install -y nodejs-lts

say "安装其余工具"
pkg install -y git curl termux-api

say "校验版本"
node -v
npm -v 2>/dev/null || echo "npm 未随 nodejs-lts 一起装（v24.13.0 之后不再捆绑），可另装：pkg install npm"
git --version

say "校验 node:sqlite（本项目零依赖，数据库全靠它）"
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t(a INTEGER, b TEXT)");
db.prepare("INSERT INTO t VALUES (?, ?)").run(42, "ok");
const row = db.prepare("SELECT a, b FROM t").get();
if (row.a !== 42 || row.b !== "ok") throw new Error("node:sqlite 读写不正确");
console.log("node:sqlite OK ->", JSON.stringify(row));
'

say "关闭电池优化提醒"
cat <<'TIP'
Android 会杀掉后台 node 进程。建议：
  1. 本脚本已装 termux-api；在 Termux 里执行
       termux-wake-lock
     让系统不要休眠 Termux。
  2. 系统设置 → 应用 → Termux → 电池 → 选「无限制」。
  3. 系统设置 → 应用 → Termux → 权限 → 允许「通知」（wake-lock 需要）。
TIP

if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock && echo "已获取 wake-lock"
fi

say "完成"
cat <<'DONE'
接下来：
  git clone <你的仓库> cqp && cd cqp
  cp .env.example .env       # 按需改 PORT / CQP_BOOTSTRAP_ADMIN
  node server/index.js

首次启动会自动：建 SQLite 库、导入内置 1051 题、导入 data/seed/*.json。
第一个注册的账号成为管理员（也可在 .env 里设 CQP_BOOTSTRAP_ADMIN / CQP_BOOTSTRAP_PASSWORD 预置）。

从 PC 打开（手机不联网也能用）：
  adb forward tcp:13310 tcp:3010
  然后浏览器访问 http://127.0.0.1:13310
DONE
