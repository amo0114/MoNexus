# architecture-guardrails：把隐性约定变成可执行的架构护栏

> 状态：Owner 已批准实施（2026-11-23）。基线：`origin/develop@e5ecd04` + 分支 `fix/inventory-count-and-order-tx`（`lib/inventoryCounts.ts`）。
> 格式参照 OpenSpec（proposal / design / specs / tasks）；存放路径按 Owner 指定为 `docs/specs/`。
> 业务硬约束以 [`AGENTS.md`](../../AGENTS.md) 为准，本计划不放宽其中任何一条。

---

## 1. Proposal

### 1.1 Why

2026-11-23 的 ARM 压测、生产只读核查与三轮系统评审（`docs/reviews/2026-11-08-system-review/`、`docs/reviews/2026-11-09-system-review/`、`docs/reviews/monexus-system-review/`）得出同一结论：当前规模下**不缺性能、不缺框架**，缺的是把"靠人记住的约定"变成 CI 会拦的规则。证据：

| 证据 | 说明 |
|---|---|
| 商品列表 11 req/s | Prisma 带 `where` 的关系 `_count` 生成全表 GROUP BY；靠 code review 无法发现 |
| `formatExpiryUnix` | `lib/fakaBridge/subscriptionResult.ts:104` 用宿主本地时间格式化买家可见的"当前到期"；生产容器不设 TZ（`server/Dockerfile:26`）→ 显示 UTC |
| R2-05 / SR-07 / SR-26 | 新后台子系统"零指标、零告警、零运营出口"跨评审出现 4–5 次 |
| 约 25 个 cron 复制同一段样板 | `running` 标志 + 租约 + `releaseForRetry` + `setInterval` + `unref`；无统一指标 |
| 模块依赖环 | 2026-11-10 记录为 10 个模块成环；2026-11-23 复算为 **21 个模块组成一个强连通分量**，另有 `payment ↔ recharge` |
| 路由挂载顺序 | `app.ts` 的承重顺序只由注释保护 |
| OpenAPI | 手写 `docs/superpowers/specs/monexus-api-openapi.json`（179 个路径）与实际响应之间无任何校验 |
| 进程拓扑 | `main.ts` 在 API 进程内启动约 25 个 cron/worker（含 ffmpeg 视频处理），无法单独隔离 |

### 1.2 What Changes

- **G1 静态规则**：在 `scripts/architecture-rules.mjs` 新增 AG-01…AG-05，由现有 `npm run check:architecture` / `npm run test:architecture` 执行。
- **G2 路由挂载顺序测试**：后端集成测试断言 `app.ts` 承重顺序。
- **G3 后台任务规范**：新增 `server/src/lib/leasedCron.ts`（租约 + 单批异常隔离 + 统一指标），新增通用告警 `MoNexusCronStale`；试点迁移 2 个 cron。
- **G4 进程角色**：新增 `PROCESS_ROLE=all|api|worker`（默认 `all`，行为不变）。
- **G5 接口契约校验**：后端测试辅助函数按 OpenAPI 校验真实响应，覆盖 6 个核心接口。
- 修复 AG-02 发现的 `formatExpiryUnix` 本地时区缺陷。

### 1.3 Out of Scope

- 拆解现有模块环（按 [`catalog-products-decoupling.plan.md`](catalog-products-decoupling.plan.md) 的后续顺序另行实施）；本计划只**冻结**现状不再扩大。
- 迁移其余 cron 到 `leasedCron`（本计划只做试点 + 规则准入）。
- 修改 `docker-compose.prod.yml`、CI 工作流、部署或生产环境（AGENTS.md §4/§5：需 Owner 针对本次授权）。G4 的 compose 拆分与容器资源上限作为 Owner 操作项列出。
- 前端从 OpenAPI 生成类型（需新增依赖 `openapi-typescript`，交 Owner 决定）。
- "越权返回 404 而非 403" 的静态规则：无法可靠区分归属校验与角色校验，不做。
- Express 5 升级、任务队列中间件、多副本/cluster。

### 1.4 触及的 AGENTS.md 硬约束

| 约束 | 影响 |
|---|---|
| 业务时间（businessTime） | AG-02 加强执行；修复 1 处违例 |
| cron/worker 安全 | AG-03 加强执行；`leasedCron` 内部仍走 `cronLease`，不改变租约语义 |
| 路由挂载顺序 | G2 加测试守护，不改顺序 |
| 资金/事务、幂等、404、锁序 | 不涉及 |

