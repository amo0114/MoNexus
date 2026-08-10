# Plan: 订单通知实时化

| 字段 | 值 |
| --- | --- |
| 文档 ID | PLAN-NOTIFY-RT-001 |
| 版本 | 0.2.0 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation** |
| 输入 | [spec.md](./spec.md) |
| 审查基线 | `develop@da38dd0580eeac737f5291556b9dbdf832d91970` |

---

## 1. 目标与非目标

### 1.1 工程目标

在不改动 Notification 数据模型和订单通知业务矩阵的前提下，交付一条可跨 Node 实例、符合事务提交边界、可鉴权、可降级、可观测和可安全回滚的网页实时通知链路。

### 1.2 非目标

- 不实现 WebSocket、聊天、presence 或客户端上行事件。
- 不创建 NotificationOutbox、NotificationDelivery、偏好表或任何 migration。
- 不把现有显式 fetch 页面整体迁移到 TanStack Query。
- 不改变订单状态机、通知文案、收件人或公告产品。
- 不把实时提示当作消息队列或离线 Push。

---

## 2. 现状到目标的变化

| 层 | 当前 | 目标 |
| --- | --- | --- |
| 业务事务 | INSERT Notification | INSERT + 同事务参数化 `pg_notify` |
| 跨实例 | 无 | 每实例一条专用 PostgreSQL LISTEN connection |
| 浏览器抵达 | 30 秒未读轮询 | SSE 正常路径，30 秒轮询降级 |
| 页面刷新 | 页面挂载 / 本地操作 | typed invalidation 驱动现有 load / reload |
| 鉴权 | REST Bearer JWT | SSE 继续 Bearer；到期提示 + 强制断连 |
| 恢复 | 回前台刷新未读 | ready / 重连 / 回前台 / fallback 全部 REST 收敛 |
| 代理 | 普通 API 60 秒 | exact SSE location、无缓冲、heartbeat |
| 生命周期 | server.close 等待长连接 | readiness draining + 主动 SSE drain + listener stop |
| 观测 | notification created counter | listener / connection / lag / rejection / disconnect metrics |

---

## 3. 模块设计与建议目录

### 3.1 后端

~~~text
server/src/modules/notifications/
  dispatcher.ts                         # 新 insert 后登记 PG hint
  service.ts                            # 安全 realtime envelope 查询
  routes.ts                             # GET /stream，必须在 /:id 类路由前
  realtime/
    constants.ts                        # 静态 channel、事件枚举、固定 auth lead
    protocol.ts                         # PG payload / SSE envelope 校验与 serializer
    hub.ts                              # 本实例连接注册、路由、heartbeat、cap、drain
    listener.ts                         # 独立 pg.Client、LISTEN、重连、主库查询
    streamController.ts                 # 建连前检查、headers、token timer、cleanup
    lifecycle.ts                        # start / status / stop facade
  __tests__/
    realtime-protocol.test.ts
    realtime-dispatcher.test.ts
    realtime-stream.test.ts
    realtime-listener.integration.test.ts

server/src/
  config/index.ts                       # env schema + flag guard
  middlewares/auth.ts                   # AuthPayload 暴露 exp
  lib/metrics.ts                        # 有界 realtime metrics
  modules/health/service.ts             # disabled/ok/degraded/draining
  main.ts                               # bootstrap + shutdown 次序
~~~

边界：

- `realtime/protocol.ts` 是跨 listener / controller 的唯一 serializer；其他模块不得手拼 SSE。
- `hub.ts` 不访问数据库；`listener.ts` 不持有 Express response。
- `dispatcher.ts` 不 import hub / listener。
- `lifecycle.ts` 是 main / health 读取状态的唯一入口，防止全局状态散落。

### 3.2 前端

~~~text
src/realtime/
  sseParser.ts                          # 受控 v1 parser，64KiB frame cap
  notificationStream.ts                # fetch、状态机、refresh、backoff、abort
  notificationInvalidation.ts          # typed topics、300ms coalescing、exact-ID LRU
src/hooks/
  useNotificationInvalidation.ts       # 页面订阅与 cleanup
