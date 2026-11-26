# SakuraFrp 隧道配置手册

把 `127.0.0.1:3010` 上的服务暴露到公网。全部参数来自官方文档实测
（<https://doc.natfrp.com/frpc/manual.html>、<https://doc.natfrp.com/frpc/usage.html>、<https://doc.natfrp.com/app/http.html>、<https://doc.natfrp.com/faq/frpc.html>）。

---

## 0. 先认清一件事

SakuraFrp 是**反向隧道**：你的手机/电脑主动连到节点，节点把公网流量转回来。
所以主机**不需要公网 IP**，只要能出网。实测这台手机出口 `112.53.136.22`，
连 `cn-hk-1/2/3.natfrp.io:7000` 全部连通。

```
公网用户 ──> frp-xxx.natfrp.com:端口 ──> SakuraFrp 节点 ──隧道──> 手机 127.0.0.1:3010
```

---

## 1. 隧道类型怎么选（合规红线）

| 类型 | 内地节点 | 非内地节点 | 访问形式 | 需要备案域名 |
|---|---|---|---|---|
| **TCP** | 必须用非内地节点才可穿透 HTTP 应用 | 可用 | `http://frp-xxx.com:12345`（带端口） | **不需要** |
| **HTTP** | 可用 | 可用 | `http://your.domain`（不带端口） | **内地节点必须备案** |
| **HTTPS** | 可用 | 可用 | `https://your.domain` | **内地节点必须备案** |

**结论（按易用度排序）**

1. **TCP 隧道 + 非内地节点** —— 不需要域名、不需要备案，最省事。
   代价：URL 带端口；**拿不到访问者真实 IP**（纯四层转发，不加 `X-Forwarded-For`）。
2. **HTTP/HTTPS 隧道 + 自己的域名** —— URL 干净、有真 IP，但要域名；
   内地节点还要求域名已备案。非内地节点不要求备案。

> 同时建 HTTP 和 HTTPS 两条隧道时，**必须挂在同一个节点**，否则证书与跳转会对不上。

**⚠️ 实测补充（2026-11 真机）：纯 TCP 隧道用 `http://` 访问会被网关拦成 501。**

内地节点上 `http://frp-bar.com:32614/api/health` 返回 `501 Not Implemented`，正文是
「您正试图使用 HTTP 协议访问此隧道 … 执行机房的内容合规要求和有关部门的管控规定」，
并给出两条出路：「在您的 Web 服务器中开启 HTTPS 支持」或「使用 自动 HTTPS 功能」。

所以**国内节点 + TCP 隧道 + Web 应用**这个组合，必须开自动 HTTPS（见 §9）。
开了之后浏览器用 `https://` 访问就正常，`http://` 仍然是 501（网关策略，不是配置问题）。

---

## 2. 建隧道

1. 登录 <https://www.natfrp.com/> → 左侧「隧道」→「创建隧道」。
2. 填：
   - **隧道类型**：`TCP`（或 `HTTP`/`HTTPS`）
   - **节点**：选非内地节点（TCP 穿 HTTP 应用时必须）；HTTP/HTTPS 想用内地节点就得有备案域名
   - **本地地址**：`127.0.0.1`
   - **本地端口**：`3010`
   - **备注**：`密码赛刷题平台`
3. 保存后列表里会显示 **隧道 ID**（一个数字，例如 `12345`）和公网地址。

---

## 3. 拿访问密钥

管理面板右上角头像 →「用户信息」→「**查看访问密钥**」。
形如 `AbCdEf...`（一长串）。**这是账号级密钥，等于密码，不要贴到公开仓库。**

---

## 4. 装启动器（推荐）

官方明确建议用**启动器**而不是裸 frpc —— 启动器会处理版本、自动重连、日志、看门狗。

手机（Termux）上装启动器：

```bash
pkg install -y proot-distro            # 启动器需要 proot 环境
# 或者直接下官方 launch 脚本（按官网「下载」页给的 arm64 链接）
```

