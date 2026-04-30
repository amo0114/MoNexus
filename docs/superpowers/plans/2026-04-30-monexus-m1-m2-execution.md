# MoNexus M1 + M2 落地任务书

| 字段 | 值 |
| --- | --- |
| 版本 | v1.0 |
| 日期 | 2026-04-30 |
| 配套 PRD | `docs/superpowers/specs/2026-04-30-monexus-product-prd.md` |
| 覆盖里程碑 | M1（MVP 收尾）+ M2（灰度上线） |
| 时间窗口 | 2026-04-30 → 2026-05-21（约 3 周） |

> **使用方式**：每个任务块都是"可独立领取、可独立验收"的最小单元。任务前缀代表归属：`B-` 后端 / `F-` 前端 / `I-` 集成 / `O-` 运维 / `D-` 文档。

---

## M1 — MVP 收尾（Week 1）

### 目标

- 关闭所有 P0 缺陷
- 提交并合并所有未提交工作到 `master`
- 三角色完整联调一次

### M1 任务列表

#### B-1 修复商家订单 settlement 缺失（P0-1）

- **文件**：`server/src/modules/merchant/service.ts`、`server/src/modules/merchant/controller.ts`、`server/src/__tests__/merchant.test.ts`
- **改动**：
  - `listMyOrders` / `getMyOrderDetail` 加 `include: { settlement: { select: { settlementAmount: true, status: true, settledAt: true } } }`
  - controller 层把 `settlement.settlementAmount` 扁平化为顶层 `settlementAmount`，匹配契约 §3.4
  - 测试用例：商家查询自己的订单，必须能拿到 `settlementAmount` 字段
- **验收**：
  - `npm --prefix server test` 通过
  - 前端 `MerchantDashboardPage:orders` 表格不再显示 undefined
- **预估**：0.5 天

#### B-2 审核通过/停用商家时撤销 RefreshToken（P0-2）

- **文件**：`server/src/modules/admin/service.ts`、`server/src/modules/auth/service.ts`、`server/src/__tests__/admin.test.ts`
- **改动**：
  - 在 `auth/service.ts` 导出 `revokeAllUserRefreshTokens(userId, tx?)`
  - `approveMerchant` / `suspendMerchant` 事务内调用上述函数
  - 用户封禁逻辑（如有）也加同样调用
  - 测试：审核通过后旧 refreshToken 用 `/api/auth/refresh` 应得 401
- **验收**：
  - 测试覆盖三种场景：通过 / 停用 / 封禁
- **预估**：0.5 天

#### F-3 Layout 商家入口 4 状态展示（P0-3）

- **文件**：`src/components/Layout.tsx`
- **改动**：根据 PRD §2.2 的状态矩阵渲染：
  ```tsx
  {user?.role === 'user' && !user.merchant && <ApplyEntry />}
  {user?.role === 'user' && user.merchant?.status === 'pending' && <PendingBadge />}
  {user?.role === 'user' && user.merchant?.status === 'rejected' && <RejectedBadge />}
  {user?.role === 'user' && user.merchant?.status === 'suspended' && <SuspendedBadge />}
  {user?.role === 'merchant' && user.merchant?.status === 'active' && <MerchantEntry />}
  ```
- **验收**：4 种 mock 用户登录后顶部展示对应文案
- **预估**：0.5 天

#### F-4 role-skew 自愈（P0-4）

- **文件**：`src/App.tsx`、`src/api/client.ts`、`src/api/auth.ts`、`src/stores/authStore.ts`
- **改动**：
  - `App.tsx` ProtectedRoute 内：调用 `getMe()` 后，解码当前 `accessToken` 中的 `role`，与 `me.role` 比对
  - 不一致 → 调 `/api/auth/refresh`（已有 axios 拦截器无法触发，需主动调用）→ 更新 `accessToken` → 再调 `getMe`
  - 重试上限 1 次，失败则 `logout()`
- **验收**：
  - 用户登录态下，模拟管理员审核通过：5 秒内点商家入口可成功进入（不需要登出再登录）
- **预估**：0.5 天

#### I-5 提交所有未提交工作（P0-5）