src/components/
  NotificationRealtimeBridge.tsx       # 登录态下唯一启动点

现有接入：
  src/components/Layout.tsx
  src/components/AnnouncementCenter.tsx
  src/pages/NotificationsPage.tsx
  src/pages/OrdersPage.tsx
  src/pages/MerchantDashboardPage.tsx
  src/stores/appStore.ts
  src/types/notification.ts
~~~

边界：

- stream manager 不直接 import 订单 / 商家 API；它只发布 typed invalidation。
- 页面订阅器复用页面自己的 load 函数，保持数据 ownership。
- appStore 只保存全局 stream 状态、未读数和 Toast，不保存完整订单 / 通知列表。
- 公告 hook 与 Announcement 数据结构不进入 realtime bus。

### 3.3 依赖变化

| 包 | 位置 | 类型 | 原因 |
| --- | --- | --- | --- |
| `pg` | `server/package.json` | runtime | Prisma 不暴露 PostgreSQL notification event，需独立 LISTEN connection |
| `@types/pg` | `server/package.json` | dev | TypeScript strict typing |

前端不增加 EventSource / parser / query library；使用标准 fetch / ReadableStream / TextDecoder。

---

## 4. 关键技术方案

### 4.1 同事务唤醒

保持现有 `createMany(skipDuplicates)`。仅当 count=1：

1. 以复合唯一键在同一 tx 查询 Notification ID；
2. 组装固定三字段 JSON；
3. 用 Prisma tagged raw query 参数化调用 `pg_notify`；
4. 事务 commit 后 PG 才把 hint 交给 listener；rollback 时 hint 自动消失。

realtime=true 时，步骤 3 的 SQL 是业务事务成功条件之一：任一 `pg_notify` 执行异常必须向上传播并使订单 / 履约写入与 Notification 整体 rollback。禁止 catch 后继续、后台补偿或移动到 commit 后；listener 不存在不构成 SQL 错误，仍正常 commit。启用前用实际部署数据库角色验证权限、静态 channel 与小 payload；失败时保持 flag off。

AC-RT-028 / CHK-BE-003 / CHK-QA-003 的 listener 必须先取得 LISTEN ACK。deterministic failure 用例用 transaction-scoped tx proxy 恰好一次捕获参数化 `pg_notify` 的唯一 ID 对后抛 sentinel；root client 调用或 proxy 未命中必须失败。callback reject 后，独立 client 查询真实订单 / 履约 / Notification 均无行，并对该 ID 对等待完整 2 秒无 hint；无注入 real-PG happy path 按已提交 ID 对要求 commit 后 5 秒内恰好一个 hint。listener 未 ready、无法关联唯一 ID 或超时均失败；生产代码不得为测试增加旁路。

不选方案：

- 应用内事务回调直接广播：会产生 rollback ghost；
- 提交后普通函数广播：进程在 commit 后 / broadcast 前崩溃会丢提示；
- DB trigger：隐藏业务语义，难测试且会扩大迁移范围；
- 为本波新增 Outbox：可靠外部投递尚无需求，复杂度不匹配。

### 4.2 Listener 与 hub

`NotificationRealtimeLifecycle.start()` 创建 listener。listener healthy 才允许新 SSE 200；否则 stream 建连返回 503，而订单 / REST 保持工作。

收到 PG message：

1. protocol 校验；
2. hub 先判断本实例是否存在该 user 的本地 response；不存在则跳过查询，等待未来 ready 同步；
3. 存在本地连接时，service 从 Prisma primary 读取安全摘要；
4. serializer 写出 notification.created；
5. 写失败只清理该连接，不反向影响 listener 或订单。

listener 启用 TCP keepalive，并每 30 秒在专用连接执行轻量 probe。故障时 lifecycle 先原子切 degraded、让新连接 503，再对旧连接快照一次性 drain；每次连接使用 generation，旧 Client 的迟到 callback 不得改变新状态。重连期间没有可靠 backlog；客户端立即进入 polling。恢复后的新 generation 只有在 LISTEN + probe 都成功后才切 healthy，新 stream ready 触发完整同步。

