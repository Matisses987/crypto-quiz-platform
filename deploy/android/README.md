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

### 6.1 SakuraFrp（推荐，域名和端口固定）

```bash
./tunnel-sakura.sh --bg      # 约 10~30 秒后打印地址
./tunnel-sakura.sh --stop
cat log/sakura.addr          # school.u2095320.nyat.app:32614
```

固定地址 `https://school.u2095320.nyat.app:32614`，重启、换 WiFi、换 4G 都不变，
可以存书签、发二维码。这是它相对 cloudflared 的唯一但决定性的优势。

前提：账号里要有空闲的隧道名额（免费号上限 2 条）。`deploy/android/tunnel-sakura.sh`
默认用隧道 `29975109`（`cqp_web`，node 34 浙江三线PLUS7 → 本地 `127.0.0.1:3010`），
换账号/换隧道时用环境变量覆盖：

```bash
FRP_TOKEN=<token> FRP_TUNNEL=<隧道id> ./tunnel-sakura.sh --bg
```

**建隧道的正确姿势（API 是 v4，但路径不是 RESTful，试错过的都记在这里）**

```bash
# 建 TCP 隧道（不要建 http/https 类型，NYAT APP 域名不能直接用于 HTTP 隧道）
curl -s -X POST https://api.natfrp.com/v4/tunnels \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"name":"cqp_web","type":"tcp","node":34,"local_ip":"127.0.0.1","local_port":3010}'
# → 201 {"id":29975109,"remote":"32614",...}

# 改隧道（PATCH/PUT /v4/tunnels/{id} 全是 404，只有这个 POST 有效）
curl -s -X POST https://api.natfrp.com/v4/tunnel/edit \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"id":29975109,"extra":"auto_https = school.u2095320.nyat.app"}'

# 绑子域名（rr 必须在白名单词里，cqp 不在，用 school）
curl -s -X POST https://api.natfrp.com/v4/domain/bind \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"rr":"school","tunnel":29975109,"domain":"u2095320.nyat.app","type":"CNAME"}'
# → 204，白名单词用 GET /v4/domain/get 拿
```

**三个必踩的坑**

1. **纯 TCP 隧道用 `http://` 访问会被网关拦成 501**。正文写「您正试图使用 HTTP 协议
   访问此隧道 … 执行机房的内容合规要求和有关部门的管控规定」，解决办法就是开自动 HTTPS。
2. **`auto_https` 必须写具体域名，不能只写 `auto`**。写 `auto` 时 frpc 自签一张证书，
   浏览器报警告、curl 要 `-k`；写 `school.u2095320.nyat.app` 才会从服务端下发
   `*.u2095320.nyat.app` 的受信证书（日志里能看到 `autohttps certs loaded from server`）。
   改完 `extra` 必须**重启 frpc** 才生效。
3. **TCP 隧道不带 `X-Forwarded-For`**，所以 `CQP_TRUST_PROXY` 必须留 `0`，
   否则限流会按伪造头算。`CQP_COOKIE_SECURE` 用 https 访问时可以改 `1`。

`auto_https` 的原理：frpc 用 TLS 对外收连接，脱壳后用**明文 HTTP** 连本地服务，
所以本地服务不需要自己配证书。反过来说，本地已经开了 HTTPS 就不要再开自动 HTTPS
（会 TLS 套 TLS）。参见 <https://doc.natfrp.com/frpc/auto-https.html>。

### 6.2 cloudflared（临时演示用，域名每次都变）

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
域名每次重启都会换 —— 这也是它只能当临时演示的原因。

### 6.3 其它方式（实测对比）

| 方式 | 结论 |
|---|---|
| **localhost.run** `ssh -R 80:127.0.0.1:3010 nokey@localhost.run` | 能用，但免费版限速（日志 `slowed by 25 seconds`），502 频发，域名每次换 → 不推荐 |
| **serveo.net** | 连接成功，但浏览器先撞 `Serveo Browser Warning` 拦截页，无头浏览器过不去 → 不可用 |

### 6.4 开机自启默认走哪条隧道

`/data/adb/service.d/cqp-autostart.sh` 里服务起来（`code=200`）之后会顺手拉起隧道，
默认 **SakuraFrp**（域名固定）。要换：

```bash
# 在 cqp-autostart.sh 顶部或 su 环境里
export CQP_TUNNEL=cloudflare   # 或 none，只起服务不起隧道
```

日志里能看到 `starting sakura tunnel` 与 `sakura url=...`。

## 7. 验收

电脑上（需要有 `--remote-debugging-port=9333` 的 Chrome）：

```bash
node tools/e2e/phone-verify.mjs http://192.168.137.246:3010 <用户名> <密码>
node tools/e2e/phone-verify.mjs https://school.u2095320.nyat.app:32614 <用户名> <密码>
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
  但登录前 `/api/banks` 是 401，这两个字段永远不就位 → 首次进页面时不能要求它们
  （`waitForPage(0, 90000, { needLoaded: !(USER && PASS) })`）。

**隧道下偶发 `net::ERR_CONNECTION_CLOSED`**（真机踩出来的，已修）：
症状是练习提交点了没反应、`item.submitting` 永久为 true。根因是 node 默认
`keepAliveTimeout = 5s`，比反代的 60 秒空闲超时短，于是「node 刚准备关掉空闲连接、
反代正好复用这条连接发请求」→ 浏览器侧连接被关。两头都做了加固：
服务端把 `keepAliveTimeout` 拉到 72s，前端 `api()` 加 20 秒超时 + 网络层重试一次
（HTTP 4xx/5xx 不重试）。

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
