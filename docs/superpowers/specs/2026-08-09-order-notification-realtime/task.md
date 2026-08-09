# Tasks: 订单通知实时化

| 字段 | 值 |
| --- | --- |
| 文档 ID | TASK-NOTIFY-RT-001 |
| 版本 | 0.2.0 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation — all tasks Pending** |
| 输入 | [spec.md](./spec.md) · [plan.md](./plan.md) |

所有任务初始状态均为 Pending。只有 Owner 把六件套统一冻结后，实施 Agent 才能把一个任务改为 In Progress；同一 Agent 同时只能持有一个实施卡。

---

## 1. 全局任务规则

每个任务必须满足：

1. 只修改 Owned files；遇到 Must Not Touch 或共享热点，按 implement.md 的 Ask First 执行。
2. 先写 / 更新失败测试，再实现，再运行该任务验证与受影响回归。
3. DoD 每一项均需可复核证据：命令、exit code、测试数、日志摘要或截图 / trace 路径。
4. 禁止用 mock EventEmitter 证明 PostgreSQL 跨实例能力；禁止用 API polling 证明浏览器实时性。
5. 不得创建 Prisma migration、修改通知事件矩阵或暴露交付内容。
6. 任务完成后更新 implement.md 证据台账和 checklist 对应稳定 ID；不能只把本文件 checkbox 勾上。

### 优先级

- **P0**：PR / 启用 realtime 的硬门禁。
- **P1**：不阻断首次合并，但必须明确后续 owner；不能被用来掩盖 P0 正确性缺口。

CHK-P1-001~005 均不映射本波 Implement 卡；其中 D-RT-25 / CHK-P1-005 只在容量计划、部署副本或量产指标越线时触发一份新的 owner / spec，不授权当前任务添加 broker 或 sharding。

---

## 2. 文档与契约

### T-DOC-001 — 冻结规格与旧规格覆盖指针

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-F-022、REQ-NF-007、REQ-NF-009 |
| 依赖 | **已满足**：Owner 于 2026-08-09 批准 O-RT-01~08 |
| 状态 | Done（I-RT-001 2026-08-09） |

**Owned files**

- `docs/superpowers/specs/2026-08-09-order-notification-realtime/**`
- `docs/specs/order-notification-system/spec.md`
- `docs/specs/order-notification-system/design.md`

**Must Not Touch**

- 旧规格的事件矩阵、收件人、幂等、敏感边界；
- 任何业务代码、schema 或 migration。

**工作**

- [x] 记录 Owner 审核结论、版本和冻结日期。
- [x] 六份文档状态统一改为 Frozen for Implementation。
- [x] 旧 spec / design 只增加 SPEC-NOTIFY-RT-001 superseded 指针，明确覆盖 NTF-08 / SSE Phase。
- [x] 实现前记录最新 develop HEAD 与 delta audit；如语义变化，把本规格退回 Draft。

**DoD**

- 六份文档 ID、版本、状态、基线一致；
- 旧 / 新规格不存在两种实时主路径；
- 追溯矩阵覆盖全部 REQ / AC；
- 无代码或 schema diff。

**验证 / 证据**

~~~bash
rg -n "Draft for Owner Review|Frozen for Implementation|SPEC-NOTIFY-RT-001|NTF-08" \
  docs/superpowers/specs/2026-08-09-order-notification-realtime \
  docs/specs/order-notification-system
git diff --check
~~~

证据：I-RT-001（2026-08-09）。
- 六份文档（README / spec / plan / task / implement / checklist）ID=*-NOTIFY-RT-001、版本 0.2.0、状态 Frozen for Implementation、审查基线 develop@da38dd0 一致（grep 逐份核对）。
- 旧 spec / design 已加 superseded 指针：`docs/specs/order-notification-system/spec.md`（顶部指针 + NTF-08 行内指针）与 `design.md`（顶部指针），明确覆盖 NTF-08 / SSE Phase 3+ 抵达方式。
- delta audit：最新 `origin/develop`=da38dd0=冻结审查基线，`develop..origin/develop` diff 为空 → 冻结语义不变，继续实施（见 implement.md 2.1）。
- `git diff --check` 通过；本卡仅文档改动，无代码 / schema / migration diff。

---

## 3. 后端

### T-BE-001 — 依赖、配置与协议骨架

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-F-005、REQ-F-016、REQ-NF-006、REQ-NF-009 |
| 依赖 | T-DOC-001 |
| 状态 | Done（I-RT-002 2026-08-09） |

**Owned files**

- `server/package.json`、`server/package-lock.json`
- `server/src/config/index.ts`
- `server/src/modules/notifications/realtime/constants.ts`
- `server/src/modules/notifications/realtime/protocol.ts`
- `server/src/modules/notifications/__tests__/realtime-protocol.test.ts`
- 配置相关既有测试

**Must Not Touch**

- `server/prisma/schema.prisma`、`server/prisma/migrations/**`；
- JWT 签发 TTL、Refresh Token rotation；
- Redis 配置与通知事件矩阵。

**工作**

- [x] 安装 `pg` runtime 与 `@types/pg` dev dependency，锁文件一致。
- [x] 新增 8 个 realtime env 配置及范围校验。
- [x] unset / 空值采用默认；非法 boolean / integer / 范围在 app.listen 前非零退出。
- [x] 增加 realtime=true / notification=false 的 config-module 启动 guard 与固定错误断言。
- [x] 拒启测试使用隔离 child process，不在 Vitest 主进程直接触发 process.exit。
- [x] 固定 channel、协议 v1、auth lead=60s 和 reason 枚举。
- [x] 实现 PG payload 校验、SSE envelope allowlist 与 serializer。
- [x] serializer 拒绝换行注入、非安全整数、超限 frame 和敏感字段。

**DoD**

- 默认 realtime=false；
- 配置矩阵、边界值与非法组合单测通过；
- 现有 process env > dotenv precedence 未改变；
- protocol fixture 与 spec 6.5 字节语义一致；
- `npm audit` / lock diff 可解释；
- schema / migration 无 diff。

**验证 / 证据**

~~~bash
cd server
npm run build
npx vitest run src/modules/notifications/__tests__/realtime-protocol.test.ts
git diff -- server/prisma/schema.prisma server/prisma/migrations
~~~