production-like 部署必须额外运行 AC-RT-029 / CHK-INF-007 session gate：先以 deployment / provider 配置证明 endpoint class 是 direct 或 session pool；证据只对同 endpoint / role / deployment revision 有效，并在 7×24 小时或三元组变化时过期。行为 gate 用实际角色：连接后核对 `current_user` match boolean 和 P_pre，LISTEN ACK 后取 P0；独立 sender 在 t≈0/30/60 三轮执行参数化 `pg_notify`，每轮 5 秒内须收到匹配唯一 payload；t≈30/60 probe 同时取 P30/P60，另有 4 个独立辅助连接各在 60 秒内跑 10 个短事务。最长 65 秒，只有四个 PID distinct count=1、三轮全收且连接 / LISTEN / NOTIFY 无权限错误才通过。证据缺失 / 过期或行为失败均保持 realtime=false；direct / session URL 属 Owner delta。

### 4.3 SSE 建连顺序

~~~text
route limiter
  → authenticate
  → requireActiveUser
  → feature flags
  → listener healthy / not draining
  → user/IP/global caps
  → set + flush headers
  → hub.registerAndReady(response)
       （同一同步调用栈：insert initializing → write ready → mark ready；不得 await）
  → schedule auth.expiring / expiry
  → req close cleanup
~~~

cap、404、401、503 必须在 headers 发送前决定，确保客户端能读取标准 HTTP 状态。
hub 广播只选择 ready entry；initializing 窗口内的事件由 ready 后 REST 同步覆盖，因此业务字节不会先于 ready。

### 4.4 前端连接与同步

`NotificationRealtimeBridge` 只在登录用户的 Layout 内挂载。它观察 `user.id + accessToken`：

- 新 token：abort 旧 fetch，再连接；
- ready：stream=healthy，发布 all.visible；
- notification：exact-ID LRU 去重后，按事件矩阵发布 topics 和可见 Toast；
- auth.expiring：调用现有 `refreshAccessToken(staleToken)` 单飞，成功重连；
- 401：最多 refresh 一次；终局失败由现有 authStore logout；
- 404：当前登录会话标记 polling_only；
- 429 / 503 / network：进入 backoff；
- logout / user change：同步 abort、clear timers、clear LRU、clear pending topics。

### 4.5 REST 同步策略

| 触发 | 同步 | Toast |
| --- | --- | --- |
| stream.ready | unread + 所有当前挂载 topic | 否 |
| notification.created | unread + event matrix topic，300ms 合并 | 按 live 规则 |
| visibility visible | unread + 当前挂载 topic | 否 |
| degraded 30 秒 tick | unread + 当前挂载 topic | 否 |
| healthy 5 分钟校准 | unread + 当前挂载 topic | 否 |
| local mark-read / order action | 保持现有局部行为，必要时触发 topic | 保持现有业务反馈 |

所有 realtime / polling reload 都是 background refresh：保留现有内容和交互状态，不回退到整页 skeleton；单次失败不清空列表、不连续弹错误 Toast，下一次校准继续重试。

### 4.6 代理

Nginx 在普通 `location /api/` 之外增加 exact `/api/notifications/stream`：

~~~nginx
location = /api/notifications/stream {
  proxy_pass http://server:3000;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Authorization $http_authorization;
  proxy_set_header Cookie $http_cookie;
  proxy_set_header Connection "";
  proxy_buffering off;
  proxy_cache off;
  gzip off;
  proxy_read_timeout 5m;
  proxy_send_timeout 1m;
}
~~~

Caddy 对反代配置增加 `flush_interval -1` 或用等价 exact matcher，最终以 raw-stream smoke 为准。

`proxy_read_timeout 5m` 是“相邻两次 upstream read 的最大空闲时间”，不是连接总寿命；20 秒 heartbeat 会持续续期。Caddy、云 LB 或 CDN 的任何 idle timeout 都必须大于三倍实际 heartbeat，且不得设置 5 分钟总响应寿命。canonical IP 只取 Express `req.ip`：直连 Nginx 的 `TRUST_PROXY=1`，Caddy→Nginx 的 `TRUST_PROXY=2`，proxy smoke 必测伪造 XFF。