---

## 2. Design

### 2.1 G1 静态规则（`scripts/architecture-rules.mjs`）

扫描范围沿用 `check-architecture.mjs`：`server/src/**/*.ts(x)`，排除 `*.test.ts`、`*.spec.ts` 与 `__*` 目录。

| ID | 规则 | 判定 | 例外 |
|---|---|---|---|
| AG-01 | 禁止带过滤条件的关系计数 | 源码匹配 `_count: { select: { <rel>: { where` | 无；改用 `lib/inventoryCounts.ts` 或带 `IN` 的显式 `groupBy` |
| AG-02 | 禁止宿主本地时间 API | AST：调用 `getFullYear/getMonth/getDate/getDay/getHours` 及对应 `set*`、`getTimezoneOffset`、`toDateString`、`toTimeString`；`toLocaleString/toLocaleDateString/toLocaleTimeString` 的实参中**没有**含 `timeZone` 属性的对象字面量 | `lib/businessTime.ts` |
| AG-03 | 定时器准入 | 文件内出现 `setInterval(` 时，必须 import `lib/cronLease` 或 `lib/leasedCron`，或位于行级认领 worker 白名单 | 白名单 = 2026-11-23 现存 7 个文件（AGENTS.md §3 已认可的行级认领模式 + SSE 心跳），逐个注明原因；新增文件不得加入白名单而不经评审 |
| AG-04 | async 处理器必须把错误交给 `next` | `*ontroller*.ts` 中导出的 async 函数，每个 `await` 必须位于带 `catch` 的 `try` 块内或其 `catch` 子句内 | 无（基线 284 个处理器全部满足） |
| AG-05 | 模块依赖环棘轮 | 以 `server/src/modules/<name>` 为节点、静态运行时 import 为边求强连通分量；任何**不在基线里**的模块进入环、或出现新的环 → 失败 | 基线写在规则文件常量里；环缩小时更新基线（只减不增） |

AG-05 基线（2026-11-23 复算）：
- `{accountGovernance, adminAuthorization, adminExports, auth, catalog, checkout, fakaBridge, fulfillment, governance, invite, merchant, merchantFinance, merchantGovernance, orders, points, portable-backups, productVideos, trafficReset, valuePolicy, wallet, xboardAccounts}`
- `{payment, recharge}`

### 2.2 G2 路由挂载顺序测试

`server/src/__tests__/app-mount-order.test.ts` 读取 `app._router.stack`，按 router 对象身份取下标，断言：
1. `paymentWebhookRoutes`、`xboardBotRoutes` 在 `express.json()`（layer 名 `jsonParser`）之前（需要原始 body）；
2. `publicSponsoredRouter`、`publicEditorialRouter`、`shareLinkRoutes`、`productReviewRoutes` 在 `productRoutes` 之前（`/:id` 贪婪）；
3. `deliveryFileRoutes` 在 `uploadsRoutes` 之前（`/:key` 贪婪）；
4. `chatBindRoutes` 在 `pointRoutes` 之前、`orderReviewRoutes` 在 `orderRoutes` 之前；
5. `errorHandler` 是最后一层。

### 2.3 G3 后台任务规范（`server/src/lib/leasedCron.ts`）

```ts
defineLeasedCron({ name, intervalMs, run }) => { start(), stop(), tick() }
```

- 语义与现有样板逐行等价：`nodeEnv === 'test'` 不启动；立即首跑 + `setInterval` + `unref`；进程内 `running` 防重入；`acquireCronLeaseWithHeartbeat(name, intervalMs)`；成功 `release()`，失败 `releaseForRetry()`；异常只记日志、不抛出。
- 指标（`lib/metrics.ts`，注册到现有 `registry`）：
  - `monexus_cron_runs_total{job, outcome="success|failure|skipped"}`（skipped = 未拿到租约）
  - `monexus_cron_last_success_timestamp_seconds{job}`：`start()` 时初始化为进程启动时间，从未成功也能在 3 个周期后告警
  - `monexus_cron_interval_seconds{job}`
- 告警（追加到已挂载的 `docs/operations/background-alerts.rules.yml`，不改 compose）：
  `MoNexusCronStale`：`time() - max by (job) (monexus_cron_last_success_timestamp_seconds) > 3 * max by (job) (monexus_cron_interval_seconds)`，持续 10m。