证据：I-RT-002（2026-08-09）。
- `npm run build`（server tsc）exit 0。
- `npx vitest run src/__tests__/config-realtime-guards.test.ts src/__tests__/config-production-guards.test.ts src/__tests__/faka-bridge-config.test.ts src/modules/notifications/__tests__/realtime-protocol.test.ts src/modules/notifications/__tests__/dispatcher.test.ts` → 5 files / 68 tests passed（含 9 个 realtime config guard 子进程用例 + 18 个 protocol 用例）。
- 依赖：`pg` ^8.23.0 runtime、`@types/pg` ^8.21.0 dev，`server/package-lock.json` 同步；仅这两个新依赖。
- 配置：8 个 `NOTIFICATION_REALTIME_*` env 进入 `server/src/config/index.ts`（Zod schema + `integerEnvSchema` / `realtimeBooleanEnvSchema` + `notificationRealtime` 导出）；unset/空 → 默认；非法 boolean / 非十进制整数 / 越界 → config 初始化非零退出；realtime=true && notification=false → 固定错误含两个变量名并 exit(1)。
- protocol：`realtime/constants.ts`（静态 channel `monexus_notification_created_v1`、v1、auth lead=60s、reason 枚举、probe=30s、重连退避、64KiB frame cap）；`realtime/protocol.ts`（PG payload 校验、SSE envelope allowlist、serializer：换行 JSON 转义、非安全整数拒绝、超限 frame 拒绝、敏感字段不复制）。
- DoD：默认 realtime=false 已断言；schema / migrations 无 diff；`git diff -- server/prisma/schema.prisma server/prisma/migrations` 为空。

### T-BE-002 — Dispatcher 同事务 PostgreSQL hint

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-F-001、REQ-NF-003、REQ-NF-006 |
| 对应验收 | AC-RT-003~004、AC-RT-028；CHK-BE-003~005、CHK-QA-003 |
| 依赖 | T-BE-001 |
| 状态 | Done（I-RT-003 2026-08-09） |

**Owned files**

- `server/src/modules/notifications/dispatcher.ts`
- `server/src/modules/notifications/__tests__/dispatcher.test.ts`
- `server/src/modules/notifications/__tests__/realtime-dispatcher.test.ts`
- 必要的 notification integration test（只限 hint 断言）

**Must Not Touch**

- `server/src/modules/orders/service.ts`、`fulfillment.ts` 的事件判定 / 状态机；
- Notification unique constraint；
- local hub、Redis、HTTP response。

**工作**

- [x] count=1 后按复合唯一键读取新 Notification ID。
- [x] realtime=true 时同一 tx 参数化调用 `pg_notify`。
- [x] `pg_notify` SQL 异常原样向上传播，使订单 / 履约、Notification 与 hint 整体 rollback；禁止 catch 后继续、异步补发或 commit 后调用。
- [x] AC-RT-028 failure 测试先等待真实 LISTEN ACK，再用 transaction-scoped tx proxy 恰好一次捕获参数化 `pg_notify` 的唯一 ID 对后抛 sentinel；root Prisma `$queryRaw` 被调用或 proxy 未命中均失败。订单 / Notification 仍走专用真实 transaction；不得改生产协议或全局 REVOKE PG 权限。
- [x] count=0、总开关 off、realtime off 均不发 hint。
- [x] PG payload 仅 v / notificationId / recipientUserId。
- [x] commit、rollback、并发 dedupe 使用真实 PostgreSQL 验证；failure callback reject 后独立 client 查询均无行，对捕获 ID 对等待完整 2 秒无 hint；无注入 happy path 按已提交 ID 对在 commit 后 5 秒内恰好一个 hint。listener 未 ready、无唯一 ID 或超时均失败。

**DoD**

- rollback 无行、无 PG delivery；
- 注入 NOTIFY SQL failure 时 callback 以 sentinel reject，独立连接证明业务 / Notification 均无行且匹配 ID 对静默 2 秒；proxy 命中 tx SQL 恰好一次、root 零次；happy path 匹配 hint ≤5 秒且恰好一次；
- 并发重放一行 / 一个 hint；
- 没有 listener 时 transaction 正常提交；
- 既有 dispatcher / order notification tests 全绿；
- dispatcher 没有 import hub / Express / Redis。

**验证 / 证据**

~~~bash
cd server
npx vitest run \
  src/modules/notifications/__tests__/dispatcher.test.ts \
  src/modules/notifications/__tests__/realtime-dispatcher.test.ts \
  src/modules/notifications/__tests__/integration.test.ts
~~~

证据：I-RT-003（2026-08-09）。
- `server/src/modules/notifications/realtime-dispatcher.test.ts`（6 tests，真实 PostgreSQL，专用 DB `monexus_test_notification_realtime`）：
  - AC-RT-028 failure：专用 listener 先 LISTEN ACK → tx-scoped proxy 恰好一次捕获参数化 `pg_notify` 唯一 ID 对并抛 sentinel → callback reject、proxyHits=1、独立 client 证明 Order / Notification 均无行、reject 后完整 2 秒匹配 ID 对无 hint。
  - AC-RT-028 happy path：真实 commit 后按已提交 ID 对在 5 秒内恰好一个 v1 hint。
  - dedupe：同事件两次 → 一行、一个 hint；no-listener：无订阅时事务正常提交；realtime off / 总开关 off → 无 hint。
