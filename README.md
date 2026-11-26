# 密码赛刷题平台（服务器版）

面向 **2026 年江苏省密码行业职业技能竞赛（学生组）** 理论备赛的刷题平台。
原版是一个离线单文件网页；本分支把它改造成**可部署在服务器上的多用户版本**：
账号登录、服务端权威判分、跨设备同步、团队汇总、题库按需导入。

- **题库**：内置 1051 题（单选 491 / 多选 358 / 判断 172 / 填空 30），可由管理员另传题库
- **零依赖**：只用 Node 内置的 `node:http` + `node:sqlite`，**不需要 `npm install`**
- **服务端权威**：答案不下发，作答提交后才返回对错与解析；换设备、换浏览器数据都在
- **可离线跑在手机上**：Termux + Node 24 已实测通过（Redmi K50 / Android 14）

---

## 快速开始

需要 **Node.js ≥ 22.5**（`node:sqlite` 从 22.5 开始内置）。无需 npm 依赖。

```bash
cp .env.example .env      # 按需改端口、是否开放注册
node server/index.js
```

打开 <http://127.0.0.1:3010>。首次进入会看到登录卡，点「注册」建号 ——
**第一个注册的账号自动成为管理员**（也可以先在 `.env` 里设 `CQP_BOOTSTRAP_ADMIN` /
`CQP_BOOTSTRAP_PASSWORD` 预置）。

首次启动会自动：

1. 建 SQLite 库（`data/app.db`）与 7 张表；
2. 若 `public/index.html` 不存在（它是构建产物、被 `.gitignore` 忽略），自动跑一次
   `tools/build.mjs --target server`；构建失败会在日志里提示手动 `npm run build`；
3. 从 `src/data/bank.json` 导入内置题库（`slug=builtin`，1051 题）；
4. 从 `data/seed/*.json` 导入附带的两个小题库（`crypto` 44 题、`law` 32 题）。

Windows 上有更省事的启动脚本：

```powershell
.\deploy\start.ps1              # 前台，Ctrl+C 停
.\deploy\start.ps1 -Background  # 后台，pid 写 data\srv.pid
.\deploy\start.ps1 -Status      # 状态 + 健康检查
.\deploy\start.ps1 -Stop
```

---

## 功能

| 功能 | 说明 |
| --- | --- |
| 账号体系 | 注册 / 登录 / 改密码 / 改显示名；scrypt 存密码，会话 7 天，HttpOnly cookie |
| 多用户隔离 | 每个账号在**每个题库**下各有一份独立学习档案（换题库不串记录） |
| 三级筛选 | 部分 → 章 → 题型，另有知识点标签 |
| 分类练习 / 全库随机 | 两种模式出题，提交后服务端判分 |
| 判分规则 | 单选 / 判断精确匹配；多选**全对才算对**；填空忽略大小写、首尾空格、全角半角 |
| 三色信心 | 错 = 红（进错题本）、猜对 = 黄（进）、有把握且对 = 绿（不进） |
| 错题本 | 连续 2 次「有把握答对」自动移出 + 手动移出；在册 / 已移出视图 |
| 学习统计 | 对错次数 + 掌握指数 ＝（有把握对×1 + 猜对×0.5 + 错×0）÷ 作答次数 × 100 |
| 跨设备同步 | 每次作答后 250 ms 防抖上送；冲突时服务端按记录键/时间合并，不会覆盖丢数据 |
| 模拟选拔赛 | 100 题 / 60 分钟 / 100 分；**服务端出卷与判分**，到点自动交卷；成绩页可逐题改信心 |
| 团队汇总 | 统计**本服务器所有账号**的团队易错题（≥2 个不同账号答错）、个人易错题、交叉矩阵 |
| 导出 / 导入 | 按本地自然日 / 区间 / 全部导出 JSON，可与老离线版互导 |
| 管理后台 | 题库上传 / 删除、用户列表 / 停用 / 改角色 / 重置密码、审计日志 |
| 校对纠错 | 标疑问与手动改答案（覆盖层随账号保存，可导出共享） |

### 三色规则与错题本（与原版一致）

