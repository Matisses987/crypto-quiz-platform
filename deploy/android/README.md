# 手机部署（Redmi K50 / Android 14 / Termux，免 root 也能跑）

把服务端版跑在自己的安卓手机上，出门在外也能用。本目录里的脚本都是在真机上跑通过的，
不是示意代码。手机实测环境：

| 项 | 值 |
|---|---|
| 机型 | Redmi K50（`22021211RC` / `munch`） |
| 系统 | Android 14 / SDK 34 / `arm64-v8a` |
| Termux | 0.118.1，uid `10298`（`u0_a298`） |
| Node | `v24.22.3`（Termux 仓库的 `nodejs-lts`） |
| 结果 | `node --test tests/` 171/171 通过（2.6 s），三库齐全，公网可用 |

## 1. 装环境

```bash
pkg update
# 必须先升 openssl：随包的 1:3.2.1 太旧，node 会报
#   CANNOT LINK EXECUTABLE "node": cannot locate symbol "OSSL_INDICATOR_get_callback"
DEBIAN_FRONTEND=noninteractive pkg install -y -o Dpkg::Options::=--force-confnew openssl
pkg install -y nodejs-lts git curl termux-api
node -v                      # v24.22.3
node -e 'new (require("node:sqlite").DatabaseSync)(":memory:")' && echo sqlite OK
```

仓库根目录还有一份 `deploy/termux-setup.sh`，一次做完上面这些并跑 `node:sqlite` 冒烟。
**注意：别在 `su -c` 里跑 `pkg`**，Android 会拦：
`Ability to run this command as root has been disabled permanently for safety purposes.`

## 2. 放代码

手机上直连 GitHub 常常超时，推荐在电脑上打包再推过去：

```powershell
git archive --format=tar.gz -o cqp-server.tar.gz server
adb push cqp-server.tar.gz /data/local/tmp/cqp.tar.gz
adb shell "su -c 'cp /data/local/tmp/cqp.tar.gz /data/data/com.termux/files/home/ && chown u0_a298:u0_a298 /data/data/com.termux/files/home/cqp.tar.gz'"
```

然后在 Termux 里：

```bash
cd ~ && tar xzf cqp.tar.gz && mv cqp-app 2>/dev/null || true
cd ~/cqp-app && ls server/index.js
node tools/build.mjs --target server --strict   # 生成 public/index.html
node --test tests/                              # 应 171/171
```

解包时用**手机上那个文件名**（`cqp.tar.gz`），别照抄电脑上的 `cqp-server.tar.gz`，
否则报 `tar: cqp-server.tar.gz: Cannot open: No such file or directory`。

## 3. 配 `.env`

`~/cqp-app/.env`：

```ini
HOST=0.0.0.0
PORT=3010
CQP_DB=data/app.db
CQP_BACKUP_DIR=data/backup
CQP_BACKUP_CRON=03:10
CQP_ALLOW_REGISTER=1
CQP_SESSION_DAYS=7
CQP_COOKIE_SECURE=0     # 走 http 隧道时必须 0，否则浏览器不存 cookie
CQP_TRUST_PROXY=0       # TCP 隧道没有 X-Forwarded-For
CQP_MAX_BODY=2097152
TZ=Asia/Shanghai
NODE_ENV=production
```

## 4. 起服务

三种方式，按需要挑：

```bash
# A. Termux 前台/后台（最简单）
./start.sh          # nohup + termux-wake-lock，pid 写 log/server.pid
./stop.sh

# B. root 一键重启（带健康自检，重启后权限还原）
su -c 'sh /data/local/tmp/cqp/cqp_restart.sh'

# C. 开机自启（装到 service.d）
adb push deploy/android/cqp-autostart.sh /data/local/tmp/
adb shell "su -c 'cp /data/local/tmp/cqp-autostart.sh /data/adb/service.d/ && chmod 755 /data/adb/service.d/cqp-autostart.sh'"
```

`cqp_restart.sh` 的几个要点（都是踩出来的）：

- **只认 pidfile + `/proc/<pid>/cmdline` 里的 `server/index.js`**，绝不做模糊 `pkill node` —— 手机上可能同时跑着别的 Node 服务。
- root 起完会 `chown -R u0_a298:u0_a298`，否则 SQLite 文件属主变 root，Termux 用户之后写不动。
- 起完轮询 `/api/health` 最多 30 秒，失败打印日志尾部。
- 降权到 `u0_a298` 只有 nsenter 一条路：`su 10298 -c` 报 `No such file or directory`，
  `setpriv --reuid` 报 `keep process capabilities failed`，root 下 `run-as com.termux` 直接段错误。
  所以自启就是**全程 root 跑 + 事后 chown**。

