# 端到端验收脚本

这些脚本不参与 `node --test`（它们是**对着真跑起来的服务 + 真浏览器**跑的），
需要先启动服务、再在仓库根目录执行。全部用相对路径（`data/shots`、`data/chrome-profile`），
**必须在仓库根目录跑**。

## 前置

```powershell
# 1) 起一个干净的库（冒烟脚本会注册账号，别污染正式库）
.\deploy\start.ps1 -Stop
Remove-Item data\e2e.db* -Force -ErrorAction SilentlyContinue
$env:CQP_DB = 'data/e2e.db'
node server/index.js     # 或 .\deploy\start.ps1 -Background

# 2) 需要无头 Chrome（只有 flow*/shots 需要）
#    路径写死在脚本顶部 CHROME 常量，按本机改
```

## 脚本

| 脚本 | 测什么 | 需要 Chrome |
| --- | --- | --- |
| `smoke-p1.mjs` | 同步与合并：两台"设备"并发写、错题本 LWW、幂等、单题/批量判分、团队汇总、鉴权 | 否 |
| `smoke-p3.mjs` | 模拟考后端：出卷、复用 running、暂存、交卷给答案、二次交卷 400、越权 404、abandon | 否 |
| `smoke-admin.mjs` | 管理后台：首个账号是 admin、停用/启用/改角色/重置密码、题库上传与删除、审计 | 否 |
| `smoke-import.mjs` | 导入：`cqp-export` 合并、错题本不被丢、重复导入幂等、题库隔离 | 否 |
| `flow.mjs` | 真实刷题流：注册 → 分类练习 → 作答 → 服务端判分回填答案 → 结算 → 错题本/统计 | 是 |
| `flow-mock.mjs` | 真实模拟考流：开局 → 答题 → 刷新续考 → 交卷 → 成绩页 → 记录落库 | 是 |
| `shots.mjs` | 逐页截图到 `data/shots/*.png`，顺带断言 0 console error / 0 未捕获异常 | 是 |

```powershell
node tools/e2e/smoke-p1.mjs
node tools/e2e/flow.mjs
node tools/e2e/flow-mock.mjs
node tools/e2e/shots.mjs
```

## 注意

- `smoke-admin.mjs` **必须用全新库**：它断言「第一个注册的账号是管理员」，
  跑在已有账号的库上会失败（`Cannot read properties of null`）。
- `flow.mjs` / `flow-mock.mjs` 复用同一个 `data/chrome-profile`，会沿用上次的登录 cookie；
  换库后 cookie 失效，脚本会自动重新注册。
- 截图脚本会把 `--user-data-dir` 设成**绝对路径**（相对路径会导致 CDP 端口不监听）。