- **目标**：把 50+ 文件改动拆 4 个原子 commit
- **拆分**：
  1. `feat(server): implement merchant module and settlement flow`（merchant module + admin merchant + orders settlement + tests + migrations + seed）
  2. `feat(frontend): implement merchant portal and admin merchant management`（types/merchant + api/merchant + api/adminMerchant + MerchantApplyPage + MerchantDashboardPage + AdminPage 商家/结算 tab）
  3. `feat(frontend): upgrade order center with detail modal`（ProfilePage 升级 + OrderDetailModal + ProductDetailPage + SuccessModal 跳转入口）
  4. `docs(specs): add merchant settlement contract and openapi`
- **验收**：
  - `git log --oneline` 出现这 4 个清晰 commit
  - 每个 commit 单独 build 通过（不强制，但应当）
- **预估**：0.5 天

#### O-6 测试默认加载 TEST_DATABASE_URL（P0-6）

- **文件**：`server/.env.test`（新增，gitignored）、`server/package.json`、`.gitignore`
- **改动**：
  ```
  # server/.env.test
  TEST_DATABASE_URL=postgresql://monexus:monexus_dev_2026@localhost:5432/monexus_test?schema=public
  ```
  ```json
  // server/package.json
  "test": "dotenv -e .env.test -- vitest run",
  "test:watch": "dotenv -e .env.test -- vitest"
  ```
  - 安装 `dotenv-cli` 作为 devDependency
  - `.gitignore` 补 `.env.test`
- **验收**：
  - 测试库存在前提下，`npm --prefix server test` 直接跑通，不再需要 `TEST_DATABASE_URL=...` 前缀
- **预估**：0.25 天

#### I-7 三角色完整联调

- **前置**：B-1 ~ B-2、F-3 ~ F-4 全部完成
- **流程**：
  1. `docker compose up -d postgres`
  2. `npm --prefix server run db:migrate:deploy && npm --prefix server run db:seed`
  3. 启动后端 + 前端
  4. 跑契约 §10 联调清单（user / merchant / admin 各 7 步）
  5. 记录任何失败到 `docs/superpowers/integration/M1-2026-05-07.md`
- **验收**：
  - 所有清单项打勾
  - 至少一个回归测试覆盖发现的 bug
- **预估**：1 天

#### D-8 OpenAPI 与实现对齐

- **文件**：`docs/superpowers/specs/monexus-api-openapi.json`
- **改动**：
  - 手动 diff OpenAPI 中 `MerchantOrder` schema 与 contract.md §3.4
  - 修正任何漂移（settlementAmount、settlement 关系、optional 字段）
  - （可选）引入 `@redocly/cli lint` 进 CI
- **验收**：
  - `redocly lint monexus-api-openapi.json` 无 error
  - 与 contract.md 一致
- **预估**：0.5 天

### M1 总计

约 4.25 工作日 + 1 天联调 = **1 周内可完成**。

---

## M2 — 灰度上线（Week 2-3）

### 目标

- 50 名内测用户能稳定使用
- 备份、监控、CI、错误聚合到位
- 一份 runbook，新运维 30 分钟独立完成基础运维

### M2 任务列表（按优先级）

#### M2.A 业务必备（P0）

##### B-9 密码重置（邮箱链接）

- **新增表**：`PasswordResetToken { id, userId, tokenHash, expiresAt, usedAt? }`
- **新增接口**：
  - `POST /api/auth/password-reset/request` body `{ email }` → 发送邮件（M2 可用 console.log 模拟，M3 接 SMTP）
  - `POST /api/auth/password-reset/confirm` body `{ token, newPassword }` → 校验+改密+撤销所有 refreshToken
- **限流**：按邮箱单独限流 3 次/小时
- **验收**：
  - 流程跑通
  - token 一次性、过期失效
- **预估**：1 天

##### B-10 修改密码（已登录态）

- **新增接口**：`POST /api/auth/password-change` body `{ oldPassword, newPassword }` → 校验旧密码+改密+撤销其他 refreshToken
- **验收**：测试覆盖
- **预估**：0.5 天

##### B-11 系统配置在线可调