- 试点：`traffic/cron.ts`（`traffic-aggregation`）、`recommendationEvents/cron.ts`（`recommendation-event-retention`）。租约名与周期不变。
- 不变量：租约名不变 → 多实例互斥与窗口节流不变；失败回拨语义不变；对外导出 `startXxxCron/stopXxxCron` 名称不变，`main.ts` 无需改动。

### 2.4 G4 进程角色

- `config/index.ts` 新增 `PROCESS_ROLE`（`all|api|worker`，默认 `all`），写入根目录与 `server/` 的 `.env.example`。
- `scripts/check-compose-env.mjs` 要求每个配置变量都透传给生产 `server` 容器，因此 `docker-compose.prod.yml` 增加一行 `PROCESS_ROLE: ${PROCESS_ROLE:-all}`（默认值保持现状，不拆分服务）。
- `main.ts`：
  - `all`：现状。
  - `api`：照常监听 HTTP、启动实时通知 LISTEN；**不**启动任何 cron/worker。
  - `worker`：照常监听 HTTP（仅供 `/api/health`、`/metrics` 与 Prometheus 抓取；nginx 不应把用户流量路由到它）；启动全部 cron/worker；不启动实时通知 LISTEN。
  - 关闭流程不变（各 `stop*` 对未启动的任务是 no-op）。
- Owner 操作项（不在本变更内）：compose 拆成 `server-api` + `server-worker` 两个容器；为 server/db 设置 `mem_reservation` / 内存上限。

### 2.5 G5 接口契约校验

- `server/src/__tests__/openapiContract.ts`：用已有依赖 `ajv@8` 加载 `docs/superpowers/specs/monexus-api-openapi.json`（OpenAPI 3.0.3，`nullable` 由 Ajv 原生支持），`expectOpenApiResponse(res, method, pathTemplate)` 按状态码取 `application/json` schema 校验 `res.body`。
- `server/src/__tests__/openapi-contract.test.ts` 覆盖：`GET /api/products`、`GET /api/products/{id}`、`GET /api/checkout/preview`、`POST /api/orders`、`GET /api/orders/{id}`、`GET /api/auth/me`。
- 发现文档与实现不一致时，按 AGENTS.md §1 **停止并报告 Owner**，不自行改动任一侧。

**实施结果（2026-11-23）**：`POST /api/orders`、`GET /api/orders/{id}` 与文档一致，已纳入测试。其余 4 个接口与文档不一致，**待 Owner 裁定**以哪一侧为准后再纳入：

| 接口 | 文档 → 实际 | 线索 |
|---|---|---|
| `GET /api/products` | 文档为数组；实际为分页对象 | 游标分页 |
| `GET /api/products/{id}` | 文档要求 `merchantId`、`createdAt`、`isHot`；实际不返回 | `isHot` 按 D-MERCH-01 有意移除 |
| `GET /api/checkout/preview` | 文档要求 `requiresProvisionEmailProof`；实际不返回 | — |
| `GET /api/auth/me` | 文档要求 `inviteCode`；实际不返回 | SPEC-INVITE-001 v2 删除常驻邀请码 |

---

## 3. Specs（ADDED Requirements）

### Requirement: Static architecture rules
`npm run check:architecture` MUST fail when a non-test file under `server/src` violates AG-01…AG-05, and each rule MUST have a positive and a negative case in `scripts/architecture-rules.test.mjs`.

#### Scenario: filtered relation count
- WHEN a service selects `_count: { select: { inventory: { where: { status: 'available' } } } }`
- THEN the check fails with an AG-01 message naming the file

#### Scenario: host-local date math
- WHEN server code calls `date.getHours()` or `toLocaleString('zh-CN')` without `timeZone`
- THEN the check fails with AG-02; `toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })` passes

#### Scenario: unleased interval
- WHEN a new module file calls `setInterval` without importing `lib/cronLease` or `lib/leasedCron`
- THEN the check fails with AG-03

#### Scenario: await outside try
- WHEN an exported async controller awaits outside a `try`/`catch`
- THEN the check fails with AG-04

#### Scenario: module joins a cycle
- WHEN a module outside the AG-05 baseline joins a runtime import cycle
- THEN the check fails with AG-05; a cycle that shrinks passes