```
提交作答 + 信心标记
   ├─ 答错                → 红色 → 进错题本
   ├─ 答对 + 带猜测        → 黄色 → 进错题本
   └─ 答对 + 有把握        → 绿色 → 不进（且给在册条目 +1 连续计数，满 2 次自动移出）
```

---

## 目录结构

```
server/                 服务端（全部零依赖）
  index.js              入口：HTTP 服务、路由装配、启动流程
  config.js             环境变量解析（自带极简 .env 读取）
  db.js                 node:sqlite 封装：建表、迁移、事务、备份
  http.js               响应/请求体/cookie/CSRF/静态文件/路由表
  auth.js               scrypt 密码、会话、限流、账号校验
  banks.js              题库存取、脱答案下发、外部题库归一化适配器
  store-doc.js          学习文档的形状、合并（含错题本 LWW）、统计
  routes-data.js        题库 / 文档同步 / 判分 / 团队 / 模拟考路由
  mock.js               模拟考：出卷、存卷、交卷、作废
  admin.js              管理后台：题库上传删除、用户管理、审计
  reset.js              ⚠ 危险：清空数据库

src/                    前端源码（构建时内联成一个 HTML）
  core/                 15 个 ES module：判分、出题、模拟考、存储契约…
  ui/app.js             UI 逻辑（登录门、API 层、各页面渲染）
  ui/app.html           页面骨架
  ui/style.css          样式
  data/bank.json        内置题库（1051 题，构建时**不**下发到浏览器）

data/                   运行时数据（已 gitignore）
  app.db                SQLite 数据库
  seed/*.json           启动时自动导入的题库
  backup/               数据库备份

deploy/
  start.ps1             Windows 启动/停止/状态脚本
  termux-setup.sh       Termux 一键环境准备（手机上跑）
  frp-tunnel.md         SakuraFrp 隧道配置手册

tools/
  build.mjs             构建（--target server 产 public/index.html；默认离线单文件）
  validate_bank.mjs     题库冻结契约校验
  parse_bank.py         从 PDF 解析题库（需要 Python + pypdfium2）

tests/                  146+ 项回归测试（node --test）
```

---

## 接口

除 `/api/health` 与 `/api/auth/*` 外全部需要登录；写操作额外校验同源与 `Content-Type`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | `{ok,rev,uptime,node}`，探活用 |
| POST | `/api/auth/register` | 注册（`CQP_ALLOW_REGISTER=0` 时关闭） |
| POST | `/api/auth/login` | 登录，失败按用户名限流 |
| POST | `/api/auth/logout` | 登出 |
| POST | `/api/auth/password` | 改密码（其他设备会话失效） |
| POST | `/api/auth/profile` | 改显示名 |
| GET | `/api/me` | 当前用户；未登录返回 `{user:null}` |
| GET | `/api/banks` | 题库列表 |
| GET | `/api/banks/:slug` | 题库（**已脱答案**，带 ETag / 304） |
| GET | `/api/store?bank=` | 读当前题库下的学习文档 `{rev,store}` |
| PUT | `/api/store` | 写 `{baseRev,bankSlug,store}`，rev 不匹配则合并 |
| DELETE | `/api/store?bank=` | 清空该题库下的学习数据 |
| POST | `/api/practice/grade` | 单题判分，返回正确答案与解析 |
| POST | `/api/practice/grade-batch` | 批量判分（≤200 题） |
| POST | `/api/practice/answers` | 取答案（默认只给本人已作答的题） |
| GET | `/api/team/summary?bank=` | 全服务器团队汇总 |
| POST | `/api/mock/start` | 开考（已有未交卷则复用） |
| GET | `/api/mock/current?bank=` | 当前未交卷的场次 |
| GET | `/api/mock/list?bank=&limit=` | 历史场次 |
| PUT | `/api/mock/:id/responses` | 存作答进度 |
| POST | `/api/mock/:id/submit` | 交卷（服务端判分） |
| POST | `/api/mock/:id/abandon` | 作废本场 |
| GET | `/api/admin/users` | 用户列表（含各题库统计） |
| POST | `/api/admin/users/:id/disabled` | 停用 / 启用 |
| POST | `/api/admin/users/:id/role` | 改角色 |
| POST | `/api/admin/users/:id/password` | 重置密码 |
| GET/POST | `/api/admin/banks` | 题库列表 / 上传题库 |
| DELETE | `/api/admin/banks/:slug` | 删除自建题库 |
| GET | `/api/admin/audit` | 审计日志 |