电脑上：官网「下载」页选 Windows 版启动器，装完在界面里粘贴访问密钥、
勾选要启动的隧道即可。

---

## 5. 裸 frpc（启动器不可用时）

### 5.1 版本要求（硬门槛）

- **必须 ≥ `0.51.0-sakura-14`**
- 版本号里**必须带 `sakura`**，否则失去官方支持
- 用 `frpc -V`（**大写 V**）查版本

### 5.2 架构对应

| `uname -m` | 下载哪个包 |
|---|---|
| `x86_64` / `amd64` | `amd64` |
| `i386` / `i686` | `i386` |
| `aarch64` / `armv8l` | `arm64` ← 这台 Redmi K50 |
| `armv7l` / `armhf` | `armv7` |
| `arm` / `armel` | `arm_garbage`（先试 `armv7`，报 `Illegal instruction` 再换这个） |
| `mips` / `mips64` | `mips` / `mips64` |

### 5.3 Termux 特有坑

- 报 **`Segmentation fault`** → 下载地址尾部加 `_noupx`（UPX 压缩版在 Android 上会崩）
- Termux 里没有 `/tmp`，先 `export TMPDIR=$PREFIX/tmp && mkdir -p $TMPDIR`

### 5.4 启动

```bash
# 方式一：命令行参数
frpc -f <访问密钥>:<隧道ID>

# 方式二：多条隧道（逗号分隔）
frpc -f <访问密钥>:12345,12346

# 方式三：环境变量
export NATFRP_TOKEN=<访问密钥>
export NATFRP_TARGET=<隧道ID>
frpc
```

### 5.5 常驻（Termux）

```bash
termux-wake-lock
nohup frpc -f <访问密钥>:<隧道ID> > $PREFIX/tmp/frpc.log 2>&1 &
```

Android 省电策略仍可能杀进程：设置 → 应用 → Termux → 电池 → **无限制**。

### 5.6 可选旋钮（frpc.ini 或命令行）

| 参数 | 作用 | 版本门槛 |
|---|---|---|
| `bandwidth_limit = 2MB` | 限速（支持 `KiB`/`MiB`），省免费流量 | 0.51.0-sakura-9+ |
| `auth_pass = xxx` | 访问认证，进站先输密码 | `auth_mode=online` 为默认 |
| `local_access = true` | 同局域网可直连本地端口，不走隧道 | 0.51.0-sakura-9.3+ |
| `auto_https_mode = http` | HTTP 隧道自动加 `X-Forwarded-For` | — |

---

## 6. 服务端必须配合的两件事

### 6.1 真实 IP（A11）

- **TCP 隧道**：纯四层转发，**没有 `X-Forwarded-For`**。
  所有人看起来都是同一个 IP → **不能按 IP 限流**（一人触发全员 429）。
  本项目已按此设计：`server/auth.js` 的限流在 `clientIp().loopback` 为真时
  **只走用户名通道**（连续 5 次失败锁 5 分钟），IP 只进审计。
- **HTTP/HTTPS 隧道**：会带 `X-Forwarded-For`（`auto_https_mode=http`）。
  这时把 `.env` 里 `CQP_TRUST_PROXY=1` 打开，`clientIp()` 才会取首段地址。

```dotenv
# .env
CQP_TRUST_PROXY=0   # TCP 隧道（默认）
# CQP_TRUST_PROXY=1 # HTTP/HTTPS 隧道
```

### 6.2 Cookie 的 Secure 标志（A12）

TCP 隧道对外是 `http://`（哪怕 frp 那段是加密的）。浏览器不会在 http 下回传 `Secure` cookie。

```dotenv
CQP_COOKIE_SECURE=0   # TCP 隧道必须是 0
# CQP_COOKIE_SECURE=1 # 只有确定全程 https 才开
```

### 6.3 绑定地址