- **新增表**：`SystemConfig { key, value, updatedAt, updatedBy }`
- **可配置项**：`registerReward`、`checkinReward`、`inviteReward`、`refreshTokenMaxAgeDays`
- **新增接口**：
  - `GET /api/admin/config` 列出所有配置
  - `PUT /api/admin/config/:key` 更新
- **改动**：`config/index.ts` 暴露 `getConfigValue(key)` 优先读 SystemConfig 表，fallback env
- **验收**：
  - 后台可改注册奖励，新注册用户立即生效
- **预估**：1 天

##### B-12 用户封禁/解封

- **新增接口**：
  - `PUT /api/admin/users/:id/ban` body `{ reason? }` → `User.status = '已封禁'` + 撤销所有 refreshToken + AdminLog
  - `PUT /api/admin/users/:id/unban` → 恢复 status
- **前端**：AdminPage:users tab 加按钮
- **验收**：被封用户登录拒绝，已登录被踢下线
- **预估**：0.5 天

##### F-13 个人中心：修改密码 + 重置密码入口

- **文件**：`src/pages/ProfilePage.tsx`、`src/pages/LoginPage.tsx`、新增 `src/pages/PasswordResetPage.tsx`
- **预估**：0.5 天

##### F-14 后台：用户封禁 + 系统配置 UI

- **文件**：`src/pages/AdminPage.tsx`
- **预估**：0.5 天

#### M2.B 基础设施（P0）

##### O-15 GitHub Actions CI

- **文件**：`.github/workflows/ci.yml`
- **流程**：
  ```yaml
  jobs:
    backend:
      services:
        postgres: ...
      steps:
        - npm --prefix server ci
        - npm --prefix server run build
        - npx prisma migrate deploy
        - npm --prefix server test
    frontend:
      steps:
        - npm ci
        - npm run build
        - npx tsc --noEmit
  ```
- **保护**：master 分支必须 CI 通过才能 merge
- **验收**：PR 自动跑 CI，失败阻塞合并
- **预估**：1 天

##### O-16 PostgreSQL 每日备份

- **脚本**：`scripts/backup.sh`
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  TS=$(date -u +%Y%m%dT%H%M%SZ)
  pg_dump "$DATABASE_URL" | gzip > "/var/backups/monexus/${TS}.sql.gz"
  find /var/backups/monexus -name '*.sql.gz' -mtime +30 -delete
  # 异地：rclone copy 到 OSS/S3
  ```
- **cron**：每日 02:00 UTC
- **演练**：手动跑一次还原到 staging
- **验收**：还原后 staging 可正常登录
- **预估**：1 天

##### O-17 健康检查升级

- **文件**：`server/src/app.ts`
- **改动**：`/api/health` 返回 `{ status, time, db: 'ok'|'fail' }`，做 `prisma.$queryRaw\`SELECT 1\``
- **预估**：0.25 天

##### O-18 结构化日志

- **依赖**：`pino`、`express-pino-logger`
- **配置**：JSON 格式 + `requestId` middleware（uuid v4 注入到 `req.id`）
- **关键事件埋点**：登录成功/失败、注册、兑换、签到、商家审核、批量结算
- **预估**：1 天

##### O-19 错误聚合（Sentry / GlitchTip）

- **后端**：`@sentry/node` + Express handler（在 errorHandler 之前）
- **前端**：`@sentry/react` + ErrorBoundary
- **环境**：`SENTRY_DSN` 走 env，dev 环境不上报
- **预估**：0.5 天

##### O-20 部署 Runbook

- **文件**：`docs/operations/runbook.md`
- **覆盖**：
  - 启动 / 停止服务
  - 数据库备份 / 还原
  - 用户改积分（紧急）
  - 商家停用（紧急）
  - 日志查看
  - Sentry 告警处理
  - 常见故障：PG 连接失败 / 端口占用 / 磁盘满 / 内存溢出
- **预估**：1 天

#### M2.C 业务增强（P1）

##### B-21 库存预警

- **新增**：商家可设置 `Product.lowStockThreshold`，库存 < 阈值时（在订单事务尾部检查）记录到 `Notification` 表
- **接口**：`GET /api/merchant/notifications`
- **预估**：1 天

##### B-22 操作日志筛选/搜索