### 4.7 Shutdown orchestration

`main.ts` 只编排、不得重新实现 hub / listener 状态：

1. signal compare-and-set → lifecycle.beginDraining()，启动 10 秒 force timer；
2. 立即调用一次 server.close 并保留 completion promise；
3. 同步 stop 所有 cron / producer；
4. await hub.degradeAndDrain(server_shutdown, configured grace)，超时只 destroy 本任务追踪的 SSE；
5. await listener.stop()，清 probe / retry / generation；
6. await server-close completion 后才 quit Redis / disconnect Prisma；
7. 清 force timer并退出。

每个 stop 必须幂等；在途普通 HTTP 未完成前不得断 Prisma。

### 4.8 LISTEN 广播放大升级线

P0 的每实例同 channel LISTEN 保持不变。D-RT-25 / CHK-P1-005 按 spec 8.5 计算 active listener instances、cluster listener wakeups/s 与 `no_subscriber / (routed + no_subscriber)`；零 routable 流量时 ratio 为 unavailable。已批准容量计划或部署 / autoscaling manifest 的 desired / max replicas≥32（记录 revision、Owner、日期）、实际实例数≥32，或基于 5 分钟 recording rules 的集群 wakeups≥1000/s、routable>0、ratio≥90% 且告警 `for: 15m` 后，创建独立 P1 规格。该项未勾选不阻断本波，只触发评估，不授权加 Kafka / Redis。

---

## 5. 分阶段实施

### Phase A — 冻结契约、配置与骨架

内容：

- Owner 批准 Draft，统一改为 Frozen。
- 对最新 develop 做 delta audit 并记录实现基线。
- 新增 config schema、默认值、非法组合 guard、env / compose 样例。
- 安装 `pg` / `@types/pg`，建立 protocol constants 和类型。
- 建立专用测试 DB、端口与 Playwright config。

出口条件：

- 配置矩阵测试通过；
- realtime 默认 false，现有行为不变；
- 无 schema / migration 变更；
- protocol 类型和静态 channel 已锁定。

### Phase B — 事务内 hint

内容：

- 改造 Dispatcher 新 insert 路径；
- 同 tx 读取 ID、参数化 pg_notify；
- 覆盖 commit、rollback、dedupe、flag 和 payload 安全测试，并完成 AC-RT-028 / CHK-BE-003 / CHK-QA-003。

出口条件：

- rollback 无 PG delivery；
- 注入 `pg_notify` SQL 错误时业务写入与 Notification 整体 rollback，错误不被吞掉；
- dedupe 不重复 hint；
- listener 不存在时 pg_notify 不阻断正常 commit；
- 旧 dispatcher / order notification tests 全绿。

### Phase C — Listener、hub 与 SSE endpoint

内容：

- 实现 listener lifecycle 和重连；
- 实现安全主库摘要查询；
- 实现 hub、protocol serializer、heartbeat、caps、backpressure、token timer；
- 挂载 `GET /stream`；
- 扩展 readiness、metrics 和 shutdown。

出口条件：

- raw HTTP 可收到 ready、heartbeat、notification；
- auth / isolation / token expiry / cap / slow client 测试通过；
- listener 故障关闭流、恢复可重连；
- 单实例无 response / timer / pg client 泄漏。

### Phase D — 前端连接核心

内容：

- 实现受控 SSE parser；
- 实现 stream 状态机、Abort、refresh、backoff；
- 实现 exact-ID LRU 和 300ms invalidation scheduler；
- 实现 bridge、30 秒 fallback、5 分钟校准和 visibility sync；
- 替换 Layout 原有独立轮询 effect。

出口条件：

- 每 Tab / 用户最多一个 active fetch；
- 101→100 乱序都被处理；
- 401 refresh 不重复消费 cookie；
- 404 / 503 / network 分支按契约工作；
- logout 后无旧连接或旧 timer。