---

## 配置（`.env`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址。走隧道/反代留在回环；要局域网直连改 `0.0.0.0` |
| `PORT` | `3010` | 端口 |
| `CQP_DB` | `data/app.db` | SQLite 路径 |
| `CQP_BACKUP_DIR` | `data/backup` | 备份目录 |
| `CQP_ALLOW_REGISTER` | `1` | 是否允许自助注册 |
| `CQP_SESSION_DAYS` | `7` | 会话有效期（1–90） |
| `CQP_BOOTSTRAP_ADMIN` | 空 | 预置管理员用户名（users 表为空时生效） |
| `CQP_BOOTSTRAP_PASSWORD` | 空 | 预置管理员密码 |
| `CQP_COOKIE_SECURE` | `0` | 全程 https 才设 `1`；**TCP 隧道必须 0** |
| `CQP_TRUST_PROXY` | `0` | 信任 `X-Forwarded-For`。HTTP/HTTPS 隧道设 `1`，TCP 隧道保持 `0` |
| `CQP_MAX_BODY` | `2097152` | 普通请求体上限（字节） |
| `CQP_MAX_BANK_BODY` | `8388608` | 题库上传上限（字节） |
| `TZ` | `Asia/Shanghai` | 时区（统计按本地自然日） |

---

## 部署到手机（Termux）

这台 Redmi K50 上已实测跑通（Node v24.22.3 + `node:sqlite`）。

```bash
# 手机 Termux 里
bash deploy/termux-setup.sh     # 装 openssl + nodejs-lts + 校验 node:sqlite
git clone <你的仓库> cqp && cd cqp
cp .env.example .env
node server/index.js
```

**两条硬约束**（实测踩过）：

1. **`pkg` / `apt` 不能以 root 运行** —— Termux 永久禁用了，必须用 Termux 自己的 uid
   （直接开 Termux 终端，或从 PC 用 `adb shell run-as com.termux`）。
2. **必须先升级 openssl** —— 随 nodejs-lts 带下来的 `openssl 1:3.2.1` 太旧，
   `node` 会报 `CANNOT LINK EXECUTABLE "node": cannot locate symbol "OSSL_INDICATOR_get_callback"`。
   `termux-setup.sh` 里已经用 `--force-confnew` 处理了。

不要用 nodejs.org 的 `node-v*-linux-arm64.tar.xz` —— 那是 **glibc** 构建，
Termux 是 **bionic**，会直接 `CANNOT LINK EXECUTABLE ... library "libc.so.6" not found`。
必须用 `pkg install nodejs-lts`（Termux 仓库版，编译时带 `--dest-os=android --shared-sqlite`）。

手机不联网也能验收：`adb forward tcp:13310 tcp:3010` 后开 <http://127.0.0.1:13310>。

---

## 部署到公网（SakuraFrp）

手机/电脑当主机都能跑，只要能出网。完整手册见 [`deploy/frp-tunnel.md`](deploy/frp-tunnel.md)，要点：

- **TCP 隧道 + 非内地节点**：不需要域名、不需要备案，URL 带端口；拿不到真实 IP
- **HTTP/HTTPS 隧道 + 自己的域名**：URL 干净、有真 IP；内地节点要求域名已备案
- frpc 版本要求 **≥ `0.51.0-sakura-14`**（版本号必须含 `sakura`）
- `CQP_COOKIE_SECURE` 与 `CQP_TRUST_PROXY` 必须和隧道类型匹配（见手册 §6）

---

## 数据与备份

- 全部数据在一个 SQLite 文件里：`data/app.db`（WAL 模式，另有 `-wal` / `-shm`）。
- 备份就是复制这三个文件（服务停止时最安全），或：

```bash
node -e 'import("./server/db.js").then(m=>{m.openDb();m.backupTo("data/backup")})'
```

- 库结构与上游 1.0.0 学习文档格式兼容：老的「导出全部备份」JSON 仍能在
  「导出 / 导入」页里导入合并。

---

## 安全说明