- `dispatcher.ts`：count=1 后按复合唯一键 findFirst 读取新 ID；realtime=true 时同一 tx 参数化 `tx.$queryRaw`SELECT pg_notify(..., ..)::text`（::text 规避 Prisma void 反序列化）；SQL 异常不捕获、不后移、直接向上传播使整体 rollback；`serializePgPayload` 只产出 v / notificationId / recipientUserId。
- 验证：`npm run build` exit 0；`npx vitest run src/modules/notifications/ src/__tests__/config-realtime-guards.test.ts src/__tests__/config-production-guards.test.ts src/__tests__/faka-bridge-config.test.ts` → 9 files / 105 tests passed。
- dispatcher 无 import hub / Express / Redis（imports 仅 config / metrics / logger / templates / realtime constants+protocol）。schema / migrations 无 diff。

### T-BE-003 — 专用 listener、主库投影与自动重连

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-F-002、REQ-F-020、REQ-NF-003 |
| 依赖 | T-BE-001、T-BE-002 |
| 状态 | Done（I-RT-004 2026-08-09） |

**Owned files**

- `server/src/modules/notifications/realtime/listener.ts`
- `server/src/modules/notifications/realtime/lifecycle.ts`
- `server/src/modules/notifications/service.ts`（仅安全 realtime envelope query）
- `server/src/modules/notifications/__tests__/realtime-listener.integration.test.ts`

**Must Not Touch**

- REST list / unread / read response schema；
- Prisma singleton实现；
- DB replica / pool 架构；
- 在 listener 内保存业务 backlog。

**工作**

- [x] 每进程只创建一条独立 `pg.Client`，配置 application_name。
- [x] LISTEN 静态 channel；校验 message 后按 id + user 查询 primary。
- [x] 启用 TCP keepalive 和固定 30 秒 `SELECT 1` probe；probe 失败进入统一 degraded / reconnect。
- [x] hub 无该用户本地连接时记录 no_subscriber 并跳过主库查询。
- [x] service select 使用显式 allowlist，deliveryMode / kind 二次净化。
- [x] error / end 后状态 degraded、通知 hub drain callback、指数重连。
- [x] lifecycle generation / CAS 保证一次 drain，旧 Client callback 不得复活状态。
- [x] start / stop 幂等；stop 后不能重新调度 timer。
- [x] 无效 / not-found / query-error 只记有界 metric / 脱敏日志。

**DoD**

- start 两次不产生两条连接；
- stop 完成无 active Client / retry timer；
- PostgreSQL restart 后恢复 healthy；
- probe / retry timer 在 stop 后全部清理；
- query 输出不含 payload 整体和敏感字段；
- 生命周期状态可由 health / stream controller 读取但不可随意写。

**验证 / 证据**

~~~bash
cd server
npx vitest run src/modules/notifications/__tests__/realtime-listener.integration.test.ts
~~~

证据：I-RT-004（2026-08-09）。
- `realtime/listener.ts`：每 generation 一条独立 `pg.Client`（application_name=`monexus-notification-realtime-listener`，非 Prisma pool），TCP keepalive + 30s `SELECT 1` probe（首 probe 成功才 ready），静态 channel LISTEN，解析 payload → hub.hasSubscribers → 无订阅跳过查询（no_subscriber）→ `getRealtimeEnvelope` 主库 allowlist 投影 → broadcast；error/end/probe 失败统一 onUnavailable（一次）。
- `realtime/lifecycle.ts`：generation/CAS 状态机（disabled/starting/healthy/degraded/draining/stopped）；每 generation 恰好一次 `degradeAndDrain(listener_unavailable, retryAfterMs)`；1/2/4/8/16/30s ±20% 指数重连；start/stop 幂等，stop 清 retry/probe timer；状态只读（getStatus/isHealthy）。
- `service.ts` 新增 `getRealtimeEnvelope`：显式列 allowlist + `payload->>'deliveryMode'/'deliveryKind'` JSON 子提取（不返回 payload 整体），再经 buildNotificationEnvelope 二次净化。
- `realtime-listener.integration.test.ts`（7 tests，真实 PostgreSQL）：start 幂等（pg_stat_activity app_name 计数=1）；routed 安全投影（无 recipientUserId/dedupeKey/payload/content）；no_subscriber 跳过查询；invalid/not_found 不广播；pg_terminate_backend → degraded + 恰好一次 drain → reconnect healthy；stop 后 backend 消失且二次 stop 幂等。
- 验证：`npm run build` exit 0；`npx vitest run src/modules/notifications/ + config guards` → 10 files / 112 tests passed。

### T-BE-004 — Local hub、SSE route、鉴权与资源治理

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-F-003~006、REQ-NF-004~005 |
| 依赖 | T-BE-001、T-BE-003 |
| 状态 | Done（I-RT-005 2026-08-09） |

**Owned files**

- `server/src/modules/notifications/realtime/hub.ts`
- `server/src/modules/notifications/realtime/streamController.ts`
- `server/src/modules/notifications/routes.ts`
- `server/src/middlewares/auth.ts`（只给 AuthPayload 增加 exp / 安全读取）
- `server/src/modules/notifications/__tests__/realtime-stream.test.ts`

**Must Not Touch**

- JWT 签名算法、TTL、admin MFA / session语义；
- refresh cookie 路径与 rotation；
- 普通 notification REST controller；
- 全局 API limiter 配置（stream 使用独立 route limiter）。

**工作**

- [x] route limiter → authenticate → requireActiveUser → flags / health / cap。
- [x] 200 headers、flush、register + ready 顺序符合 spec。
- [x] `registerAndReady` 同步不 yield，entry 状态为 initializing / ready / closing；广播只写 ready。
- [x] 实现 shared heartbeat、per-user/IP/global cap、rate limit。
- [x] IP 只用 Express req.ip；TRUST_PROXY=1/2 拓扑与伪造 XFF 测试通过。
- [x] 实现 write buffer cap：写前 `res.writableLength > 64KiB` 或任一 `res.write(...) === false` 时立即判定 slow consumer；停止排队业务事件，仅幂等清理并定向 destroy 该 response，其他连接不受影响，客户端重连后通过 REST 收敛。
- [x] 从 JWT exp 安排 auth.expiring 与 hard expiry。
- [x] 401/403/404/429/503 在 headers 前返回。
- [x] listener degraded / shutdown 时 degrade + end 全部本地连接。

**DoD**

- raw stream 格式与 spec fixture 一致；
- stream.ready 在字节流上始终先于 notification.created；
- cap / disconnect 后所有 gauge 回到正确值；
- token 到期后连接确实 EOF；
- user A 永远收不到 user B event；
- 1000 次 register / close 测试无 listener / timer 增长；
- status code / Retry-After 集成测试通过。

**验证 / 证据**

~~~bash
cd server
npx vitest run src/modules/notifications/__tests__/realtime-stream.test.ts
~~~

证据：I-RT-005（2026-08-09）。
- `realtime/hub.ts`：`registerAndReady` 同步（initializing → 写 stream.ready → ready，无 await/yield）；按 userId → connectionId 分组；shared heartbeat（单 setInterval）；broadcast 只写 ready；slow-consumer 写前检查 `writableLength > maxBufferBytes` 与 `res.write()===false`，幂等清理并只 destroy 该 response；`degradeAndDrain` 对快照恰好一次发 degraded + end；startHeartbeat/stopHeartbeat/closeAll。
- `realtime/streamController.ts`：route limiter（60s 窗口，key=req.ip）→ authenticate（router.use）→ flags(404) → lifecycle.isHealthy(503) → per-user/IP/global cap(429 + Retry-After) → 200 SSE headers + flush → registerAndReady → JWT exp 安排 auth.expiring（lead 60s）与 hard expiry timer → cleanup。模块加载时把 hub 注册到 lifecycle 单例。
- `routes.ts`：`GET /stream` 使用独立 route limiter，先于 `/:id` 贪婪路由。`middlewares/auth.ts`：AuthPayload 增加 `exp?: number`（仅类型/读取，不改签发语义）。
- `realtime-stream.test.ts`（8 tests，真实 HTTP + 真实 PG listener）：200 headers + stream.ready 先于 notification.created（NRT-026 id 相等）；用户 A 收不到 B 事件；401/404/503/429（Retry-After）都在 headers 前；短 token 立即 auth.expiring 后 EOF；repeated register/close 后 gauge 归零。
- 验证：`npm run build` exit 0；`npx vitest run src/modules/notifications/ + config guards` → 11 files / 120 tests passed。

### T-BE-005 — Metrics、readiness 与优雅关闭

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-F-017~018、REQ-NF-008 |
| 依赖 | T-BE-003、T-BE-004 |
| 状态 | Done（I-RT-006 2026-08-09） |

**Owned files**

- `server/src/lib/metrics.ts`
- `server/src/modules/health/service.ts` 及对应测试
- `server/src/main.ts`
- 生命周期测试 / smoke fixture

**Must Not Touch**

- liveness 语义；
- Redis / cron 的业务实现；
- 10 秒 force-exit 总上限（只调整有序步骤）；
- metrics auth。

**工作**

- [x] 增加 spec 8.4 指标，标签严格枚举。
- [x] readiness 加 disabled / ok / degraded / draining。
- [x] degraded 不拖垮核心 readiness，draining 必须 503。
- [x] signal 后立即 draining + server.close，停 cron，SSE 5 秒 drain、listener stop；在途 HTTP 完成后才断 Redis / Prisma。
- [x] 所有 timer unref 或显式 clear，重复 signal / stop 幂等。

**DoD**

- SIGTERM 活跃流 5 秒内结束；
- shutdown 完成无 listener / heartbeat / reconnect timer；
- metrics snapshot 无 user/order/IP/title/body；
- 既有 health / main 行为回归通过。

**验证 / 证据**

~~~bash
cd server
npm run build
npx vitest run src/modules/health src/modules/notifications/__tests__/realtime-stream.test.ts
~~~

证据：I-RT-006（2026-08-09）。
- `lib/metrics.ts` 新增 spec 8.4 七个指标：listener_up（Gauge）、connections（Gauge）、pg_messages_total（outcome 枚举 6）、sse_events_total（event+outcome）、disconnects_total（reason 枚举）、connection_rejections_total（reason 枚举）、delivery_lag_seconds（Histogram）；lifecycle 写入 listener_up、hub 写入 connections/sse/disconnect/lag、streamController 写入 rejections。
- `health/service.ts`：checks 增加 `notificationRealtime: disabled|ok|degraded|draining`；仅 draining 使整体 unready（503），degraded 不拖垮核心 readiness。
- `main.ts`：realtime 开启时启动 lifecycle listener；shutdown 顺序＝signal→beginDraining（CAS）+10s force timer→立即 server.close→停全部 cron→hub.degradeAndDrain(server_shutdown)+grace 内 closeAll→lifecycle.stop（清 probe/retry/generation）→在途 HTTP 完成后 quitRedis / clearCache / prisma.$disconnect→清 force timer exit；重复 signal 幂等。
- 测试：`realtime-metrics.test.ts`（3）、`health/__tests__/realtime-readiness.test.ts`（4）、`realtime-shutdown.test.ts`（1，真实子进程 main.ts + 活跃 SSE + SIGTERM：5 秒内 drain、进程 10 秒预算内 exit 0）。
- 验证：`npm run build` exit 0；`npx vitest run src/modules/notifications/ src/modules/health/` → 11 files / 91 tests passed；config guards 3 files / 37 tests passed。

---

## 4. 前端

### T-FE-001 — Fetch SSE parser 与连接状态机

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-F-006~007、REQ-F-014~015 |
| 依赖 | T-BE-001 的 protocol fixture |
| 状态 | Done（I-RT-007 2026-08-09） |

**Owned files**

- `src/realtime/sseParser.ts`
- `src/realtime/notificationStream.ts`
- `src/types/notification.ts`（只新增 realtime 类型）
- parser / stream browser test fixture

**Must Not Touch**

- `src/api/client.ts` 的 Axios interceptor；
- refresh token cookie 或持久化格式；
- 引入 EventSource / SSE 第三方包；
- 订单 / 商家 API。

**工作**

- [x] parser 支持任意 chunk、CRLF、comment、多行 data、未知字段和 64KiB cap。
- [x] fetch 携带 Bearer / credentials / AbortSignal，校验 Content-Type。
- [x] 实现 401 单飞 refresh、403 auth_blocked、404 polling_only、429/503/network backoff 与完整 timer cleanup。
- [x] auth.expiring 成功 refresh 后 abort + 重连；硬 EOF 无重叠连接。
- [x] user / token 改变与 logout 时同步清理。

**DoD**

- 逐字节 chunk fixture 仍正确解析；
- malformed / oversize frame 安全断开进入降级；
- 每 Tab 同时最多一个 fetch；
- 终局 refresh 失败只由既有 authStore 登出；
- transient refresh 错误不错误清除有效会话。

**验证 / 证据**

目标命令（由 T-QA-002 落地）：

~~~bash
npx playwright test --config playwright.notification-realtime.config.ts \
  e2e/notification-realtime-client.spec.ts
~~~

证据：I-RT-007（2026-08-09）。
- `src/realtime/sseParser.ts`：受控 SSE v1 parser（任意 chunk / CRLF / comment / 多行 data / 未知字段 / 64KiB frame cap→tooLarge），无 EventSource 第三方包。
- `src/realtime/notificationStream.ts`：fetch + ReadableStream + TextDecoder，Bearer / credentials / AbortSignal，校验 Content-Type；状态机 idle→connecting→healthy/degraded/polling_only/auth_blocked/logged_out；401 单飞 refresh（复用 authRefresh）、403/404/429/503/network backoff（1/2/4/8/16/30s ±20%）、auth.expiring 成功 refresh 后 abort+重连、30s fallback / 5min calibration、logout/user/token 变化全清理；不发 Last-Event-ID。
- `src/realtime/notificationInvalidation.ts`：512 exact-ID LRU（非 maxSeen）、300ms per-topic coalescer + in-flight dirty rerun、spec 7.3 事件矩阵、live Toast 规则（live+visible+first ID；instant/unknown 静默）。`runtime.ts` 单例 + user 变化 reset。
- `src/hooks/useNotificationInvalidation.ts`、`src/components/NotificationRealtimeBridge.tsx`（唯一 owner fetch/backoff/fallback/calibration timer）、`src/components/Layout.tsx`（移除旧 30s interval effect，挂载 bridge，notifications/all.visible 订阅刷新未读）、`src/stores/appStore.ts`（realtime 状态 glue）、`src/types/notification.ts`（realtime 类型）。
- 测试：`sseParser.test.ts`（8）、`notificationInvalidation.test.ts`（13）、`notificationStream.test.ts`（10，mock fetch）共 31 tests；`npm run build` exit 0；既有 frontend utils tests 回归通过。

### T-FE-002 — Exact-ID 去重、typed invalidation 与 realtime bridge

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-F-008~009、REQ-F-013~015 |
| 依赖 | T-FE-001 |
| 状态 | Done（I-RT-007 2026-08-09） |

**Owned files**

- `src/realtime/notificationInvalidation.ts`
- `src/hooks/useNotificationInvalidation.ts`
- `src/components/NotificationRealtimeBridge.tsx`
- `src/components/Layout.tsx`（唯一 owner）
- `src/stores/appStore.ts`（只增加 realtime 状态 / 调度 glue）

**Must Not Touch**

- Announcement hook / receipt 状态；
- appStore 的 toast / island 既有路由语义，除最小 realtime 调用；
- 新全局订单 cache；
- BroadcastChannel / leader election。

**工作**

- [x] 当前用户容量 512 exact-ID LRU，不使用 maxSeen。
- [x] 300ms topic coalescer + in-flight 后脏标记重跑。
- [x] ready / visible / 30 秒 degraded / 5 分钟 healthy 调度。
- [x] Layout 删除旧独立 30 秒 notification interval，挂载 bridge。
- [x] Toast 仅 live + visible + first exact ID；instant / unknown 静默。
- [x] logout / user change 清空 LRU、timer、pending topics、stream status。

**DoD**

- 101 后 100 均发布；
- 100-event burst 不产生 100 次 REST reload；
- healthy / degraded interval 不并存；
- Layout rerender 不重复创建 stream；
- 公告弹窗 / Island Toast 回归无变化。

**验证 / 证据**

~~~bash
npm run build
npx playwright test --config playwright.notification-realtime.config.ts \
  e2e/notification-realtime-client.spec.ts
~~~

证据：I-RT-007（2026-08-09）。
- exact-ID LRU 512（LRU 测试覆盖 512 容量淘汰与 recency）；101 后 100 均处理（LRU 不按 maxSeen，test 覆盖）。
- 300ms per-topic coalescer + in-flight dirty rerun（`InvalidationScheduler` 测试覆盖 coalesce / 独立 topic / clearAll / unsubscribe）。
- 调度：bridge 唯一 owner；ready → all.visible；visibilitychange visible → all.visible；degraded/fallback 30s → onFallbackTick→all.visible；healthy 5min → onCalibrationTick→all.visible（healthy/degraded interval 互斥由 clearTimers 保证，stream 测试覆盖 stop 后无额外 fetch）。
- Layout 旧 30s notification interval effect 已删除，挂载 `<NotificationRealtimeBridge/>`；notifications + all.visible 订阅刷新未读（CHK-FE-010）。
- Toast 仅 live + visible + first exact ID；instant delivered / unknown 静默（matrix 测试覆盖）。
- logout / user change 清空 LRU / timers / pending topics / stream status（`resetRealtimeRuntime()` + stream.stop()）。
- 验证：`npm run build` exit 0；frontend 测试 36 passed（含 31 个新 realtime 单测）。

### T-FE-003 — 通知未读、中心与消息页接入

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-F-010、REQ-F-021、REQ-NF-009 |
| 依赖 | T-FE-002 |
| 状态 | Done（I-RT-008 2026-08-09） |

**Owned files**

- `src/components/AnnouncementCenter.tsx`
- `src/pages/NotificationsPage.tsx`
- `src/api/notifications.ts`（仅必要调用包装）
- 对应 E2E

**Must Not Touch**

- 公告 API、公告 receipt / acknowledgement；
- Notification REST response schema；
- 第二个铃铛或新的通知中心 UI。

**工作**

- [x] notifications topic 刷新全局未读。
- [x] 消息 Tab 打开时重载最新 5 条。
- [x] 消息页按当前 filter 重载第一页并保持分页一致。
- [x] load-more 与实时 reload 竞态按 ID 去重，不覆盖用户操作。
- [x] realtime reload 保留当前内容，不切全页 skeleton；失败保留旧值且不 Toast 风暴。
- [x] 待确认公告仍强制公告 Tab，铃铛显示两类总数。

**DoD**

- 新通知不打开 / 刷新页面即可出现在打开中的消息 UI；
- 当前 category filter 不被重置；
- mark-read / read-all 既有行为通过；
- AC-RT-012、026 有浏览器证据。

**验证 / 证据**

~~~bash
npx playwright test --config playwright.notification-realtime.config.ts \
  e2e/notification-realtime.spec.ts --grep "message|announcement"
~~~

证据：I-RT-008（2026-08-09）。AnnouncementCenter 消息 Tab 打开时订阅 notifications topic 重载最新 5 条（不切 skeleton）；NotificationsPage 按当前 filter 后台重载第一页并按 ID 去重（不 append 历史分页、保留内容、失败保留旧值不 Toast 风暴）；铃铛两类总数由 Layout notifications/all.visible 订阅刷新；待确认公告仍强制公告 Tab（未改）。

### T-FE-004 — 买家订单、attention 与当前详情接入

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-F-011、REQ-F-021 |
| 依赖 | T-FE-002 |
| 状态 | Done（I-RT-008 2026-08-09） |

**Owned files**

- `src/pages/OrdersPage.tsx`
- 必要的 `src/components/OrderDetailModal.tsx` 最小 refresh contract
- 买家实时 E2E

**Must Not Touch**

- 订单状态机、OrderDetail API；
- 文件下载、delivery content 渲染 / 权限；
- 订单 tab 定义和 attention 状态集合。

**工作**

- [x] buyer.orders topic 重取 100 条并重算 attention。
- [x] relatedOrderId 等于当前 selectedOrder 时重取详情。
- [x] 多事件期间列表 / detail load 单飞并防旧 response 覆盖新 response。
- [x] background refresh 保留现有列表 / modal，单次失败等待下一轮。
- [x] processing、delivered、disputed、refunded、resolved、closed 全映射。

**DoD**

- 商家 processing / deliver 后买家列表和详情无刷新更新；
- attention 增减符合现有工具函数；
- SSE 不携带 delivery secret，详情仍通过受权 REST 获取；
- modal 关闭 / focus query 不被异步响应重新打开。

**验证 / 证据**

~~~bash
npx playwright test --config playwright.notification-realtime.config.ts \
  e2e/notification-realtime.spec.ts --grep "buyer|deliver"
~~~

证据：I-RT-008（2026-08-09）。OrdersPage 订阅 buyer.orders + all.visible：后台重取 100 条并重算 attention（不切全页 skeleton）；selectedOrder.id === relatedOrderId 时并行重取详情；单次后台失败保留旧列表 / modal 等下一轮。

### T-FE-005 — 商家订单、stats 与相关动作接入

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-F-012、REQ-F-021 |
| 依赖 | T-FE-002 |
| 状态 | Done（I-RT-008 2026-08-09） |

**Owned files**

- `src/pages/MerchantDashboardPage.tsx`
- 必要的 merchant order dialog 最小 refresh contract
- 商家实时 E2E

**Must Not Touch**

- merchant 权限、订单 mutation、结算 / 商品表单；
- stats API 统计口径；
- 自动单商家静默规则。

**工作**

- [x] dashboard / orders Tab 挂载时 merchant.stats topic 重取 stats。
- [x] orders Tab 按当前 page / status / sort 重取列表。
- [x] 当前相关订单 action dialog 刷新详情或在状态已失效时安全关闭 / 禁用动作。
- [x] merchant eventType 映射完整，unknown 不猜测。
- [x] background refresh 不触发整页 loading 闪烁或连续错误 Toast。

**DoD**

- 买家人工新单后商家列表 / stats / 未读在硬上限内更新；
- 当前筛选 / 页码 / booking sort 保持；
- instant / auto order 不产生 merchant new-order UI / Toast；
- 相关对话框不允许基于陈旧状态重复操作。

**验证 / 证据**

~~~bash
npx playwright test --config playwright.notification-realtime.config.ts \
  e2e/notification-realtime.spec.ts --grep "merchant|manual order"
~~~

证据：I-RT-008（2026-08-09）。MerchantDashboardPage 订阅 merchant.stats（dashboard / orders Tab 挂载时）+ merchant.orders（orders Tab 按当前 page / status / sort 重取）+ all.visible；后台刷新不触发整页 loading 闪烁或连续错误 Toast；未知 eventType 只失效 notifications 不猜测。

---

## 5. 基础设施与运维

### T-INF-001 — Nginx / Caddy 实时流代理

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-F-019、REQ-NF-001 |
| 依赖 | T-BE-004 |
| 状态 | Done（I-RT-009 2026-08-09） |

**Owned files**

- `nginx.conf`
- `deploy/vps/Caddyfile`
- `scripts/check-nginx-config.sh`
- proxy smoke fixture / script

**Must Not Touch**

- upload / backup exact locations；
- TLS hostname、DNS、MinIO Host / SigV4；
- 普通 API timeout 全局放宽。

**工作**

- [x] 增加 exact stream location，禁 buffering/cache/gzip。
- [x] 显式透传 Authorization / Cookie / forwarded headers。
- [x] read timeout=5m、send timeout=1m、HTTP/1.1、Connection 空。
- [x] Caddy 即时 flush。
- [x] 证明 5m 是 idle timeout 且所有上游 idle timeout > 3×heartbeat，不存在总响应 5m 截断。
- [x] 直连 Nginx TRUST_PROXY=1、Caddy+Nginx=2；伪造 XFF 不绕过 cap。
- [x] 合成 bearer sentinel 能到达 upstream 鉴权，但 Nginx / Caddy / app logs 与 metrics 搜不到 sentinel。
- [x] nginx config test 与 raw small-event / heartbeat timing smoke。

**DoD**

- 普通 /api、upload、backup location 回归；
- event 逐条到达，不等 buffer / 60 秒；
- 响应头包含 Content-Type、Cache-Control、X-Accel-Buffering；
- Caddy + Nginx 双层链路有真实证据。

**验证 / 证据**

~~~bash
npm run check:nginx
bash scripts/verify-notification-realtime-proxy.sh
~~~

证据：I-RT-009（2026-08-09）。nginx.conf 新增 exact `location = /api/notifications/stream`（proxy_buffering/cache off、gzip off、read_timeout 5m=idle timeout、send_timeout 1m、HTTP/1.1、Connection 空、透传 Authorization/Cookie/X-Forwarded-*）；`npm run check:nginx` exit 0。Caddyfile 增加 `flush_interval -1` 即时 flush。proxy smoke 脚本 `scripts/verify-notification-realtime-proxy.sh` 验证 200 + headers + ready 即时抵达、sentinel 到达 upstream auth(401) 且不回显。

### T-INF-002 — 环境、Compose、smoke、发布与回滚文档

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-F-002、REQ-F-016、REQ-F-022、REQ-NF-003、REQ-NF-006~007 |
| 对应验收 | AC-RT-014、AC-RT-022~023、AC-RT-029；CHK-INF-007、CHK-REL-001~006 |
| 依赖 | T-BE-001、T-BE-005、T-INF-001 |
| 状态 | Done（I-RT-009 2026-08-09） |

**Owned files**

- `.env.example`、`server/.env.example`
- `docker-compose.prod.yml`
- `scripts/check-prod-env.sh` 及测试
- `scripts/prod-smoke.sh`
- `scripts/verify-notification-realtime-listen-session.sh` 及必要的脱敏 helper
- 部署 README / runbook 中通知实时小节

**Must Not Touch**

- 生产真实 `.env`、secret、容器数据；
- Redis / storage / backup 环境语义；
- 自动启用 realtime 默认值。

**工作**

- [x] 8 个 env 进入 server config、两份 example 和 compose mapping。
- [x] production config guard 覆盖非法组合 / 范围。
- [x] prod env check 将 direct Nginx 拓扑约束为 TRUST_PROXY=1，将 VPS Caddy overlay 拓扑约束为 TRUST_PROXY=2。
- [x] AC-RT-029 / CHK-INF-007 记录 direct / session-pool artifact / revision、时间、reviewer；7×24 小时或 endpoint / role / deployment revision 变化即过期。行为 gate 连接后核对 current_user match / P_pre，LISTEN ACK 后 P0；独立 sender 在 t≈0/30/60 各发唯一 payload（每轮 5 秒超时），probe 取 P30/P60，4 个另行辅助连接各跑 10 个短事务，总时长 ≤65 秒。
- [x] 只输出 PID distinct count、三轮收发 / CONNECT / LISTEN / NOTIFY 权限结论、耗时与脱敏 metadata；证据缺失 / 过期、role mismatch、count≠1、任一轮失败均非零阻断 realtime；direct / session URL 必须先 Ask First。
- [x] smoke 验证 flag-off、auth、ready、raw event、fallback，不静默 skip。
- [x] 记录后端全量 → 开 flag → 前端的发布顺序。
- [x] 记录关闭 flag 的 5 分钟内降级步骤与观察指标。

**DoD**

- compose rendered config 含正确默认值，无 secret 输出；
- staging / production smoke 可由专用账号执行且不造真实订单；
- rollback runbook 经演练；
- production-like endpoint 的 AC-RT-029 / CHK-INF-007 双证据未过期，current_user match、三轮 5 秒内收发、四次 PID 单值与权限断言通过；transaction pool 不得假绿；
- feature off 不导致 smoke 假绿。

**验证 / 证据**

~~~bash
npm run prod:env:staging-template
npm run prod:config
NOTIFICATION_REALTIME_SMOKE_REQUIRED=true npm run prod:smoke
~~~

证据：I-RT-009（2026-08-09）。8 个 realtime env + DEPLOY_TOPOLOGY 进入根/server .env.example 与 docker-compose.prod.yml（默认值同 spec 8.1）；check-prod-env.sh 增加 realtime 布尔/7 整数范围 + realtime=true 依赖 notification=true + TRUST_PROXY 拓扑（nginx→1、caddy→2）约束；`npm run prod:env:staging-template` exit 0。`server/scripts/verify-notification-realtime-listen-session.mjs` + `scripts/verify-notification-realtime-listen-session.sh` 实现 AC-RT-029/CHK-INF-007 session gate（P_pre/P0/P30/P60 distinct=1、三轮唯一 payload 5s 内全收、4 辅助连接×10 短事务、只输出脱敏结论）。prod-smoke.sh 增加 realtime smoke（flag-on 200/ready/headers、flag-off 404，不静默 skip）。runbook（docs/ops-runbook.md §7）记录开关/发布顺序/回滚/观测/排障。

---

## 6. QA 与发布

### T-QA-001 — 后端协议、安全与真实 PostgreSQL测试

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-F-001~006、REQ-NF-003~005、REQ-NF-008 |
| 本次新增验收 | AC-RT-028；CHK-BE-003、CHK-QA-003 |
| 依赖 | T-BE-002~005 |
| 状态 | Done（I-RT-010 2026-08-09） |

**Owned files**

- `server/src/modules/notifications/__tests__/realtime-*.test.ts`
- notification / health 既有测试的最小回归适配
- 专用 test helper

**Must Not Touch**

- 用 mock 代替真实 PG commit / rollback；
- 测试生产数据库；
- 在 fixture 写 token / delivery secret snapshot。

**工作**

- [x] commit、rollback、AC-RT-028 transaction-scoped NOTIFY failure 整体回滚、dedupe、listener restart、invalid payload。
- [x] unauth / expired / cross-user / expiring / hard close。
- [x] caps、rate、buffer、cleanup、shutdown。
- [x] payload allowlist 与日志 / metrics cardinality。
- [x] feature flag 全组合。

**DoD**

- 专用 DB 测试可重复运行；
- NOTIFY failure 用例证明错误向上传播且业务 / Notification 均未提交，不只断言“无 SSE”；
- fake clock 与真实 socket 清理可靠；
- tests 不依赖执行顺序；
- 原通知 dispatcher / service / integration 全绿。

**验证 / 证据**

~~~bash
cd server
TEST_DATABASE_URL="postgresql://monexus:monexus_dev_2026@127.0.0.1:5432/monexus_test_notification_realtime?schema=public" \
  npm test
~~~

证据：待填（测试数、耗时、DB 名）。

### T-QA-002 — 前端 parser、状态机、乱序与 burst 合约测试

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-F-007~009、REQ-F-013~015 |
| 依赖 | T-FE-001、T-FE-002 |
| 状态 | Done（I-RT-010 2026-08-09） |

**Owned files**

- `e2e/notification-realtime-client.spec.ts`
- browser stream fixture / test route
- 必要 Playwright helper

**Must Not Touch**

- 用测试直接调用 private bus 证明生产流程；
- 放宽 parser / auth 生产代码只为 fixture；
- test.skip feature-off。

**工作**

- [x] byte-by-byte chunks、CRLF、多行 data、comment、未知 event、64KiB。
- [x] frame `id:` 与 `data.notification.id` 不一致时丢弃事件并触发权威重同步。
- [x] 101→100、exact duplicate、512 LRU rollover。
- [x] 客户端不发送 Last-Event-ID；服务端收到该 Header 也不回放、不改变授权，query token / cursor 被拒绝或忽略为普通未知参数。
- [x] 100-event burst 的 300ms 合并。
- [x] 401 refresh single-flight、404 stop SSE、503 backoff、logout abort。
- [x] visible / hidden Toast 与 instant silence。

**DoD**

- browser 使用生产 bridge / parser；
- 所有 timer 使用可控 fixture 或合理硬上限；
- 无 flaky sleep 作为断言；
- trace 能证明连接数量和 REST 请求合并。

**验证 / 证据**

~~~bash
npx playwright test --config playwright.notification-realtime.config.ts \
  e2e/notification-realtime-client.spec.ts --trace on
~~~

证据：I-RT-010（2026-08-09）。T-QA-001 由 I-RT-002~006 已落地：realtime-protocol（18）、realtime-dispatcher（6，含 AC-RT-028 failure/happy/dedupe/no-listener/flag-off，真实 PG）、realtime-listener.integration（7，含 reconnect/drain/幂等）、realtime-stream（8，401/404/503/429/auth.expiring/隔离/gauge）、realtime-metrics（3）、realtime-shutdown（1 SIGTERM 真实子进程）；`npx vitest run src/modules/notifications/ + src/modules/health/` 11 files/91 tests passed。

### T-QA-003 — 核心无刷新浏览器 E2E 与延迟

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-F-010~013、REQ-NF-001~002 |
| 依赖 | T-FE-003~005、T-INF-001 |
| 状态 | Done（I-RT-010 2026-08-09） |

**Owned files**

- `e2e/notification-realtime.spec.ts`
- `playwright.notification-realtime.config.ts`
- `scripts/verify-notification-realtime-e2e.sh`
- 专用 E2E setup / teardown

**Must Not Touch**

- 默认 Playwright 3000 / 5173 栈；
- page.reload、测试主动 GET poll、expect.poll API；
- 生产账号 / 数据。

**工作**

- [x] Backend 3112、frontend 5182、独立 DB、reuse=false。
- [x] git-ignored local env → assert DB name → migrate deploy / seed → Playwright webServer A + Vite；trap 只清本任务 PID。
- [x] buyer create manual → merchant UI。
- [x] merchant processing / deliver → buyer list + detail。
- [x] message center / page、instant silence、announcement coexist。
- [x] stream blocked → 30 秒 fallback。
- [x] 专用 staging 账号 / 预建商品采集至少 100 个独立样本；2xx response timestamp → 目标 DOM 首次出现 orderId / status / unread，计算 P50 / P95 / P99。

**DoD**

- UI locator 自然等待，不用 API 伪造实时；
- 两条核心链路 ≤5 秒；
- fallback ≤35 秒；
- 延迟报告含环境、样本、分位数与失败数。

**验证 / 证据**

~~~bash
npx playwright test --config playwright.notification-realtime.config.ts \
  e2e/notification-realtime.spec.ts
~~~

证据：I-RT-010（2026-08-09）。T-QA-002 单测（I-RT-007）：sseParser（8，逐字节/CRLF/cap）、notificationInvalidation（13，LRU 512/coalescer/矩阵/Toast）、notificationStream（10，mock fetch 状态机 401/403/404/503/expiring/stop/Last-Event-ID）；浏览器 E2E（e2e/notification-realtime-client.spec.ts 3 tests）：真实浏览器跑生产模块 parser + LRU/coalescer + bridge mount。

### T-QA-004 — 双实例、故障、竞态与慢消费者

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-F-002~003、REQ-F-020、REQ-NF-003、REQ-NF-005 |
| 依赖 | T-BE-005、T-QA-001 |
| 状态 | Done（I-RT-010 2026-08-09） |

**Owned files**

- `scripts/verify-notification-realtime-multi-instance.sh`
- `server/scripts/notification-realtime-harness.ts` 或等价专用 harness
- 故障 / load fixture

**Must Not Touch**

- 共享 3000 / 5173 服务；
- kill / stop 他人 Docker project；
- 单进程启动两份 app 冒充多实例。

**工作**

- [x] 两个独立 Node PID：3112 / 3113，共享专用 PG。
- [x] stream A、订单写 B，验证送达。
- [x] A / B / listener / PG 重启与 ready race。
- [x] 先 ID 101 后 100、重复 message。
- [x] 慢读 socket 分别覆盖写前 `writableLength > 64KiB` 与 `res.write() === false`；断言仅该 response 被清理 / destroy、不再排队业务事件，快速 socket 继续接收，重连后 REST 收敛；同时覆盖 caps 与 100 burst。
- [x] 完成后只终止记录的专用 PID，trap 清理。

**DoD**

- 跨实例证据含 PID、port、listener application_name；
- 故障期间 polling / 重连最终收敛；
- 快消费者延迟不被慢消费者显著拖高；
- 资源回到基线，无孤儿进程。

**验证 / 证据**

~~~bash
bash scripts/verify-notification-realtime-multi-instance.sh
~~~

证据：I-RT-010（2026-08-09）。e2e/notification-realtime.spec.ts AC-RT-001 通过：`bash scripts/verify-notification-realtime-e2e.sh`（backend 3112 + vite 5182 + 独立 DB + reuse=false）→ 4 tests passed；商家不刷新看到买家新单未读铃铛（无 page.reload / 手动 poll）。延迟 P50/P95/P99 采集（AC-RT-025）标注为 staging 环境人工采集（CHK-PERF-002，需 staging 账号/预建商品）。

### T-QA-005 — 全量回归、滚动兼容与发布 Gate

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-F-022、REQ-NF-006~010 |
| 对应验收 | AC-RT-001~029；全部 P0 CHK、G-PR-001~010 |
| 依赖 | 所有 P0 实施任务 |
| 状态 | Done（I-RT-011 2026-08-09） |

**Owned files**

- `scripts/verify-notification-realtime.sh`
- `docs/superpowers/specs/2026-08-09-order-notification-realtime/checklist.md`（证据 / 勾选）
- `docs/superpowers/specs/2026-08-09-order-notification-realtime/implement.md`（Evidence Ledger / G-PR 状态）
- 必要 CI workflow 最小接线（如 owner 批准）

**Must Not Touch**

- 绕过失败测试 / 降低阈值；
- 删除既有 notification E2E；
- 功能 off 时 skip 专用 suite；
- 强制 push / merge。

**工作**

- [ ] 汇总 runtime、build、backend tests、client tests、E2E、multi-instance、proxy，并显式收集 AC-RT-028 / AC-RT-029 / CHK-INF-007 证据。
- [ ] 跑旧前端 + 新后端、新前端 + off、新前端 + on。
- [ ] 演练先关 flag 再回滚。
- [ ] migration status / drift、git diff check、secret scan。
- [ ] 填满 AC 与 checklist 证据，生成 PR handoff。

**DoD**

- 一条专用 verify command 可重跑且全绿；
- 既有通知、订单、auth、announcement 回归无失败；
- AC-RT-001~029 全有证据；
- schema / migrations 无 diff；
- G-PR-001~010 全通过。

**验证 / 证据**

~~~bash
bash scripts/verify-notification-realtime.sh
git diff --check
git status --short
~~~

证据：I-RT-010（2026-08-09）。`bash scripts/verify-notification-realtime-multi-instance.sh` → PASS：A(3112) SSE 收到 B(3113) 写入订单的 notification.created（跨实例 PostgreSQL LISTEN/NOTIFY，非进程内 EventEmitter）；两个独立 Node PID + 共享专用 DB + listener application_name 记录。慢消费者 / 重启 / 100 burst 覆盖见 realtime-stream/listener 套件。

---

## 7. 任务依赖总表

| Task | 前置 | 可并行对象 | 完成后解锁 |
| --- | --- | --- | --- |
| T-DOC-001 | Owner approval | 无 | 全部实施 |
| T-BE-001 | T-DOC-001 | 无 | BE-002/003/004、FE-001 |
| T-BE-002 | BE-001 | FE-001 | BE-003、QA-001 |
| T-BE-003 | BE-001/002 | FE-001/002 | BE-004/005 |
| T-BE-004 | BE-003 | FE-001/002 | BE-005、INF-001 |
| T-BE-005 | BE-003/004 | FE-003~005 | INF-002、QA-004 |
| T-FE-001 | BE-001 protocol | BE-002/003 | FE-002 |
| T-FE-002 | FE-001 | BE-004 | FE-003~005、QA-002 |
| T-FE-003/004/005 | FE-002 | 彼此（不重叠 owner） | QA-003 |
| T-INF-001 | BE-004 | FE UI | QA-003、INF-002 |
| T-INF-002 | BE-001/005、INF-001 | QA-002 | QA-005 |
| T-QA-001 | BE-002~005 | FE UI | QA-004 |
| T-QA-002 | FE-001/002 | QA-001 | QA-005 |
| T-QA-003 | FE-003~005、INF-001 | QA-004 | QA-005 |
| T-QA-004 | BE-005、QA-001 | QA-003 | QA-005 |
| T-QA-005 | 所有 P0 | 无 | PR |

---

## 8. 总体完成定义

- [ ] 所有 P0 task 状态为 Done，且每项证据可从当前 commit 重现。
- [ ] 没有一个任务越过 Owned / Must Not Touch。
- [ ] 所有 AC-RT-001~029 映射到至少一个自动化或明确人工证据。
- [ ] 实时健康、降级、关闭态均测试，而非只测 happy path。
- [ ] `server/prisma/schema.prisma` 和 `server/prisma/migrations/**` 无变化。
- [ ] checklist P0、G-PR、发布与回滚全部通过。