### Phase E — UI 页面接入

内容：

- 通知未读 / 中心 / 消息页；
- 买家订单 / attention / 当前详情；
- 商家订单 / stats / 相关对话框；
- Toast matrix、即时单静默、未知事件 fallback。

出口条件：

- 两条核心链路真实浏览器无刷新更新；
- burst 不产生请求风暴；
- filter / pagination / dialog 状态不被破坏；
- 公告优先级与单铃铛语义回归通过。

### Phase F — 代理、运维与发布资产

内容：

- Nginx exact location、Caddy flush；
- compose / env / 运维文档；
- listener / SSE metrics、health、shutdown；
- production-like LISTEN session / runtime-role gate（AC-RT-029 / CHK-INF-007）；
- production smoke 和旧规格 superseded 链接。

出口条件：

- 经代理 small event / heartbeat 即时抵达；
- SIGTERM 5 秒 drain；
- metrics 无高基数 / secret；
- session gate 证明实际 endpoint 不是 transaction pool；否则 realtime 保持关闭；
- realtime off 能一键恢复旧路径。

### Phase G — 故障、双实例、性能与发布门禁

内容：

- 双 backend 进程共享 PG；
- PG / listener / backend 重启；
- race、乱序、重复、slow consumer、100-event burst；
- staging P95 / P99 测量；
- 滚动部署 / 回滚演练；
- 完整 build、既有回归、专用 E2E、smoke。

出口条件：

- AC-RT-001~029 有可审计证据；
- checklist P0 全勾选；
- 无 migration drift；
- PR 描述含规格路径、开关顺序、指标和回滚。

---

## 6. 依赖与并行边界

~~~text
Phase A
  ├─► Phase B Dispatcher
  ├─► Phase C Listener/Hub/SSE ─► Phase F lifecycle/infra
  └─► Phase D Frontend core ───► Phase E pages

Phase B + C + D + E + F ─► Phase G system verification
~~~

可并行：

- Phase B 的 Dispatcher 与 Phase D 的 parser / scheduler 可在协议类型冻结后并行；
- Phase E 的买家、商家、通知 UI 接入可按不重叠文件并行；
- Nginx/Caddy 文档可与前端页面接入并行。

不可并行或需串行 ownership：

- `server/src/config/index.ts`、`server/src/main.ts`、`src/components/Layout.tsx` 是共享热点，每次只能一个任务 owner；
- protocol.ts 必须先于 listener / frontend fixture 冻结；
- Dispatcher commit/rollback 测试必须先于双实例测试；
- 完整故障 / 性能测试必须在后端和前端行为均完成后进行。

---

## 7. 文件影响图

### 7.1 必改候选

| 域 | 文件 |
| --- | --- |
| 后端依赖 | `server/package.json`、`server/package-lock.json` |
| 配置 | `server/src/config/index.ts`、`server/.env.example`、根 `.env.example`、`docker-compose.prod.yml` |
| 通知 | `server/src/modules/notifications/dispatcher.ts`、`service.ts`、`routes.ts`、新增 `realtime/**` |
| 鉴权 | `server/src/middlewares/auth.ts`（仅 exp 类型 / 读取，不改 JWT 签发语义） |
| 生命周期 | `server/src/main.ts`、`server/src/modules/health/service.ts`、`server/src/lib/metrics.ts` |
| 前端核心 | 新增 `src/realtime/**`、`NotificationRealtimeBridge.tsx`、hook |
| 前端现有 | `Layout.tsx`、`AnnouncementCenter.tsx`、`NotificationsPage.tsx`、`OrdersPage.tsx`、`MerchantDashboardPage.tsx`、`appStore.ts`、`types/notification.ts` |
| 代理 / 运维 | `nginx.conf`、`deploy/vps/Caddyfile`、`scripts/prod-smoke.sh`、必要 README |
| QA | 通知测试目录、`e2e/notification-realtime.spec.ts`、专用 Playwright config / verify script |
| 旧规格 | `docs/specs/order-notification-system/spec.md`、`design.md`（只加 superseded 指针） |