服务默认 `HOST=127.0.0.1`（只监听回环）——frpc 在同机上，走回环就够，**更安全**。
要让局域网里其他设备直连，才改 `HOST=0.0.0.0`。

---

## 7. 掉线怎么办（A13）

frpc 掉线时，公网侧是 **502**（节点连不上你）。用户看到的是「打不开」，不是登录失败。

探活：

```bash
curl -s http://127.0.0.1:3010/api/health
# {"ok":true,"rev":12,"uptime":3600,"node":"v24.22.3"}
```

`uptime` 突然变小 = 服务重启过（Android 杀了进程）。配 wake-lock + 电池无限制，
或在 Termux 里挂个守护：

```bash
while true; do
  node server/index.js >> $PREFIX/tmp/cqp.log 2>&1
  echo "[watchdog] server exited, restart in 3s" >> $PREFIX/tmp/cqp.log
  sleep 3
done
```

---

## 8. 流量估算（A14）

一次完整流程的量级（gzip 后，实际取决于题库）：

| 操作 | 流量 |
|---|---|
| 首页 + JS + CSS（首次） | ~90 KB（283 KB 未压缩） |
| 题库（内置 1051 题，脱答案） | ~180 KB（首次，之后 304 走缓存） |
| 单题作答 | < 1 KB |
| 一组 20 题 | ~15 KB |
| 一次模拟考（100 题 + 成绩页） | ~300 KB |

免费额度跑一个小团队（十几人日常刷题）通常够；长期用建议开 `bandwidth_limit`。

> gzip 是**服务端自带**的（`server/http.js` 的 `maybeGzip`，`Content-Encoding: gzip` +
> `Vary: Accept-Encoding`，<1 KB 不压）。上表的数字是开了 gzip 之后的实际字节数；
> 未压缩时首页是 283 KB 左右。真机实测：走隧道时首页从 70 秒降到 5 秒就能交互。

---

## 9. 自动 HTTPS（国内节点 + TCP 隧道的必选项）

### 9.1 为什么必须开

见 §1 的实测补充：国内节点上纯 TCP 隧道用 `http://` 会被网关拦成 501。

### 9.2 怎么开

```bash
# 写 extra 字段（PATCH/PUT /v4/tunnels/{id} 全是 404，只有这个 POST 有效）
curl -s -X POST https://api.natfrp.com/v4/tunnel/edit \
  -H "Authorization: Bearer <访问密钥>" -H "Content-Type: application/json" \
  -d '{"id":<隧道ID>,"extra":"auto_https = <子域名>.<你的域名>"}'
# → 200 {"extra":"auto_https = school.u2095320.nyat.app"}
```

面板上也可以：隧道 → 编辑 → 「自动 HTTPS」填子域名。

**关键：要写具体域名，不能只写 `auto`。**

- `auto_https = auto` → frpc 自己签一张证书（日志 `autohttps cert generated for yd.frp-bar.com`），
  浏览器报警告、curl 要加 `-k`。
- `auto_https = school.u2095320.nyat.app` → 从服务端下发受信证书
  （日志 `autohttps certs loaded from server: school.u2095320.nyat.app [CN = *.u2095320.nyat.app]`），
  `curl` 不带 `-k` 就能过，浏览器绿锁。

改完 `extra` **必须重启 frpc** 才生效。

### 9.3 绑定子域名

```bash
# 先看白名单词（约 90 个：school/lab/git/mc/api/www/nas/home …）
curl -s -X POST https://api.natfrp.com/v4/domain/get \
  -H "Authorization: Bearer <访问密钥>" -H "Content-Type: application/json" -d '{}'

# 绑定（rr 必须在白名单里；cqp 不在，会报「子域名前缀 cqp 不在白名单内」）
curl -s -X POST https://api.natfrp.com/v4/domain/bind \
  -H "Authorization: Bearer <访问密钥>" -H "Content-Type: application/json" \
  -d '{"rr":"school","tunnel":<隧道ID>,"domain":"u2095320.nyat.app","type":"CNAME"}'
# → 204，DNS 立即生效
```