- **接口**：`GET /api/admin/logs?action=&adminUserId=&from=&to=&page=&pageSize=`
- **前端**：AdminPage:logs 加筛选条
- **预估**：0.5 天

##### F-23 商家销售统计图表

- **依赖**：`recharts` 或 `chart.js`
- **接口**：`GET /api/merchant/stats/timeseries?days=7|30` → 返回每日订单数、收入
- **前端**：MerchantDashboardPage:dashboard 加折线图
- **预估**：1 天

##### F-24 商家订单导出 CSV

- **前端**：MerchantDashboardPage:orders 加"导出 CSV"按钮，纯前端拼接
- **预估**：0.25 天

#### M2.D 文档与流程（P0）

##### D-25 OpenAPI lint 进 CI

- **依赖**：`@redocly/cli`
- **CI 增加**：`npx redocly lint docs/superpowers/specs/monexus-api-openapi.json`
- **预估**：0.25 天

##### D-26 模块 README

- **新增**：
  - `server/src/modules/auth/README.md`
  - `server/src/modules/merchant/README.md`
  - `server/src/modules/orders/README.md`
  - `server/src/modules/admin/README.md`
- **内容**：模块职责 / 关键接口 / 关键不变量 / 依赖
- **预估**：1 天

##### D-27 灰度上线发布报告

- **文件**：`docs/operations/M2-launch-2026-05-21.md`
- **内容**：上线时间、版本号、监控基线、首批 50 用户邀请清单、应急联系人、回滚预案
- **预估**：0.5 天

### M2 总计

业务 4.5 + 基础设施 5 + 增强 2.75 + 文档 1.75 = **约 14 工作日**，3 周内完成。

---

## 任务依赖图

```
M1:
  B-1 ─┐
  B-2 ─┼─→ I-7（联调）─→ M1 收尾
  F-3 ─┤
  F-4 ─┤
  I-5（提交）─→ M1 收尾
  O-6（独立）
  D-8（独立）

M2:
  B-9 → F-13
  B-10 → F-13
  B-11 → F-14
  B-12 → F-14
  O-15（先行，所有 PR 都过 CI）
  O-16, O-17, O-18, O-19（独立）
  O-20 ← 所有任务完成后总结
  B-21, B-22, F-23, F-24（独立增强）
  D-25 → O-15（顺带跑 lint）
  D-26（独立）
  D-27 ← 所有任务完成后
```

---

## 工作分配建议

> 假设 1 后端 + 1 前端 + 0.5 集成/运维。

### Week 1（M1）

| 角色 | 任务 |
| --- | --- |
| 后端 | B-1, B-2, O-6 |
| 前端 | F-3, F-4 |
| 集成 | I-5（拆 commit），I-7（联调），D-8 |

### Week 2（M2.A + M2.B 启动）

| 角色 | 任务 |
| --- | --- |
| 后端 | B-9, B-10, B-11, B-12 |
| 前端 | F-13, F-14 |
| 运维 | O-15, O-16, O-17 |

### Week 3（M2.B 收尾 + M2.C + M2.D）

| 角色 | 任务 |
| --- | --- |
| 后端 | B-21, B-22 |
| 前端 | F-23, F-24 |
| 运维 | O-18, O-19, O-20 |
| 集成 | D-25, D-26, D-27 |

---

## 验收 Gate

### M1 Gate（2026-05-07）

- [ ] P0-1 ~ P0-6 全部修复
- [ ] 所有改动已 merge 到 `master`
- [ ] 三角色联调清单全过
- [ ] 后端测试 ≥ 40 用例
- [ ] 前后端 build 通过
- [ ] OpenAPI 与契约文档一致

### M2 Gate（2026-05-21）

- [ ] 业务：密码重置、修改密码、系统配置、封禁解封全部上线
- [ ] CI：master PR 100% 走 CI
- [ ] 备份：每日自动跑 + 一次还原演练
- [ ] 监控：Sentry 接入 + 健康检查含 DB 探活 + 结构化日志
- [ ] 文档：runbook + 模块 README + 灰度上线报告
- [ ] 50 名内测用户完成首兑换，主链路成功率 ≥ 99%

---

**任务书结束**