### 7.2 明确不改

- `server/prisma/schema.prisma` 与 `server/prisma/migrations/**`；
- 订单状态机 / 收件人矩阵，除非仅为现有 Dispatcher 测试夹具；
- Announcement model、service、receipt 与公告 API；
- Refresh Token rotation、JWT 签名 secret、15 分钟 TTL；
- Redis 配置、Webhook / Faka / Delivery content；
- 当前 WIP worktree 内任何文件。

---

## 8. 测试策略

### 8.1 测试层级

| 层 | 重点 | 不可替代的证据 |
| --- | --- | --- |
| protocol unit | PG payload、SSE serializer、parser chunk / CRLF / frame cap | 精确 input/output |
| backend unit | hub cap、cleanup、backpressure、token timer、config | fake clock + fake response |
| real PG integration | commit / rollback / NOTIFY failure、LISTEN reconnect、dedupe、session gate | 专用 PostgreSQL，不能 mock event emitter |
| API integration | status、auth、isolation、headers、expiry | 实际 HTTP server / raw stream |
| browser E2E | 无刷新 UI、Toast、logout、fallback | Playwright 页面，不得手工 poll |
| multi-instance | A 连 stream、B 写订单 | 两个独立 Node 进程，共享 PG |
| proxy smoke | Nginx + Caddy buffering / heartbeat | curl -N / raw timestamp |
| load / resilience | 100 burst、慢消费者、caps、restart | 指标、内存和恢复证据 |
| regression | 现有 notification / order / auth / announcement | 全量相关 suite |

### 8.2 专用环境

- DB：`monexus_test_notification_realtime`，禁止默认 `monexus_test`。
- Backend A：`127.0.0.1:3112`；Backend B：`127.0.0.1:3113`。
- Frontend：`127.0.0.1:5182`，Vite proxy 指向 A。
- Playwright：`reuseExistingServer=false`。
- 两个 backend 使用相同 DB，不共享进程内 singleton。
- 测试完成只清理专用 DB / 进程；不得停止他人 compose 或占用 3000 / 5173。

专用入口由 `scripts/verify-notification-realtime-e2e.sh` 负责：

1. 从 git-ignored `.env.notification-realtime.local` 读取本地 TEST_DATABASE_URL / JWT 等变量且关闭 shell xtrace；先断言 DB 名精确匹配，再 migrate deploy + seed。
2. `playwright.notification-realtime.config.ts` 的 webServer 只启动 Backend A（PORT=3112、notifications/realtime=true、FRONTEND_ORIGIN=5182）与 Vite（5182、strictPort、proxy→3112），workers=1、reuse=false。
3. 复用现有 seed accounts 作为专用测试身份；所有订单 / 商品 fixture 只落专用 DB。
4. Backend B（3113）不由核心 Playwright config 启动，只由 T-QA-004 的 multi-instance harness 以独立 PID 启动。
5. trap 只终止脚本记录的 PID / 临时目录；不得停止共享 compose。

proxy smoke 由 T-INF-001 创建的脚本用 `mktemp -d` 和独立 Docker project / 高位端口启动 Backend A → production-like Nginx → Caddy 链路，针对实际生产配置模板验证；不得复用 80 / 443 或修改 host Caddy。

LISTEN session gate 由 T-INF-002 的专用脚本读取 git-ignored production-like env 且关闭 shell xtrace。先登记 direct / session-pool artifact / revision、时间和 reviewer；证据 7×24 小时或 endpoint / role / deployment revision 变化即过期。实际角色连接后核对 current_user match boolean / P_pre，LISTEN ACK 后取 P0；独立 sender（不计入辅助连接）在 t≈0/30/60 三轮发送唯一 v1 payload，每轮 SQL success 后 5 秒超时；t≈30/60 probe 取 P30/P60；4 个辅助连接各在 t=0~60 跑 10 个短事务。最长 65 秒。输出只允许 PID distinct count、三轮收发 / 权限结论、耗时、脱敏 endpoint class 与 metadata；不得回显 PID、URL、用户名或密码。证据缺失 / 过期、role mismatch、distinct count≠1、任一轮未收到或 CONNECT / LISTEN / NOTIFY 权限失败均非零阻断启用。