### Requirement: Route mount order is tested
The backend test suite MUST fail when any load-bearing mount order in §2.2 is broken.

### Requirement: Leased cron contract
Crons defined through `defineLeasedCron` MUST keep lease name and period, MUST isolate failures to one tick, and MUST expose the three metrics in §2.3; `MoNexusCronStale` MUST be present in `background-alerts.rules.yml`.

### Requirement: Process role
With `PROCESS_ROLE` unset the server MUST behave exactly as before; `api` MUST start no cron/worker; `worker` MUST start all cron/workers and no realtime LISTEN.

### Requirement: OpenAPI response contract
The endpoints in §2.5 MUST validate against `monexus-api-openapi.json` in backend tests; an endpoint whose document and implementation disagree MUST be reported to the Owner and stays out of the test until resolved.

### Requirement: Business-time delivery labels
`formatExpiryUnix` MUST render Asia/Shanghai wall time regardless of host TZ.

---

## 4. 规则清单（速查）

| ID | 层 | 位置 | 失败信息前缀 |
|---|---|---|---|
| AG-01 | 静态 | `scripts/architecture-rules.mjs` | `AG-01 filtered relation _count` |
| AG-02 | 静态 | 同上 | `AG-02 host-local date API` |
| AG-03 | 静态 | 同上 | `AG-03 setInterval without cron lease` |
| AG-04 | 静态 | 同上 | `AG-04 await outside try/catch` |
| AG-05 | 静态 | 同上 | `AG-05 module dependency cycle grew` |
| AG-06 | 后端测试 | `server/src/__tests__/app-mount-order.test.ts` | — |
| AG-07 | 后端测试 + 告警 | `lib/leasedCron.ts`、`background-alerts.rules.yml` | `MoNexusCronStale` |
| AG-08 | 运行时配置 | `PROCESS_ROLE` | — |
| AG-09 | 后端测试 | `server/src/__tests__/openapi-contract.test.ts` | — |

---

## 5. Tasks

- [x] 1. 本计划文档
- [x] 2. AG-01…AG-04 规则与单测；修复 `formatExpiryUnix`（Shanghai）并补回归
- [x] 3. AG-05 模块环棘轮与单测
- [x] 4. AG-06 路由挂载顺序测试
- [x] 5. AG-07 `leasedCron` + 指标 + `MoNexusCronStale`；迁移 traffic、recommendationEvents 两个 cron
- [x] 6. AG-08 `PROCESS_ROLE`（config、`.env.example`、`main.ts`）
- [x] 7. AG-09 OpenAPI 契约测试（2 个接口已纳入；4 个漂移待 Owner 裁定，见 §2.5）
- [x] 8. 验证（每个任务各自提交前执行）：
  - `npm run test:architecture`、`npm run check:architecture`（node:test，静态层）
  - `npm --prefix server run build`（后端类型检查）
  - 后端集成测试（server 层，可丢弃测试库，`TZ=UTC`）：`faka-subscription-result.test.ts`、`app-mount-order.test.ts`、`leasedCron` 相关测试、`openapi-contract.test.ts`、受影响模块既有测试
  - 规则通过后在完整 `server/src` 上 `check:architecture` 必须为 0 失败

## 6. 验收标准

1. `check:architecture` 在当前代码上通过；对每条规则人为制造一次违例均失败（单测覆盖）。
2. 新增/修改的后端测试全部通过，`npm --prefix server run build` 通过。
3. `PROCESS_ROLE` 未设置时 `main.ts` 启动的任务集合与改动前一致。
4. 试点 cron 的租约名、周期、日志语义不变；三项指标在 `/metrics` 可见。
5. 所有发现的文档/实现不一致已报告 Owner，未被单方面"修正"。

## 7. Owner 操作项（本变更不执行）

- 裁定 §2.5 的 4 处 OpenAPI 漂移以哪一侧为准。
- 实施中由 AG-01/AG-02 发现并已修复：`admin/productAdmin.ts` 全表计数、`formatExpiryUnix` 本地时区（各自独立提交）。

- compose 拆分 `server-api` / `server-worker`，nginx 只指向 api。
- 为 monexus-server / monexus-db 设置内存预留与上限（生产机 40+ 容器共存、`RECHARGE_MODE=live`）。
- 是否引入 `openapi-typescript` 生成前端类型。
- 其余 cron 迁移到 `leasedCron` 的排期。