- 密码：scrypt（N=16384, r=8, p=1, keylen=64），`timingSafeEqual` 比对
- 会话：32 字节随机 token，存库，`HttpOnly; SameSite=Lax; Path=/`
- CSRF：写操作校验 `Origin` / `Referer` 同源，且强制 `Content-Type: application/json`
- 限流：IP 60 秒内 >12 次登录尝试即 429；单账号连续 5 次失败锁 5 分钟
  （反向代理下拿不到真 IP 时，**自动退化为只按用户名限流**，避免一人锁住全员）
- 脱答案：下发的题库删掉 `answer` / `rawAnswer` / `explanation` 三个字段
- 静态文件：白名单，拒绝 `..` / `\` / NUL
- 响应头：`X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`、
  `Referrer-Policy: same-origin`、CSP 只放行同源与内联脚本

---

## 从源码构建

```bash
# 服务端版（产出 public/index.html，不含题库）—— 默认，也是唯一受支持的交付目标
npm run build

# 离线单文件版（产出 dist/密码赛刷题平台.html，含题库；这是上游原始形态）
# 已废弃：服务端版删掉了本地存储与本地判分，app.js 不再读内联题库，
# 因此这个目标过不了 artifact 自检，只保留给历史产物做对照。
npm run build:legacy

# 题库契约校验
node tools/validate_bank.mjs

# 回归测试
node --test tests/
```

---

## 相对原版的改动

| 原版（离线单文件） | 本版（服务器） |
| --- | --- |
| 浏览器 `localStorage` 存全部数据 | 服务端 SQLite，按账号 + 题库隔离 |
| 题库内联进 HTML | 题库留在服务端，只下发脱答案版本 |
| 前端自己判分（答案在页面里） | 提交作答后服务端判分并返回答案 |
| 昵称当身份 | 账号 + 密码，昵称只是显示名 |
| 「导入队友 JSON」做团队汇总 | 直接汇总本服务器全部账号，JSON 导入仍保留 |
| 模拟考在前端出卷判分 | 服务端出卷（重复开考复用同一张卷）、服务端判分 |
| 存储满了/坏了进「只读抢救」模式 | 不存在该状态：数据在服务端，本地只是缓存 |

---

## 题库来源与免责声明

- 题面与答案来自**竞赛组委会公开发布的题库文件**（在原发布渠道公开），**版权归竞赛组委会所有**；
- `data/seed/crypto.json` 与 `data/seed/law.json` 是另行整理的两个小题库（44 + 32 题），
  同样仅供备赛练习；
- 本仓库只提供**工具**与**已解析的数据文件**（`src/data/bank.json`），不转载组委会发布的原始 PDF；
- 本项目非官方发布物；若版权方认为仓库内容不妥，请提 Issue，会第一时间删除相关内容。
  详见 [`docs/题库来源.md`](docs/题库来源.md)。

## 隐私声明

- 本仓库**不包含任何个人信息**：没有名单、报名材料、证件号码、联系方式或照片；
- 部署后的数据库里只有使用者自己注册的账号与作答记录，**不向外发送任何数据**；
- 没有埋点、没有第三方统计、没有外链资源（构建期有硬闸：`src/` 里出现 `https?://` 即构建失败）。

## 已知限制

1. 模拟赛成绩页对「已被手动移出」的题仍显示「已在错题本」角标（仅显示层）；
2. 界面没有「继续练习」入口：中途离开练习轮后需重新进入（作答状态不丢）；
   模拟赛不受此限制 —— 服务端挂着未交的卷时，刷新后会自动接着考；
3. 知识点词表未完全扩充，部分题只有章级兜底标签（不影响出题/判分/统计）；
4. 内置题库的 1051 题**没有解析文本**（原 PDF 未提供逐题解析），作答后只显示正确答案；
5. 团队汇总在账号数很多（>200）时会变慢，因为它要遍历所有人的文档；
6. `--target offline`（离线单文件版）已废弃：服务端版删掉了本地存储与本地判分，
   该目标的 artifact 自检必然失败，`npm run build:legacy` 只用于对照旧产物。

## 许可证

- **代码**（`server/`、`src/`、`tools/`、`tests/`、`deploy/`）：[MIT](LICENSE)
- **题库与题目内容**：版权归竞赛组委会，**不在 MIT 授权范围内**