## 5. 局域网访问

```bash
ip -4 addr show wlan0 | sed -n 's/.*inet \([0-9.]*\)\/.*/\1/p'
# 手机 192.168.137.246 → 同网段设备开 http://192.168.137.246:3010
```

**第一个注册的账号自动成为管理员。**

## 6. 公网访问

### 6.1 cloudflared（推荐，免费、带 https）

```bash
./tunnel-cloudflared.sh --bg      # 约 10~20 秒后打印 https://xxx.trycloudflare.com
./tunnel-cloudflared.sh --stop
cat log/cloudflared.url
```

Termux 上有两个必踩的坑，脚本已处理：

1. **Go 解析器查 `[::1]:53`**，Termux 没有本地 DNS 监听 →
   `dial tcp: lookup api.trycloudflare.com on [::1]:53: read: connection refused`。
   `dnsfwd.mjs` 用 `node:dgram` 在 `127.0.0.1:53` 与 `::1:53` 转发到 `223.5.5.5`，起来就好了。
   `GODEBUG=netdns=cgo` 没用。
2. **找不到根证书** → `x509: certificate signed by unknown authority`。
   要 `export SSL_CERT_FILE=$PREFIX/etc/tls/cert.pem`（`$PREFIX/etc/ssl/certs/ca-certificates.crt` 不存在）。

另外 quick tunnel 偶发 `429 [10000] Tunnelstore request failed`，重试即可（脚本自带 4 次重试）。
域名每次重启都会换。

### 6.2 其它方式（实测对比）

| 方式 | 结论 |
|---|---|
| **localhost.run** `ssh -R 80:127.0.0.1:3010 nokey@localhost.run` | 能用，但免费版限速（日志 `slowed by 25 seconds`），502 频发，域名每次换 → 不推荐 |
| **serveo.net** | 连接成功，但浏览器先撞 `Serveo Browser Warning` 拦截页，无头浏览器过不去 → 不可用 |
| **SakuraFrp** | 手机上有 `frpc 0.51.0-sakura-15.1`，API 也通；但免费账号隧道数上限 2 条已占满，新建 3010 被拒（`403 隧道数量已到达上限`）→ 需删旧隧道或升级。TCP 隧道**不带 XFF**，`CQP_TRUST_PROXY` 必须留 0 |

SakuraFrp 若要用（先腾出隧道名额）：

```bash
$HOME/mcserver/frpc/frpc -f <token>:<tunnel_id> --watch    # 前台
```

## 7. 验收

电脑上（需要有 `--remote-debugging-port=9333` 的 Chrome）：

```bash
node tools/e2e/phone-verify.mjs http://192.168.137.246:3010 <用户名> <密码>
node tools/e2e/phone-verify.mjs https://xxx.trycloudflare.com <用户名> <密码>
```

15 项：健康 / 首页 / 产物不内联题库 / 登录 / 前端启动 / 已登录 / 导航 9 项 / 三库齐全 /
切库 / 开练 20 题 / 服务端判分 / 记录落库 / 小题库模拟考降级 / 无 console error。
截图落在 `data/shots/`。

**这个脚本对公网 URL 有两个坑**（已修，别改回去）：

- 登录后 `Page.reload`，第一次 `evaluate` 往往还打在**旧文档**上，旧文档当然已经 loaded。
  必须记下 `performance.timeOrigin`，等它变成另一个值才算新文档。
- 别用 `readyState === "complete"` 当就绪判据。隧道下 readyState 早就 complete，
  而 `/api/banks`、`/api/store` 还没回来（`banks=0`），此时 `renderBankSwitcher()`
  认为只有 0 个题库、直接把宿主清空，题库下拉根本不存在。要等到 `state.bank && state.store`。

## 8. 备份与排障

```bash
# 数据库每天 03:10 自动备份到 data/backup（CQP_BACKUP_CRON）
ls -lh ~/cqp-app/data/backup
tail -f ~/cqp-app/log/server.log
tail -30 ~/cqp-app/log/autostart.log
```

忘记密码（手机上执行）：

```bash
cd ~/cqp-app && node server/admin-cli.js list
node server/admin-cli.js passwd <用户名> <新密码>
```

**省电设置**：把 Termux 加入「不受限制」白名单，否则息屏后进程会被挂起：

```bash
adb shell dumpsys deviceidle whitelist | grep termux
```