### 8.3 E2E 防伪规则

- 核心实时测试中禁止 `page.reload()`；
- 禁止测试代码轮询 `/notifications` 或 `/orders` 证明实时抵达；
- 禁止用 `expect.poll` 包裹 API GET 代替浏览器事件；
- 可用 locator auto-wait 等待 UI 改变；
- fallback 测试允许应用自身 30 秒 timer，不允许测试主动触发内部 bus；
- feature off 在专用 suite 中是失败用例，不能 `test.skip`。

staging 延迟使用专用账号与预建商品，不触碰真实用户 / 订单。每个样本从上游订单 mutation 收到 2xx 的 high-resolution browser timestamp 开始，到目标会话 DOM 首次出现对应 orderId / 新 status / unread 结束；fixture 准备、登录、商品创建不计入样本。至少 100 个独立业务事件，报告 P50 / P95 / P99、失败与环境。

---

## 9. 发布顺序

1. **准备**：合并代码但保持 realtime=false；先部署 Nginx/Caddy、后端依赖、endpoint、metrics、health，并用实际角色通过 production-like LISTEN session gate。
2. **验证关闭态**：notifications REST 正常，stream 404，前端旧版本不受影响。
3. **后端全量就绪**：所有 backend 实例升级到支持 realtime 的版本；禁止新旧 backend 混合时先发新前端。
4. **启用后端**：设置 realtime=true，滚动重启全部实例；验证 listener_up、raw stream、caps 和 proxy。
5. **发布前端**：新 bridge 连接已全量可用的 endpoint；观察连接数、lag、503 / reconnect。
6. **canary 业务**：专用测试账号完成新单 / 发货，确认 P95、跨实例与无敏感 payload。
7. **扩大**：保持 polling safety net，至少一个观察窗口后再评估连接 cap。

不得在前端已发布而一部分 backend 仍返回 404 时把“刷新页面即可恢复”当作正常发布策略。

---

## 10. 回滚

### 10.1 快速降级

1. 设置 `NOTIFICATION_REALTIME_ENABLED=false` 并滚动重启后端；
2. stream 返回 404，新前端进入 polling_only；
3. Notification 写入、REST、订单与公告继续工作；
4. 保留 pg dependency 和代码，不做临时 schema 操作。

### 10.2 版本回滚

1. 先关闭 realtime flag；
2. 回滚前端或保持新前端（404 → polling 均兼容）；
3. 回滚后端与代理；
4. 验证 Notification 历史、未读 REST 和 30 秒 polling；
5. 不删除 Notification 行，不回滚 / 删除任何 migration（本波本就不应有 migration）。

---

## 11. 风险控制与停止条件

出现以下任一情况，暂停启用或立即关闭 realtime flag：

- 下单 / 履约事务错误率相较基线显著上升；
- `notification_realtime_listener_up=0` 持续超过 2 分钟；
- 503 / reconnect 风暴、连接数接近 90% 全局 cap；
- P95 > 2 秒或代理聚合 heartbeat；
- Node RSS 随慢连接无界增长；
- SSE 出现交付 content、token、对象键等敏感字段；
- rollback 测试出现幽灵事件；
- `pg_notify` SQL 错误被吞掉、发生部分 commit，或 session gate 检出 transaction pooling / 权限失败；
- 双实例测试仅在同一进程 / 同一实例通过。

---

## 12. 完成信号

只有同时满足以下条件，PLAN-NOTIFY-RT-001 才算完成：

1. Owner 将六份文档冻结；
2. Phase A~G 所有 P0 task Done；
3. AC-RT-001~029 均有证据；
4. checklist P0、发布就绪和回滚演练全通过；
5. 当前分支基于最新 develop，无未解释冲突；
6. build、回归、专用实时 E2E、双实例、proxy smoke 全绿；
7. 无 Prisma schema / migration 变化；
8. PR 明确开关默认 false、发布顺序、监控与一键降级。