### 9.4 原理与禁忌

`auto_https` 是 **frpc 用 TLS 对外收连接、脱壳后用明文 HTTP 连本地服务**。
所以本地服务不需要自己配证书，`HOST=127.0.0.1` 也不用改。

- ❌ 本地已经开了 HTTPS 就不要再开自动 HTTPS（会 TLS 套 TLS）
- ❌ 非 Web 应用（游戏、远程桌面）不要开
- ✅ 网页、HTTP API（国内节点）必须开

官方文档：<https://doc.natfrp.com/frpc/auto-https.html>

### 9.5 隧道 API 速查（v4，路径不是 RESTful）

| 操作 | 请求 |
|---|---|
| 列表 | `GET /v4/tunnels` |
| 创建 | `POST /v4/tunnels` body `{name,type,node,local_ip,local_port}` |
| 修改 | `POST /v4/tunnel/edit` body `{id,extra?,note?,local_ip?,local_port?}` |
| 删除 | `POST /v4/tunnel/delete` body `{id}` |
| 节点 | `GET /v4/nodes`（**返回以 id 为键的对象，不是数组**） |
| 账号 | `GET /v4/user/info` |
| 子域名 | `POST /v4/domain/get`、`POST /v4/domain/bind` |

`GET /v4/tunnels` 里每条含 `{id,name,node,type,online,extra,remote,local_port}`。
免费号隧道数上限 2 条，满了建隧道返回
`{"code":403,"msg":"您的隧道数量已到达上限 (当前 2 + 创建 1 > 2)"}`（HTTP 状态是 500，别看状态码）。

---

## 10. 隧道下的连接稳定性（真机踩出来的）

SakuraFrp / cloudflared 反代下，`POST` 偶发 `net::ERR_CONNECTION_CLOSED`，
前端表现为「点了提交没反应」。根因与修法：

- **node 默认 `keepAliveTimeout = 5s`**，比反代的 60 秒空闲超时短。于是会出现
  「node 刚准备关掉空闲连接、反代正好复用这条连接发请求」→ 连接被单方面关闭。
  修法：`server.keepAliveTimeout = 72s`、`headersTimeout = 75s`、`requestTimeout = 120s`，
  让关连接的决定总由反代先做出。
- **前端 `api()` 加 20 秒超时 + 网络层重试一次**。`fetch` 自身抛错（连接被关/超时/断网）
  标记 `network=true` 后重试；HTTP 4xx/5xx 不重试（那是业务结果）。超时还保证
  `.then/.catch` 一定执行，调用方的锁不会悬空。

---

## 11. 排障速查

| 现象 | 原因 | 修法 |
|---|---|---|
| `frpc: command not found` | 没下对架构 / 没 `chmod +x` | `chmod +x frpc` |
| `Illegal instruction` | CPU 缺指令集 | armv7 换 `arm_garbage` |
| `Segmentation fault` | UPX 压缩版 | 下 `_noupx` 版 |
| 连不上节点 | 出口封了 7000 | 先 `nc -vz cn-hk-1.natfrp.io 7000` 测；换节点或换 443 |
| 打开是 502 | 本地服务没跑 | `curl 127.0.0.1:3010/api/health` |
| 能打开但登录后空白 | 浏览器拦了 cookie | 检查 `.env` 的 `CQP_COOKIE_SECURE` 是否为 1（TCP 隧道必须 0） |
| 一堆人同时报 429 | 拿不到真实 IP，共用出口 | 确认是按用户名限流；`CQP_TRUST_PROXY` 与隧道类型匹配 |
| 字体/样式没加载 | 反向代理换了 Host | 本项目所有资源走相对路径，一般不会；确认没套 CDN 改写 |
