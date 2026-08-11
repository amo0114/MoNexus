# Spec: 订单通知实时化

| 字段 | 值 |
| --- | --- |
| 文档 ID | SPEC-NOTIFY-RT-001 |
| 版本 | 0.2.0 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation** |
| 产品 | MoNexus |
| 审查基线 | `develop@da38dd0580eeac737f5291556b9dbdf832d91970` |
| 前置规格 | SPEC-NOTIFY-001、DESIGN-NOTIFY-001 |
| 配套文档 | [README.md](./README.md) · [plan.md](./plan.md) · [task.md](./task.md) · [implement.md](./implement.md) · [checklist.md](./checklist.md) |

---

## 1. 目的、现状与问题

### 1.1 目的

让订单事务通知在用户保持页面打开时主动抵达并驱动相关页面重取权威状态，消除“商家必须刷新才看到新单、买家必须刷新才看到发货”的体验缺口，同时保持现有通知持久化、幂等、权限及敏感数据边界不变。

### 1.2 已核实的基线事实

| 事实 | 基线位置 | 对本规格的含义 |
| --- | --- | --- |
| 已有 `Notification` 表，唯一约束为 `(recipientUserId, eventType, dedupeKey)` | `server/prisma/schema.prisma` | 无需重建消息模型；它继续是唯一事实源 |
| `NotificationDispatcher.emit(event, tx)` 与订单事务共用 Prisma transaction | `server/src/modules/notifications/dispatcher.ts`、订单 service / fulfillment | 可在同一事务内登记提交后唤醒；禁止直接向浏览器广播 |
| 已有通知列表、未读数、单条已读、全部已读 REST API | `server/src/modules/notifications/routes.ts` | 实时层只负责失效提示，最终状态仍由 REST 获取 |
| 前端铃铛、双 Tab 通知中心、消息页已存在 | `src/components/Layout.tsx`、`AnnouncementCenter.tsx`、`NotificationsPage.tsx` | 不新增第二套消息 UI |
| 未读数当前每 30 秒轮询，页面回前台时再刷新 | `src/components/Layout.tsx` | 未读最终会收敛，但正常延迟高达一个轮询周期 |
| 买家订单页和商家工作台只在挂载、筛选或本地操作后加载 | `src/pages/OrdersPage.tsx`、`MerchantDashboardPage.tsx` | 即使未读角标变化，订单实体仍可能保持陈旧 |
| 当前后端没有 SSE、WebSocket、PostgreSQL listener 或跨实例实时总线 | 全仓检索 | “需刷新”不是通知没落库，而是缺少服务端主动失效通道 |
| Nginx 普通 `/api/` 读超时为 60 秒，没有 SSE 专用无缓冲 location | `nginx.conf` | 直接增加 SSE handler 会被代理缓冲或周期断开 |
| Access Token 使用 Bearer JWT，固定 15 分钟；Refresh Token 使用 HttpOnly cookie 单飞轮换 | `server/src/middlewares/auth.ts`、`src/api/authRefresh.ts` | 原生 EventSource 不能安全复用现有鉴权，必须使用 fetch-based SSE |

### 1.3 根因判断

实时性不足的直接原因是：业务事务只把通知持久化到数据库，浏览器没有低延迟“状态已变化”信号；现有 UI 依赖 30 秒未读轮询和页面重新挂载，且订单列表、详情、商家统计没有统一失效机制。

缺少 WebSocket 不是根因本身。当前数据流是低频、单向的服务端到浏览器通知，SSE 比 WebSocket 更贴合；可靠性问题也不能靠换成 WebSocket 解决，必须由持久化事实源、事务提交边界、重连重同步和轮询降级共同解决。

### 1.4 成功标准

1. SSE 健康、正常测试负载下，订单 API 成功返回后到目标用户 UI 可见更新的 P95 ≤ 2 秒、P99 ≤ 5 秒。
2. 买家创建人工订单后，已打开商家工作台无需刷新即可出现订单、更新统计和未读数。
3. 商家开始处理或发货后，已打开买家订单列表 / 对应详情无需刷新即可显示新状态。
4. 业务事务回滚时，数据库无新通知且任何浏览器均不收到幽灵事件。
5. SSE、listener、代理或实例故障不会破坏下单 / 履约；客户端进入 30 秒轮询并最终收敛。
6. 多实例部署中，业务写入实例与 SSE 所在实例不同时仍能低延迟送达。
7. 重复提示、乱序提示和重连只允许造成重复 REST 刷新，不得造成永久遗漏、重复 Toast 或状态倒退。

---

## 2. 范围

### 2.1 范围内

| 域 | 本波交付 |
| --- | --- |
| 提交后唤醒 | 新通知成功插入后，在同一 PostgreSQL 事务内调用 `pg_notify` |
| 多实例传播 | 每个 Express 实例一条独立 `pg.Client` 长连接执行 `LISTEN` |
| 浏览器通道 | `GET /api/notifications/stream`，Bearer 鉴权、SSE、heartbeat、token 到期关闭 |
| 本地连接治理 | 按用户 / IP / 实例限额、建连速率限制、缓冲上限、慢消费者断开 |
| 权威重同步 | `stream.ready`、实时通知、重连、回前台、降级轮询均触发现有 REST 重新读取 |
| 前端失效层 | 全局 stream manager、精确 ID 去重、300ms 合并、typed invalidation bus |
| 页面联动 | 未读数、消息预览 / 列表、买家订单 / 当前详情、商家订单 / stats |
| 降级 | SSE 不可用时每 30 秒重同步；SSE 健康时每 5 分钟安全校准 |
| 生命周期 | listener 重连、readiness 可观测、SSE drain、优雅关闭 |
| 代理与部署 | Nginx SSE location、Caddy 即时 flush、Compose / env 开关、滚动部署与回滚 |
| 可观测性 | 有界标签 metrics、结构化日志、健康状态与生产 smoke |
| QA | 单元、真实 PostgreSQL 集成、浏览器实时 E2E、双实例、代理、故障与背压测试 |

### 2.2 明确范围外

| 项 | 原因 / 后续触发条件 |
| --- | --- |
| WebSocket / Socket.IO | 当前无双向高频交互；聊天、presence、协同编辑出现时另立规格 |
| Redis Pub/Sub / Redis Streams | Pub/Sub 同样会丢消息；Streams 增加消费组运维，当前 PostgreSQL 唤醒已够用 |
| Transactional Outbox | 外部邮件、短信、Web Push、跨服务重试 / 死信出现时启用 |
| 邮件、短信、浏览器 Push、App Push | 本波只做已登录网页内实时化 |
| 修改原通知事件矩阵或收件人 | 由 SPEC-NOTIFY-001 冻结，本规格只改变抵达方式 |
| 修改 `Notification` schema | 现有字段与唯一约束满足本波；本规格应做到零 migration |
| 用 `Announcement` 承载订单通知 | 公告与 1:1 事务通知保持分离 |
| TanStack Query 全站迁移 | 当前页面使用显式 fetch + local state；本波用轻量 typed invalidation |
| 多标签 leader election / BroadcastChannel | P0 允许每 Tab 一连接；有真实连接规模压力后再优化 |
| 严格一次且全局严格有序交付 | PostgreSQL sequence 不等于提交顺序；UI 正确性不需要此承诺 |
| 通知删除 tombstone / 历史流回放 | 当前没有通知删除产品语义；重连直接读取当前权威状态 |

### 2.3 与旧规格的覆盖关系

本规格仅覆盖 SPEC-NOTIFY-001 的以下条目：

- 范围外项“SSE / WebSocket 实时推送 Phase 3+”；
- NTF-08“短轮询是主路径、SSE 后置”；
- A-01 等“10 秒内通过轮询看到”的抵达验收方式。

以下旧约束继续有效：NTF-01~07、NTF-09~15、事件注册表、幂等键、权限、纯文本、deeplink、公告隔离、即时单商家静默及敏感交付内容禁入。

---

## 3. 术语与交付语义

| 术语 | 精确定义 |
| --- | --- |
| 事实源 | PostgreSQL `Notification` 行和订单 REST 响应；SSE 数据不是事实源 |
| 唤醒 hint | 只表示“某用户的某条持久化通知可能需要读取”的低延迟提示 |
| UI 收敛 | 客户端重新请求 REST 后，展示与当前数据库 / 订单状态一致 |
| 幽灵事件 | 对应业务事务最终回滚或不存在，但客户端已收到的实时事件 |
| listener | 每个 Node 实例独占的一条 `pg.Client` 连接，不能来自 Prisma pool |
| local hub | 仅管理当前 Node 实例上的 SSE responses，不承担跨实例持久化 |
| 实时健康 | listener 已连接并成功 LISTEN，实例不处于 draining，浏览器流持续收到 heartbeat |
| 精确去重 | 以单个 `notification.id` 是否已见为准；不能以最大 ID 水位判断 |

本波的交付语义是：

- `pg_notify` / SSE 是 **best-effort、允许重复的提示**；
- `Notification` + REST / polling 提供 **最终一致的 UI 状态收敛**；
- 不承诺每个提示恰好一次，也不承诺不同事务的提示按 ID 或业务时间严格排序。

---

## 4. 冻结决策

| ID | 决策 | 冻结结论 |
| --- | --- | --- |
| D-RT-01 | 事实源 | `Notification` 表保持唯一通知事实源；实时层不可保存另一份权威消息 |
| D-RT-02 | 浏览器传输 | 使用 SSE；不使用 WebSocket / Socket.IO |
| D-RT-03 | 提交边界 | 成功插入新 Notification 后，在同一 Prisma transaction 内调用 `pg_notify`；PostgreSQL 只会在 commit 后投递；NOTIFY SQL 异常必须原样使业务事务与 Notification 回滚，禁止捕获后继续、异步补发或移到 commit 后 |
| D-RT-04 | Trigger vs 应用 | 不创建数据库 trigger；业务语义和 hint 生成保留在 `NotificationDispatcher` |
| D-RT-05 | PG payload | 固定为 `{ v: 1, notificationId, recipientUserId }`；禁止 title/body/payload/订单内容进入 NOTIFY |
| D-RT-06 | 多实例 | 每个 Express 实例独立 LISTEN 同一静态 channel，并只广播到本实例的用户连接 |
| D-RT-07 | 广播前读取 | 本实例存在目标用户连接时，listener 必须按 `id + recipientUserId` 从主库重新查询允许字段后才广播；无本地连接可跳过查询，不得直接转发 PG payload |
| D-RT-08 | 可靠性 | LISTEN/NOTIFY 不作可靠队列；所有连接、重连和回前台都执行 REST 权威同步 |
| D-RT-09 | 排序 | `Notification.id` 是身份，不是严格提交序；客户端使用有界精确 ID Set，禁止 `id <= maxSeen` 式过滤 |
| D-RT-10 | 回放 | P0 不实现 `Last-Event-ID` 缺口回放；SSE event id 仅用于精确去重和诊断，断线恢复一律 REST 重同步 |
| D-RT-11 | 鉴权 | 继续 Bearer JWT；使用 fetch-based SSE，token / refresh token 禁止放 query、日志或事件 |
| D-RT-12 | token 生命周期 | 服务端在 access token 到期前 60 秒发送 `auth.expiring`，到期时强制结束流；客户端复用现有单飞 refresh 后重连 |
| D-RT-13 | 建连竞态 | hub 以单个不 yield 的 `registerAndReady` 同步操作完成“登记 initializing → 写 ready → 标记 ready”；广播只投递 ready 连接，窗口事件由 ready 后 REST 同步恢复 |
| D-RT-14 | 前端状态层 | 不引入 TanStack Query；增加 typed invalidation bus，页面复用现有 load / reload |
| D-RT-15 | 降级轮询 | 非 healthy 状态每 30 秒同步；healthy 状态每 5 分钟安全校准；回前台立即同步 |
| D-RT-16 | 多标签 | P0 每个 Tab 一连接，只在可见 Tab 展示 Toast；每用户最多 5 连接 |
| D-RT-17 | Toast | 新事件可以 Toast；重连 / ready / polling 不补历史 Toast；即时交付弱通知默认静默 |
| D-RT-18 | 资源治理 | 全局、单用户、单 IP、建连速率、response buffer 均有硬上限；慢消费者主动断开 |
| D-RT-19 | 代理 | Nginx exact SSE location 禁缓冲 / 缓存并延长 read timeout；Caddy 强制即时 flush |
| D-RT-20 | 生命周期 | listener 失败时关闭现有流并进入 polling；shutdown 先 draining 并立即停止新 HTTP，再 drain SSE / listener，待在途 HTTP 完成后关闭 Redis / Prisma |
| D-RT-21 | 开关 | 新开关默认 false；`NOTIFICATION_REALTIME_ENABLED=true` 必须要求 `NOTIFICATION_ENABLED=true` |
| D-RT-22 | 数据模型 | 本波零 Prisma migration；新增后端直接依赖 `pg` 与 `@types/pg`，前端不新增 SSE 第三方依赖 |
| D-RT-23 | 回滚 | 关闭 realtime 开关即可回到现有 REST + 30 秒轮询；不得删除 Notification 表或历史数据 |
| D-RT-24 | 未来升级 | 只有外部渠道 / 跨服务可靠投递出现时升级 Transactional Outbox；聊天等双向场景才升级 WebSocket |
| D-RT-25 | 广播放大升级线 | P0 继续每实例监听同一 channel；达到 8.5 的实例数或放大压力阈值时，只触发独立 P1 架构评估，不在本波预埋 broker / sharding |

---

## 5. 目标架构

~~~text
订单 checkout / 履约状态事务
        │
        ├─ INSERT Notification（现有，唯一事实源）
        │
        └─ SELECT pg_notify(channel, {v,id,user})（同一 transaction）
                     │
              COMMIT 后 PostgreSQL 才投递
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
 Node 实例 A 专用 LISTEN   Node 实例 B 专用 LISTEN
          │                     │
  按 id + user 查主库      按 id + user 查主库
          │                     │
  仅广播 A 本地连接        仅广播 B 本地连接
          └──────────┬──────────┘
                     ▼
       GET /api/notifications/stream（SSE）
                     │
          notification.created / ready
                     │
        前端精确去重 + 300ms 合并失效
          ├─ 通知未读 / 列表 REST
          ├─ 买家订单 / 当前详情 REST
          └─ 商家订单 / stats REST

任一实时环节故障 ──► stream 断开 / 503 ──► 30 秒 polling + 回前台同步
~~~

### 5.1 为什么不是直接 WebSocket

当前服务端只需向登录用户单向发送低频“数据已变化”提示。SSE 复用 HTTP、反向代理和 Bearer 鉴权语义，客户端只需要断线重连与流解析；WebSocket 会额外引入 Upgrade、双向协议、粘性连接和更复杂的心跳治理，却不会自动解决事务回滚、跨实例、丢消息或重同步问题。

### 5.2 为什么暂不引入 Redis / Outbox

PostgreSQL 已经是订单与通知的事务边界。`pg_notify` 在事务提交后投递，能用最少组件提供低延迟跨实例唤醒；即便通知丢失，REST / polling 仍从 Notification 表恢复。外部渠道需要重试、ack、死信时，再引入持久化 Outbox，而不是把 Redis Pub/Sub 误当可靠队列。

---

## 6. 后端契约

### 6.1 Dispatcher 与事务内 hint

仅当 `NOTIFICATION_ENABLED=true` 且实际插入一条新 Notification 时执行：

1. 保持现有 `createMany({ skipDuplicates: true })` 和三元组唯一约束。
2. 当 `result.count === 1`，使用同一 `tx.notification` 按复合唯一键读取新行的 `id`。
3. 当 `NOTIFICATION_REALTIME_ENABLED=true`，使用同一 transaction 的参数化 `tx.$queryRaw` 调用静态 channel 上的 `pg_notify`。
4. PG payload 只含版本、notificationId、recipientUserId，JSON UTF-8 长度必须远低于 PostgreSQL 8KB 限制。
5. `result.count === 0` 的幂等重放不再次 NOTIFY；遗漏由 REST 状态同步覆盖。
6. 禁止在 transaction callback 中调用 local hub、`res.write`、Redis publish 或进程内 EventEmitter。

`pg_notify` 是该事务的一条普通 SQL，而不是可忽略的旁路。realtime=true 时，权限、连接、函数调用或 SQL 执行异常必须向上传播，使订单 / 履约写入、Notification 与 hint 一起回滚；Dispatcher 不得吞错后返回业务成功，也不得把调用移到 commit 后。没有任何 listener 订阅 channel 不会使 `pg_notify` 失败，仍应正常提交。若上线观察到 NOTIFY SQL 导致业务错误率上升，先关闭 realtime flag 并重启，不得现场改成 commit 后广播。

AC-RT-028 的失败证明必须同时满足：专用真实 listener 先完成静态 channel 的 LISTEN command ACK，再开始业务事务；订单 / Notification 仍在专用真实 Prisma transaction 中写入；仅用包裹该 transaction client 的 proxy 拦截 `$queryRaw`，记录并断言恰好一次命中参数化 `pg_notify` 后抛出 sentinel error，同时从参数捕获唯一 `{notificationId, recipientUserId}`；root Prisma `$queryRaw` 被调用或 transaction-scoped 调用未命中都使测试失败。transaction callback 必须以该 sentinel reject；callback 结束后用独立 Prisma client 查询订单 / 履约 / Notification 均无行，并从 reject 时刻起等待完整 2 秒，listener 不得收到匹配该 ID 对的 hint。另有不注入错误的真实 PostgreSQL happy-path：listener 同样先 ACK，使用该已提交行的精确 ID 对关联，commit 后 5 秒内恰好收到一个 v1 hint。其他 ID 的环境噪声不计入断言；超时、listener 未 ready 或无法取得唯一 ID 均为测试失败。不得为测试修改生产协议或全局 REVOKE PG 权限。

静态 channel：`monexus_notification_created_v1`。channel 不得来自请求、用户或环境变量，避免注入与版本漂移。

### 6.2 PostgreSQL listener

新增一条不进入 Prisma pool 的 `pg.Client`：

- P0 连接串只读现有 `DATABASE_URL`；`application_name=monexus-notification-realtime-listener`。该 endpoint 必须提供 session 语义；不得把 transaction-pooling endpoint 当作已支持。
- 每个 Node 进程恰好一条 listener connection，不得每用户 / 每 SSE 建 PG 连接。
- 启动后执行 `LISTEN monexus_notification_created_v1`，成功才标记 healthy。
- `error`、`end` 或 keepalive 失败时立即标记 degraded、关闭本实例所有 SSE，并按 1s、2s、4s、8s、16s、30s（±20% jitter）重连。
- 启用 TCP keepalive，并每 30 秒在该专用连接执行一次轻量 `SELECT 1` probe；probe 失败与 error / end 使用同一 degraded 路径。
- 解析 payload 时验证 `v === 1`、两个 ID 均为正安全整数；无效消息只计数 / 脱敏日志，不广播。
- 若 local hub 没有该 recipient 的连接，记录 `no_subscriber` 后跳过主库查询；连接稍后建立时由 ready 同步。
- 若存在本地连接，按 `id + recipientUserId` 查询主库；查不到、用户不匹配或查询失败时不广播，等待客户端 REST 同步。
- listener 不应把失败升级为整个订单 API 不可用；readiness 公开 degraded，但核心 API 仍可 ready。

启用 realtime 前必须以 production-like `DATABASE_URL` 和实际部署数据库角色执行 P0 session gate，且两类证据缺一不可。配置证据必须明确 endpoint 为 direct / session pool、不是 transaction / statement pool。行为 gate 的固定时间线是：listener 连接 / 认证成功后查询 `current_user` 并与部署声明角色比较（只输出 match boolean），查询 `P_pre=pg_backend_pid()`，执行静态 channel `LISTEN` 并等待 command ACK，再取 `P0`；专用 sender（不得兼任辅助连接）执行参数化 `pg_notify`，分别在 t≈0 / 30 / 60 秒发送三个唯一 v1 小 payload，每轮从 SQL success 起 5 秒内必须由原 listener 收到；t≈30 / 60 秒先执行 `SELECT 1, pg_backend_pid()` probe 得到 `P30/P60`。同时至少 4 个独立辅助连接各在 t=0~60 秒间完成 10 个短事务制造连接周转。总 gate 最长 65 秒；通过标准是 `{P_pre,P0,P30,P60}` distinct count=1、三轮匹配 payload 全收、连接认证 / LISTEN ACK / sender `pg_notify` SQL 均成功且没有 `42501 insufficient_privilege`。endpoint-class 证据记录脱敏 artifact / revision、采集时间和 reviewer，只对同 endpoint / role / deployment revision 有效，并在 7×24 小时后或任一三元组变化时（取更早者）过期；过期必须重跑。输出不得包含实际 PID、URL、用户名或密码。任一证据缺失 / 过期、检测到 transaction pooling 或 session 不稳定时，部署必须保持 realtime=false；本规格不静默新增第二个数据库秘密，须先经 Owner 批准 delta，再接入独立 direct / session URL。

故障切换必须是原子的：lifecycle 先把当前 generation 从 `healthy` CAS 为 `degraded`，使新 stream 立即 503；再对 hub 当前连接快照恰好一次发送 `stream.degraded(listener_unavailable, retryAfterMs)` 并结束。旧 generation 的迟到 callback 必须被忽略；只有新 `pg.Client` 完成 LISTEN 与 probe 后，新的 generation 才可切回 healthy。

### 6.3 Local SSE hub

hub 的职责仅为当前进程的连接注册、用户路由、heartbeat、限额、缓冲检查和 drain：

- 数据结构按 `recipientUserId → connectionId → connection` 分组；connectionId 是内存随机标识，不下发秘密。
- hub entry 有 `initializing | ready | closing` 状态；`registerAndReady` 在同一同步调用栈内完成登记、写 `stream.ready`、切为 ready，期间禁止 await / Promise / I/O yield。
- 业务广播只写 `ready` entry；极小 initializing 窗口内的 hint 可跳过，因为 ready 后 REST 同步覆盖。这样字节流上 `stream.ready` 必定先于 `notification.created`。
- `req.close`、`res.close`、写异常、token expiry、listener degraded、慢消费者、shutdown 均必须幂等清理计数与 timer。
- 使用一个共享 heartbeat scheduler 遍历连接；不得为每连接无限创建无监管 interval。
- 任一写入前检查 `res.writableEnded`、`res.destroyed` 和 `res.writableLength`。
- 写前 `writableLength > MAX_BUFFER_BYTES` 或任一 `res.write(...) === false` 即判定 slow consumer：不再排队业务事件，幂等清理并定向 destroy 该 response；只有仍可安全写时才尽力发送 degraded，重连靠 REST。
- 每用户、每 IP、全局 cap 在写出 200 headers 前判定；超限返回 429 + `Retry-After`。

### 6.4 SSE HTTP API

#### 请求

~~~http
GET /api/notifications/stream HTTP/1.1
Accept: text/event-stream
Authorization: Bearer <15-minute-access-token>
Cache-Control: no-cache
~~~

禁止：

- `?access_token=...`、`?refresh_token=...`、临时 SSE token query；
- 依赖 HttpOnly refresh cookie 直接鉴权 SSE；
- 使用原生 EventSource 绕过 Bearer Header。

#### 200 响应头

~~~http
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
~~~

以上 SSE headers 只适用于成功的 200 stream；建连前 4xx / 5xx 保持既有 JSON error contract，不伪装为 event-stream。响应建立后必须立即 flush headers 和 `stream.ready`。每 20 秒写 SSE comment heartbeat；heartbeat 不产生业务事件或 Toast。

#### 建连状态码

| 状态 | 条件 | 客户端行为 |
| --- | --- | --- |
| 200 | 鉴权、开关、listener、cap 均通过 | 进入 healthy；ready 后立即 REST 同步 |
| 401 | 缺失 / 无效 / 过期 access token | 复用单飞 refresh 一次；成功换 token 重连，终局失败登出 |
| 403 | 用户状态不允许 | 当前用户会话停止重连，交给既有 auth 流程处理 |
| 404 | 总通知或 realtime 开关关闭 | 本会话停止 SSE 重试，保持 polling |
| 429 | 建连速率或连接 cap 超限 | 尊重 Retry-After，再指数退避；保持 polling |
| 503 | listener degraded 或实例 draining | 指数退避，最大 30 秒；保持 polling |

### 6.5 SSE 事件协议 v1

所有 JSON 均为单行 UTF-8；服务端 serializer 负责换行和 JSON escaping。控制事件不设置 `id:`；业务事件的 `id:` 等于十进制 Notification ID。

#### `stream.ready`

~~~text
event: stream.ready
data: {"v":1,"serverTime":"2026-08-09T12:00:00.000Z","heartbeatMs":20000,"resyncRequired":true}

~~~

语义：连接已注册，本事件不代表客户端已同步。收到后必须立即刷新当前用户的权威数据。

#### `notification.created`

~~~text
id: 123
event: notification.created
data: {"v":1,"notification":{"id":123,"eventType":"order.created_merchant","category":"order","title":"新的待处理订单","body":"买家兑换了商品，请尽快处理","level":"info","deeplink":"/merchant/orders/88","relatedOrderId":88,"createdAt":"2026-08-09T12:00:00.000Z","deliveryMode":"manual_service","deliveryKind":"manual"}}

~~~

只允许以下字段：

- `id`、`eventType`、`category`、`title`、`body`、`level`、`deeplink`、`relatedOrderId`、`createdAt`；
- 可选、经过 allowlist 投影的 `deliveryMode` 与 `deliveryKind`。

禁止转发数据库 `payload` 整体、`dedupeKey`、recipientUserId、邮箱、卡密、交付 content、structured values、附件对象键 / URL、Webhook secret 或内部错误。

唯一安全 projection 由后端 `realtime/protocol.ts` 定义并被 listener / 测试复用：

| 字段 | 约束 | 无效行为 |
| --- | --- | --- |
| `id`、`relatedOrderId` | id 为正安全整数；relatedOrderId 为正安全整数或 null | 丢弃 envelope，等待 REST |
| `eventType` | 1–80 个 ASCII 字母 / 数字 / dot / underscore / hyphen；已知 10 项用 typed constants，未知仍可安全透传 | 丢弃 |
| `category` | `order|provision|booking|inventory|system` | 丢弃 |
| `title` | 必填纯文本，1–100 Unicode code points | 丢弃，不截断 |
| `body` | 必填纯文本，1–500 Unicode code points | 丢弃，不截断 |
| `level` | `info|success|warning|critical` | 丢弃 |
| `deeplink` | 1–512 字符的站内相对路径，必须以单个 `/` 开头，禁止 `//`、scheme、userinfo | 丢弃 |
| `createdAt` | 有效 ISO-8601 UTC 字符串 | 丢弃 |
| `deliveryMode` | 可选 `manual_service|instant_inventory|instant_fixed` | 删除该可选字段 |
| `deliveryKind` | 可选 `manual|instant|faka|auto` | 删除该可选字段 |

JSON serializer 负责换行转义；React 只能以文本节点显示 title / body，禁止 `dangerouslySetInnerHTML`。SSE frame `id:` 和 `data.notification.id` 不相等时，客户端不得发布业务事件，只触发权威重同步。

#### `auth.expiring`

~~~text
event: auth.expiring
data: {"v":1,"expiresAt":"2026-08-09T12:15:00.000Z"}

~~~

连接建立时若 token 剩余时间 ≤ 60 秒则立即发送；否则在到期前 60 秒发送一次。到期时服务端必须结束响应，不能让已过期 token 保持无限连接。

#### `stream.degraded`

~~~text
event: stream.degraded
data: {"v":1,"reason":"listener_unavailable","retryAfterMs":1000}

~~~

`reason` 固定枚举：`listener_unavailable`、`server_shutdown`、`slow_consumer`。发送后服务端结束流；无法写出该事件时直接结束同样合法。

#### heartbeat

~~~text
: heartbeat 2026-08-09T12:00:20.000Z

~~~

### 6.6 排序、去重与重连

1. PostgreSQL sequence 可能在事务 A 先分配 ID，但事务 B 先提交；因此 101 可能先于 100 到达。
2. 客户端维护当前用户作用域、容量 512 的 LRU exact-ID Set；只有仍在该窗口中的 exact ID 才丢弃。
3. 客户端不得维护“已见最大 ID”并丢弃更小 ID。
4. P0 不用 `Last-Event-ID` 回放。重连收到 ready 后重取 REST；历史事件不补 Toast。
5. 多实例、listener 重连或网络重试造成同一 ID 重复时，只触发一次 live Toast；REST 请求可被 300ms scheduler 合并。
6. 用户切换 / logout 时 abort stream、清空 exact-ID Set、清空待执行 invalidation 和旧用户通知状态。

P0 客户端不主动发送 `Last-Event-ID`，服务端即使收到该 Header 也必须忽略其回放 / 授权语义，不接受等价 query 参数。512-ID LRU 淘汰后极晚重复可能再次成为 live hint，这是有界内存的明确权衡；它最多造成一次额外刷新 / Toast，不能影响数据库幂等或 UI 最终状态。

---

## 7. 前端契约

### 7.1 Stream manager 状态机

~~~text
idle
  └─ login ─► connecting
                 ├─ 200 + ready ─► healthy
                 ├─ 401 ─► refresh once ─► connecting | logged_out
                 ├─ 404 ─► polling_only
                 └─ 429 / 503 / network ─► degraded ─► backoff ─► connecting

healthy
  ├─ notification.created ─► coalesced invalidation
  ├─ auth.expiring ─► single-flight refresh + reconnect
  ├─ close/error ─► degraded
  └─ logout/user change ─► abort + idle
~~~

完整转换表：

| 当前状态 / 输入 | 原子动作 | 下一状态 / timer |
| --- | --- | --- |
| `idle` + login / token available | 清旧资源；立即 fetch stream | `connecting` |
| `connecting` + 200 / ready | 取消 backoff 与 30 秒 fallback；发布 all.visible；启动 5 分钟校准 | `healthy` |
| `connecting` + 401 | 对该请求携带的 stale token 最多调用一次既有 single-flight refresh | 成功 `connecting`；终局 400/401 `idle + logout`；瞬时失败 `degraded` |
| `connecting` + 403 | abort；不轮询受保护资源 | `auth_blocked`，仅 user / token 变化或整页重载解除 |
| `connecting` + 404 | 停止 SSE backoff；启动 30 秒 fallback | `polling_only`，仅 user / token 变化或整页重载重新探测 |
| `connecting` + 429 / 503 / network | 解析 Retry-After 为退避下限；确保只有一个 backoff 和一个 fallback owner | `degraded` |
| `healthy` + notification | 校验 frame / exact ID；发布合并 topic；保持校准 timer | `healthy` |
| `healthy` + auth.expiring | 在旧 stream 仍打开时调用 single-flight refresh | 成功先 abort 旧流再 `connecting`；终局失败 logout；瞬时失败保持旧流直到 EOF / expiry |
| `healthy` + degraded event / EOF / read error | abort reader；取消 5 分钟校准；立即 all.visible；启动 30 秒 fallback 和唯一 backoff | `degraded` |
| `degraded` + backoff 到期 | 清该 timer，发起一次新 fetch | `connecting` |
| 任意状态 + accessToken 变更 | abort 旧流与 backoff，保留用户作用域数据，立即新 fetch | `connecting` |
| 任意状态 + userId 变更 / logout | abort fetch，清全部 timer / LRU / pending topics / 旧用户通知状态 | 新用户 `connecting`；logout `idle` |

`NotificationRealtimeBridge` 是 fetch、backoff、fallback 与校准 timer 的唯一 owner。状态转换函数必须先清理离开状态的 timer，再创建进入状态的 timer；不得由页面组件各自重连。

实现要求：

- 使用浏览器 `fetch` + `ReadableStream` + `TextDecoder`，携带 Authorization 和 AbortSignal。
- 自有解析器只实现受控 SSE v1，但必须正确处理 CRLF、任意 chunk 边界、多行 data、comment、未知字段和最大 64KB frame。
- 重连退避为 1s、2s、4s、8s、16s、30s，±20% jitter；收到 ready 后重置。
- 任一时刻同一 Tab / 用户最多一个 active fetch；所有重连路径先 abort 旧请求。

### 7.2 权威同步调度

新增 typed invalidation topic：

- `notifications`：未读数、打开中的通知中心预览、消息页当前 filter 第一页；
- `buyer.orders`：买家订单列表、attention count、打开中的相关订单详情；
- `merchant.orders`：商家订单列表、打开中的相关订单对话框；
- `merchant.stats`：商家工作台统计；
- `all.visible`：连接 ready、回前台和轮询校准时，所有当前挂载订阅者重取。

调度规则：

1. `notification.created` 在 300ms 窗口内按 topic 合并；同 topic 同时只有一个 in-flight reload，完成后若期间再次失效则再跑一次。
2. `stream.ready`、重连、`visibilityState=visible` 触发 `all.visible`，不展示 Toast。
3. 非 healthy / polling_only：每 30 秒触发 `all.visible`。
4. healthy：每 5 分钟触发一次安全校准，防止无错误但 hint 丢失。
5. 页面未挂载时不预取其私有列表；全局未读数始终更新。
6. 通知列表实时重载第一页时替换第一页并按 ID 去重；不得把新记录 append 到历史分页尾部或破坏当前 filter。

### 7.3 当前事件失效矩阵

| eventType | notifications | buyer.orders / 当前详情 | merchant.orders | merchant.stats | live Toast |
| --- | --- | --- | --- | --- | --- |
| `order.created_merchant` | 是 | 否 | 是 | 是 | 商家可见 Tab：info |
| `order.processing_buyer` | 是 | 是 | 否 | 否 | 买家可见 Tab：info |
| `order.delivered_buyer` | 是 | 是 | 否 | 否 | manual / faka / auto：success；instant：静默 |
| `order.refunded_buyer` | 是 | 是 | 否 | 否 | 买家可见 Tab：info |
| `order.refunded_merchant` | 是 | 否 | 是 | 是 | 商家可见 Tab：warning / info |
| `order.disputed_buyer` | 是 | 是 | 否 | 否 | 买家可见 Tab：warning |
| `order.disputed_merchant` | 是 | 否 | 是 | 是 | 商家可见 Tab：warning |
| `order.dispute_resolved_buyer` | 是 | 是 | 否 | 否 | 买家可见 Tab：info |
| `order.dispute_resolved_merchant` | 是 | 否 | 是 | 是 | 商家可见 Tab：info |
| `order.closed_buyer` | 是 | 是 | 否 | 否 | 买家可见 Tab：info |
| 未知未来事件 | 是 | 否 | 否 | 否 | 默认不 Toast |

Toast 文案直接使用已脱敏 Notification title/body；只在 `document.visibilityState === 'visible'` 且事件是本连接首次 live 收到时展示。`stream.ready`、polling 和安全校准不得补弹历史通知。

### 7.4 页面行为

- `Layout`：用 realtime bridge 替换现有独立 30 秒未读 useEffect；禁止保留两套并行 interval。
- `AnnouncementCenter`：消息 Tab 打开时收到 notifications invalidation，重载最新 5 条；公告数据与待确认优先级不变。
- `NotificationsPage`：当前 filter 重载第一页；正在 load-more 时不得覆盖或重复历史页。
- `OrdersPage`：重载 100 条列表、重算 attention；若 `selectedOrder.id === relatedOrderId`，并行重取详情。
- `MerchantDashboardPage`：仅在 dashboard / orders Tab 挂载时重取 stats；orders Tab 还按当前 page / status / sort 重取列表。相关订单对话框打开时刷新对应详情或安全关闭陈旧动作。
- 未打开页面不因事件发出额外订单 / merchant REST 请求。
- realtime / polling 触发的是后台刷新：保留现有数据，不切回整页 skeleton；单次后台失败保留旧值、记录诊断并等待下一次校准，不连续弹错误 Toast。

---

## 8. 配置、健康与可观测性

### 8.1 新配置

| 环境变量 | 类型 | 默认值 | 校验范围 / 语义 |
| --- | --- | --- | --- |
| `NOTIFICATION_REALTIME_ENABLED` | boolean | `false` | 只接受 `true|false`；true 要求 NOTIFICATION_ENABLED=true |
| `NOTIFICATION_REALTIME_HEARTBEAT_MS` | integer ms | `20000` | 5000–60000 |
| `NOTIFICATION_REALTIME_MAX_CONNECTIONS_PER_USER` | integer | `5` | 1–20 |
| `NOTIFICATION_REALTIME_MAX_CONNECTIONS_PER_IP` | integer | `20` | 1–200 |
| `NOTIFICATION_REALTIME_MAX_CONNECTIONS` | integer | `1000` | 1–100000 |
| `NOTIFICATION_REALTIME_MAX_BUFFER_BYTES` | integer bytes | `65536` | 16384–1048576 |
| `NOTIFICATION_REALTIME_CONNECT_RATE_LIMIT_MAX` | integer | `30` | 1–1000，每个 canonical client IP / 固定 60 秒 |
| `NOTIFICATION_REALTIME_SHUTDOWN_GRACE_MS` | integer ms | `5000` | 1000–9000，必须小于现有 10 秒强退 |

所有值进入 `server/.env.example`、根 `.env.example`、`docker-compose.prod.yml` 和配置 schema；不得把 channel、JWT、数据库 URL 复制成新秘密。

解析契约：

- 复用现有 Zod env schema 风格；unset 或空字符串视为未配置并采用上表默认值。
- boolean 除精确小写 `true` / `false` 外均非法；integer 必须是十进制整数字符串并落在闭区间内。
- 任何类型 / 范围错误在 config module 初始化时、`app.listen` 和 listener 启动前导致进程非零退出；不得静默 clamp 或回退默认值。
- realtime=true / notification=false 的跨字段 guard 在 Zod parse 后、导出 config 前执行，所有环境一致；固定错误包含两个变量名并 `process.exit(1)`。
- 已存在的 shell / container process env 优先于 dotenv 文件；本规格不增加第二套 config source，也不允许运行时热改 env。

### 8.1.1 canonical client IP

连接 cap / limiter 只使用 Express 在现有 `app.set('trust proxy', config.trustProxy)` 后得到的 `req.ip`，不得自行读取第一个 `X-Forwarded-For`。受支持拓扑：

- 浏览器 → bundled Nginx → Express：`TRUST_PROXY=1`；
- 浏览器 → host Caddy → bundled Nginx → Express：`TRUST_PROXY=2`。

Express 端口不得直接暴露公网；Caddy / Nginx 必须覆盖或追加可信链，客户端自带的伪造 XFF 不得成为 canonical IP。部署检查必须按实际拓扑验证 hop 数，并分别测试伪造 XFF 不绕过 cap、多个真实客户端不被错误合并。

### 8.2 Feature flag 行为矩阵

| NOTIFICATION_ENABLED | REALTIME_ENABLED | REST 通知 API | stream | 写 Notification | pg_notify |
| --- | --- | --- | --- | --- | --- |
| false | false | 404 | 404 | 否 | 否 |
| false | true | **配置错误，拒绝启动** | 不适用 | 不适用 | 不适用 |
| true | false | 正常 | 404 | 是 | 否 |
| true | true，listener healthy | 正常 | 200 SSE | 是 | 新插入时是 |
| true | true，listener degraded / draining | 正常 | 503 | 是 | 数据库可用时仍可发 hint；客户端靠 polling |

### 8.3 Readiness 与 shutdown

readiness 的 `checks` 增加：

- `notificationRealtime: disabled | ok | degraded | draining`。

`degraded` 不单独令核心 API unready；`draining` 必须令 readiness 503。shutdown 顺序固定：

1. 第一次 signal 启动现有 10 秒 force-exit timer，并以 compare-and-set 原子标记 draining；重复 signal 只记录，不启动第二套关闭流程。
2. 立即调用 `server.close` 停止接受新 TCP / HTTP；保存其 completion promise，但不等待才执行下一步。stream controller 同时因 draining 对竞态新建连返回 503。
3. 同步停止所有 cron / background producer，避免关闭期继续生成业务事务。
4. hub 对连接快照恰好一次写 `stream.degraded(server_shutdown)` 并结束；到 `SHUTDOWN_GRACE_MS` 仍未结束的 response 定向 destroy。
5. 停止 listener probe / reconnect，关闭当前 `pg.Client`；迟到 generation callback 无效。
6. 等待 `server.close` completion，确保已在途普通 HTTP handler 完成；然后 quit Redis、清进程 cache、`prisma.$disconnect`。
7. 清 force timer，按 HTTP / dependency close 结果退出 0 或 1；无论配置如何，总耗时不得突破 10 秒。

hub、listener、server-close promise、cron stop、Redis stop 与 Prisma disconnect 均须幂等。不得在普通 HTTP handler 尚未结束时先断 Prisma。

### 8.4 Metrics

必须新增、且不得带 userId / orderId / IP / deeplink / title：

| 指标 | 类型 | 有界标签 |
| --- | --- | --- |
| `notification_realtime_listener_up` | Gauge | 无 |
| `notification_realtime_connections` | Gauge | 无 |
| `notification_realtime_pg_messages_total` | Counter | `outcome=routed|invalid|no_subscriber|not_found|query_error|probe_error` |
| `notification_realtime_sse_events_total` | Counter | `event=ready|notification|auth_expiring|degraded|heartbeat`、`outcome=sent|dropped` |
| `notification_realtime_disconnects_total` | Counter | `reason=client|token_expired|listener|shutdown|slow|write_error` |
| `notification_realtime_connection_rejections_total` | Counter | `reason=rate|user_cap|ip_cap|global_cap|unavailable|draining` |
| `notification_realtime_delivery_lag_seconds` | Histogram | 无；createdAt 到 local write 的近似值 |

结构化日志可含 event 名、notificationId、recipientUserId、reason 和 requestId；不得含 Bearer、cookie、PG 原 payload、通知正文、交付数据或数据库 URL。

### 8.5 LISTEN 广播放大观测与 P1 触发线

本节对应 D-RT-25 / CHK-P1-005；它不属于首次发布 P0 Gate。

每个收到的 NOTIFY 在 `notification_realtime_pg_messages_total` 中必须恰好记录一个消息终态 outcome：安全投影存在并进入本地广播路径为 `routed`，其余为 `invalid|no_subscriber|not_found|query_error`；`probe_error` 是连接探测结果，不计入消息速率。由现有指标计算：

- `active_listener_instances = sum(notification_realtime_listener_up)`；
- `cluster_listener_wakeups_per_second = sum(rate(notification_realtime_pg_messages_total{outcome=~"routed|invalid|no_subscriber|not_found|query_error"}[5m]))`，该值已经包含“实例数 × hint rate”的广播倍数；
- `routable_wakeups_per_second = sum(rate(notification_realtime_pg_messages_total{outcome=~"routed|no_subscriber"}[5m]))`；
- 仅当 `routable_wakeups_per_second > 0` 时，`no_subscriber_ratio = no_subscriber rate / routable_wakeups_per_second`；零分母时记为 unavailable，不得按 0 或 1 代填。

满足任一条件即建立独立 P1 规格，评估按 recipient hash 分 channel、专用 broker 或其他路由层；它只是设计评估触发器，不自动授权改架构：

1. 已批准容量计划或部署 / autoscaling manifest 的 desired / max listener replicas ≥32，证据记录 artifact revision、批准 Owner 与日期；或实际 `active_listener_instances >= 32`；
2. 基于同一组 5 分钟 rate recording rules，`cluster_listener_wakeups_per_second >= 1000`、`routable_wakeups_per_second > 0` 且 `no_subscriber_ratio >= 0.90`，告警规则显式 `for: 15m`。

`invalid|not_found|query_error` 不进入 no-subscriber 分母，须在运维面板单独显示错误率，避免异常流量掩盖或夸大广播浪费。

未达到阈值时不为假设规模引入 Kafka / Redis；达到阈值也不得把 Redis Pub/Sub 误当可靠事实源，REST convergence 语义保持不变。

---

## 9. 领域规则与不变量

| ID | 不变量 |
| --- | --- |
| NRT-001 | Notification 行是唯一事实源；SSE 不得成为前端永久缓存或后端第二消息库 |
| NRT-002 | 未提交事务绝不允许产生浏览器可见事件 |
| NRT-003 | `pg_notify` 必须与 Notification insert 处于同一 transaction；SQL 异常必须使包含订单 / 履约与 Notification 的业务事务整体回滚，禁止吞错或 commit 后补发 |
| NRT-004 | 幂等 insert 未新增行时不发新 hint |
| NRT-005 | 任何代码不得在订单 transaction 内直接调用 local hub / response write |
| NRT-006 | PG payload 只能是版本和两个整数 ID |
| NRT-007 | listener 广播前必须按 ID + recipient 重查主库 |
| NRT-008 | SSE 只能路由到当前 authenticated userId 的本地连接 |
| NRT-009 | SSE payload 的敏感边界不弱于 REST；禁止整体转发 Json payload |
| NRT-010 | token 不得出现在 URL、event、metric、log、fixture snapshot |
| NRT-011 | access token 过期后连接必须终止 |
| NRT-012 | 每 Node 实例仅一条专用 LISTEN connection |
| NRT-013 | listener 不得使用业务 Prisma pool connection 执行永久 LISTEN |
| NRT-014 | listener 故障必须关闭流并触发 polling，不得保持“假 healthy” |
| NRT-015 | 所有新连接 / 重连 / 回前台必须 REST 同步 |
| NRT-016 | ID 只作身份；禁止按最大 ID 丢弃较小但后提交的事件 |
| NRT-017 | 同一 notification ID 在当前 512-ID 去重窗口内最多产生一次 live Toast |
| NRT-018 | ready / replay式同步 / polling 不产生历史 Toast |
| NRT-019 | 无 realtime 时既有 REST、轮询、公告、下单与履约功能继续可用 |
| NRT-020 | 连接 cap 和 buffer cap 必须在生产可配置且有安全默认值 |
| NRT-021 | shutdown 完成后不得遗留 listener 重连 timer、heartbeat timer 或 SSE response |
| NRT-022 | 未知 eventType 只失效 notifications，不得猜测跨域页面行为 |
| NRT-023 | 本波不得创建 / 修改 Prisma migration |
| NRT-024 | 所有实际实时 E2E 禁止 page.reload、手动 API poll 或 expect.poll 充当送达证据 |
| NRT-025 | 后台 invalidation 失败保留陈旧数据并等待重试，不得清空页面或造成错误 Toast 风暴 |
| NRT-026 | `notification.created` 的 SSE `id:` 与 `data.notification.id` 必须相等，否则客户端丢弃并降级重同步 |

---

## 10. 功能需求

| ID | 需求 |
| --- | --- |
| REQ-F-001 | Dispatcher 仅在新 Notification 插入成功时，在同事务登记版本化 PG hint |
| REQ-F-002 | 每实例 listener 能启动、校验消息、重查主库、路由给本地用户并自动重连 |
| REQ-F-003 | local hub 能注册 / 清理连接、发送协议事件、heartbeat、执行资源 cap 与 drain |
| REQ-F-004 | 提供 `GET /api/notifications/stream`，复用 authenticate + requireActiveUser |
| REQ-F-005 | stream 严格实现 v1 headers、四类事件、comment heartbeat 和状态码契约 |
| REQ-F-006 | stream 在 token 到期前提示并在到期时关闭；前端单飞 refresh 后无重叠重连 |
| REQ-F-007 | 前端 fetch SSE parser 正确处理 chunk / CRLF / comment / 多行 data / frame cap |
| REQ-F-008 | 前端按 exact Notification ID 去重并在 300ms 内按 topic 合并 invalidation |
| REQ-F-009 | ready、回前台、重连、30 秒降级轮询和 5 分钟安全校准触发权威同步 |
| REQ-F-010 | 未读角标、通知中心预览和消息页能由实时失效重取 |
| REQ-F-011 | 买家订单列表、attention 和当前相关详情能由买家事件重取 |
| REQ-F-012 | 商家订单列表、当前相关动作面板和 stats 能由商家事件重取 |
| REQ-F-013 | live Toast 遵守事件矩阵、页面可见性、exact-ID 去重和即时交付静默 |
| REQ-F-014 | logout / user change 原子 abort 旧流并清除旧用户实时状态 |
| REQ-F-015 | listener / SSE 故障自动进入 polling，恢复后重新连接并停止 30 秒 fallback |
| REQ-F-016 | 总通知与 realtime 开关组合严格遵守配置矩阵 |
| REQ-F-017 | readiness、metrics、结构化日志公开 listener / connection / lag / reject / disconnect 状态 |
| REQ-F-018 | graceful shutdown 在 5 秒内 drain SSE、停止 listener，且不突破全局 10 秒强退 |
| REQ-F-019 | Nginx / Caddy 能即时转发小 SSE event 与 heartbeat，不受 60 秒普通 API 超时影响 |
| REQ-F-020 | 双实例共享 PostgreSQL 时，写入 B 能送达连接在 A 的用户 |
| REQ-F-021 | 现有 10 个 Phase 1 eventType 全部按失效矩阵处理；未知事件安全降级 |
| REQ-F-022 | 部署配置、smoke、旧规格 superseded 链接和运维说明同步更新 |

---

## 11. 非功能需求

| ID | 需求 |
| --- | --- |
| REQ-NF-001 | healthy SSE 正常负载下，订单 API 成功响应到 UI 可见更新 P95 ≤ 2 秒、P99 ≤ 5 秒 |
| REQ-NF-002 | degraded 且 REST 健康时，UI 状态在一个 30 秒周期加请求时间内收敛，验收上限 35 秒 |
| REQ-NF-003 | 事务 rollback、实例重启、listener 断开、PG 重启均不得造成永久错误状态或幽灵通知 |
| REQ-NF-004 | 用户隔离与敏感数据边界必须不低于现有通知 REST |
| REQ-NF-005 | 单慢消费者不得拖慢其他连接；内存增长受全局连接与每连接 buffer 上限约束 |
| REQ-NF-006 | realtime 关闭或回滚时，下单、履约、通知 REST 和现有 UI 不发生行为回归 |
| REQ-NF-007 | 新旧前端 / 后端滚动部署可兼容：旧前端忽略新 endpoint，新前端在 404 时 polling |
| REQ-NF-008 | 指标标签 cardinality 有界，日志 / trace 不包含 token、正文或交付秘密 |
| REQ-NF-009 | 不新增 Prisma migration，不改变现有 REST response schema 与 announcement 语义 |
| REQ-NF-010 | 后端 / 前端 build、现有通知单测 / 集成 / E2E 和新增专用门禁全部通过 |

---

## 12. 验收标准

| ID | Given / When / Then |
| --- | --- |
| AC-RT-001 | Given 商家已打开 orders Tab 且 stream healthy；When 买家创建 manual_service 订单；Then 不 reload、不手工 poll，2 秒目标 / 5 秒硬上限内订单、stats、未读角标出现 |
| AC-RT-002 | Given 买家已打开订单页及目标详情；When 商家 processing 后 deliver；Then 列表、attention、详情和通知在硬上限内更新，交付 secret 不出现在 SSE |
| AC-RT-003 | Given 订单事务插入 Notification 后故意抛错；When transaction rollback；Then无 Notification、无 PG commit hint、无 SSE 事件 |
| AC-RT-004 | Given 同一 dedupe 事件并发执行两次；Then DB 仅一行、最多一个 live Toast，接口不 5xx |
| AC-RT-005 | Given 两个 backend 实例共享 PostgreSQL，stream 连 A；When 订单写 B；Then A 的 listener 送达对应本地用户 |
| AC-RT-006 | Given 用户 A / B 同时连接；When 只为 B 创建通知；Then A 不收到 event，A 猜 B ID / Header 也无法读取 |
| AC-RT-007 | 无 Bearer / 过期 Bearer 建连返回 401；有效 token 在 expiring 后刷新并重连；旧连接到期已关闭且无双连接泄漏 |
| AC-RT-008 | 在“注册连接—发送 ready—客户端 REST sync”边界并发提交事件；Then 字节流 ready 必定先于 notification，允许重复 reload，但最终状态不遗漏 |
| AC-RT-009 | 人工制造 ID 101 先到、100 后到；Then 两者都被处理，证明没有 maxSeen 过滤 |
| AC-RT-010 | listener 连接断开 / PostgreSQL 重启；Then 现有流 degraded 并关闭、polling 生效，listener 恢复后重连和 REST 同步 |
| AC-RT-011 | 阻断 stream 或令其持续 503；Then 页面不刷新也在 35 秒内通过 fallback 更新订单和未读 |
| AC-RT-012 | 打开通知中心消息 Tab / 消息页；When 新通知到达；Then 最新列表按当前 filter 重载，分页无重复 / 错位 |
| AC-RT-013 | instant order 直接 delivered；Then 买家状态和消息更新但无打扰性 Toast，商家无 new-order event |
| AC-RT-014 | realtime=false / notifications=true；Then REST 正常、stream 404、客户端 polling；非法 true/false 组合拒绝启动 |
| AC-RT-015 | 超用户 / canonical IP / 全局 cap 或建连速率；Then headers 前返回 429、计数不泄漏、伪造 XFF 不绕过、已有连接不受影响 |
| AC-RT-016 | 慢消费者不读数据并触发 buffer cap；Then 仅该流被断开，快消费者继续收，重连后 REST 收敛 |
| AC-RT-017 | 经 Nginx + Caddy 发一个小事件 / heartbeat；Then raw client 当次即时收到，响应头正确，不聚合到 60 秒 |
| AC-RT-018 | SIGTERM 时有活跃 SSE；Then readiness 先 503、连接收到 shutdown / EOF、5 秒内 drain、无 timer / listener 泄漏 |
| AC-RT-019 | metrics 抓取显示 listener、连接数、送达延迟、拒绝 / 断开；Then 无 userId / orderId / token / 正文标签 |
| AC-RT-020 | logout 或切换用户后触发旧用户事件；Then 旧流已 abort，新用户状态与 Toast 不被污染 |
| AC-RT-021 | 30 秒内 burst 100 条同 topic 通知；Then exact ID 均记录，REST reload 被 300ms 合并，无请求风暴 |
| AC-RT-022 | 旧前端 + 新后端、再新前端 + realtime=false、再 realtime=true 滚动；Then 各阶段可用且可关闭开关回滚 |
| AC-RT-023 | production-like smoke 验证 auth、ready、event、fallback 与 flag；不得在功能关闭时静默 skip |
| AC-RT-024 | 对 SSE envelope 注入 delivery content、structured value、对象键、外部 URL；Then serializer 输出均不含这些字段 |
| AC-RT-025 | 使用专用 staging 账号 / 商品 fixture，以上游订单 API 收到 2xx 为起点、目标用户 DOM 首次出现目标 orderId / status / unread 为终点采集至少 100 个独立样本；Then P95 / P99 达到 REQ-NF-001，并保存环境与结果 |
| AC-RT-026 | 公告有待确认且事务消息同时到达；Then 单铃铛总数更新，但公告强制 Tab / 确认语义不变 |
| AC-RT-027 | 完整 build、现有通知回归、新专用 suite 与 migration drift 检查通过；Then schema 无新增 migration |
| AC-RT-028 | Given realtime=true、真实 listener 已获 LISTEN ACK、订单 / Notification 使用专用真实 transaction，tx proxy 恰好一次捕获参数化 `pg_notify` 的唯一 ID 对后抛 sentinel，root call / proxy miss 即失败；Then callback reject，独立 client 查询均无行且该 ID 对完整 2 秒无 hint；无注入 happy path 按已提交 ID 对在 commit 后 5 秒内恰好一个 v1 hint；listener 未 ready、无唯一 ID 或超时均失败 |
| AC-RT-029 | Given 未过期的 endpoint / role / deployment-revision 模式证据；When actual-role gate 最长 65 秒，取得 P_pre、LISTEN ACK 后 P0、t≈30/60 probe 的 P30/P60，独立 sender 在 t≈0/30/60 各发唯一 payload（每轮 5 秒超时），另有 4 个辅助连接各跑 10 个短事务；Then current_user 与声明角色匹配、PID distinct count=1、三轮全收、CONNECT/LISTEN/参数化 pg_notify 无权限错误且不泄密；证据 7×24 小时或三元组变化即过期，任一失败阻断启用 |

---

## 13. 依赖与假设

| ID | 内容 |
| --- | --- |
| ASM-RT-001 | 生产使用 PostgreSQL 16 或兼容 LISTEN/NOTIFY 的受支持版本 |
| ASM-RT-002 | 所有 API 实例连接同一个 PostgreSQL primary；`DATABASE_URL` 通过 CHK-INF-007 证明支持 session 级 LISTEN，实时重查不走延迟副本 |
| ASM-RT-003 | 生产代理允许长 HTTP/1.1 response，FD / memory 能支持配置的 1000 实例连接 |
| ASM-RT-004 | Access Token 保持有 exp 的 15 分钟 JWT，Refresh Token 单飞逻辑保持不变 |
| ASM-RT-005 | 当前通知 eventType 和 payload 均由可信后端模板生成，但 SSE 仍执行字段 allowlist |
| ASM-RT-006 | 本波无需跨地域严格顺序、跨数据中心通知或离线浏览器推送 |

---

## 14. 风险与处理

| 风险 | 触发 | 处理 / 回滚 |
| --- | --- | --- |
| NOTIFY 提示丢失 | listener 重连、PG failover、队列异常 | 关闭流 → 30 秒 polling；ready / 5 分钟校准重新同步 |
| sequence 与 commit 乱序 | 并发 transaction | exact-ID Set，不用 maxSeen；REST 为权威 |
| 代理缓冲 / 断流 | Nginx/Caddy 默认配置 | exact location、no buffering、heartbeat、raw staging smoke |
| token 过期后长连接越权 | 只在建连时鉴权 | expiring + expiry timer 强制关闭 |
| 多标签连接膨胀 | 用户开多个 Tab | 单用户 cap=5、可见 Tab Toast；后续 leader election |
| 慢客户端导致内存增长 | 网络极慢 / 恶意不读 | 64KiB cap、主动断开、全局 cap |
| trust proxy hop 配错 | 直连 Nginx 与 Caddy+Nginx 拓扑混用 | 部署按拓扑固定 1 / 2 hops，伪造 XFF 与多客户端集成测试 |
| 新 `pg` 连接配置与 Prisma 差异 | DATABASE_URL 参数 / TLS | 专用启动集成测试；失败仅 realtime degraded，核心 API 保持可用 |
| PgBouncer transaction pooling 不保留 LISTEN session | `DATABASE_URL` 指向 transaction pool 或 backend PID 不稳定 | CHK-INF-007 阻断启用并保持 realtime=false；独立 direct / session URL 必须另经 Owner delta，不得静默复用 |
| realtime 代码影响订单事务 | `pg_notify` 权限 / SQL / 连接错误 | O-RT-08 明确接受整体 rollback；真实角色预检 + 静态 channel + 小 payload + flag canary；错误率上升立即关闭开关并重启，禁止改成 commit 后广播 |
| LISTEN 广播放大 | 实例数与 hint rate 同时增长，多数实例无本地订阅 | 使用 8.5 指标阈值触发独立 P1 broker / sharding 评估；P0 不预埋组件 |
| 页面 burst 刷新 | 短时多订单 | 300ms topic 合并 + 单飞 reload |
| 新旧规格冲突 | 旧文档仍写 SSE Phase 3 | 实施任务同步 superseded 链接；本 README 明确覆盖范围 |

---

## 15. Owner 批准记录

Owner 于 2026-08-09 明确声明：“批准 SPEC-NOTIFY-RT-001 v0.2.0 的 O-RT-01~08，同意切换为 Frozen for Implementation。”本记录只冻结规格，不代表任一实施 / QA Checklist 已通过。Frozen 后若改变任一 O-RT / D-RT / NRT / REQ / AC，必须先退回 Draft 并重新批准。

- [x] O-RT-01：认可 SSE + PostgreSQL LISTEN/NOTIFY + REST 收敛，而非 WebSocket / Redis。
- [x] O-RT-02：认可 P95 2 秒、P99 / 硬验收 5 秒和 fallback 35 秒。
- [x] O-RT-03：认可 P0 每 Tab 一连接、每用户 5 条上限，暂不做跨 Tab leader。
- [x] O-RT-04：认可 P0 不做 Last-Event-ID 回放，断线以 REST 同步恢复。
- [x] O-RT-05：认可新增后端 `pg` 依赖、零 Prisma migration、前端自有受控 SSE parser。
- [x] O-RT-06：认可 realtime 默认关闭及后端 / 代理 / 前端 / flag 的发布顺序。
- [x] O-RT-07：确认此规格只改变“抵达方式”，不新增 / 删除通知事件。
- [x] O-RT-08：认可 realtime=true 时 `pg_notify` SQL 与业务事务强耦合：任何执行异常均使订单 / 履约与 Notification 整体回滚，禁止吞错或移到 commit 后；启用前必须以实际数据库角色和真实 PostgreSQL 验证权限、静态 channel、小 payload 与 session。

---

## 16. 需求追溯矩阵

| 需求 | Plan | Owner Tasks | Implement | Checklist | 验收 |
| --- | --- | --- | --- | --- | --- |
| REQ-F-001 | Phase B | T-BE-002、T-QA-001 | I-RT-003、010 | CHK-BE-003~005、CHK-QA-003 | AC-RT-003~004、028 |
| REQ-F-002 | Phase C / F | T-BE-003、T-INF-002 | I-RT-004、009 | CHK-BE-006~010、CHK-INF-007 | AC-RT-005、010、029 |
| REQ-F-003 | Phase C | T-BE-004 | I-RT-005 | CHK-SSE-006~010 | AC-RT-015~016、018 |
| REQ-F-004 | Phase C | T-BE-004 | I-RT-005 | CHK-SSE-001、005、CHK-SEC-001~002 | AC-RT-006~007 |
| REQ-F-005 | Phase A / C | T-BE-001、T-BE-004 | I-RT-002、005 | CHK-SSE-002~005 | AC-RT-008、017 |
| REQ-F-006 | Phase C / D | T-BE-004、T-FE-001 | I-RT-005、007 | CHK-SEC-003~005、CHK-FE-004 | AC-RT-007 |
| REQ-F-007 | Phase D | T-FE-001 | I-RT-007 | CHK-FE-001~003 | AC-RT-007~010 |
| REQ-F-008 | Phase D | T-FE-002 | I-RT-007 | CHK-FE-005~007、CHK-FE-014 | AC-RT-009、021 |
| REQ-F-009 | Phase D | T-FE-002 | I-RT-007 | CHK-FE-008~010 | AC-RT-008、010~011 |
| REQ-F-010 | Phase E | T-FE-003 | I-RT-008 | CHK-UI-001~004、013 | AC-RT-012、026 |
| REQ-F-011 | Phase E | T-FE-004 | I-RT-008 | CHK-UI-005~007、013 | AC-RT-002 |
| REQ-F-012 | Phase E | T-FE-005 | I-RT-008 | CHK-UI-008~010、013 | AC-RT-001 |
| REQ-F-013 | Phase D / E | T-FE-002、T-FE-003、T-FE-004、T-FE-005 | I-RT-007~008 | CHK-FE-011~012、CHK-UI-011 | AC-RT-013、020 |
| REQ-F-014 | Phase D | T-FE-001、T-FE-002 | I-RT-007 | CHK-FE-013 | AC-RT-020 |
| REQ-F-015 | Phase C / D | T-BE-003、T-FE-002 | I-RT-004、007 | CHK-BE-009、CHK-FE-004、009 | AC-RT-010~011 |
| REQ-F-016 | Phase A / F | T-BE-001、T-INF-002 | I-RT-002、009 | CHK-CFG-001~004 | AC-RT-014 |
| REQ-F-017 | Phase F | T-BE-005 | I-RT-006 | CHK-OPS-001~005 | AC-RT-019 |
| REQ-F-018 | Phase F | T-BE-005 | I-RT-006 | CHK-OPS-006~007 | AC-RT-018 |
| REQ-F-019 | Phase F | T-INF-001 | I-RT-009 | CHK-INF-001~006 | AC-RT-017 |
| REQ-F-020 | Phase C / G | T-BE-003、T-QA-004 | I-RT-004、010 | CHK-QA-009~011 | AC-RT-005 |
| REQ-F-021 | Phase E / G | T-FE-003、T-FE-004、T-FE-005、T-QA-002 | I-RT-008、010 | CHK-UI-012、CHK-QA-005 | AC-RT-001~002、012~013 |
| REQ-F-022 | Phase F / G | T-INF-002、T-DOC-001、T-QA-005 | I-RT-001、009、011 | CHK-DOC-001~006、CHK-INF-007 | AC-RT-022~023、029 |
| REQ-NF-001 | Phase G | T-QA-003、T-QA-005 | I-RT-010~011 | CHK-PERF-001~003 | AC-RT-001~002、025 |
| REQ-NF-002 | Phase D / G | T-FE-002、T-QA-003 | I-RT-007、010 | CHK-FE-009、CHK-QA-013 | AC-RT-011 |
| REQ-NF-003 | Phase B / C / F / G | T-BE-002、T-BE-003、T-BE-004、T-BE-005、T-INF-002、T-QA-001、T-QA-004 | I-RT-003~006、009~010 | CHK-BE-003~004、CHK-INF-007、CHK-QA-003、006~011 | AC-RT-003、008、010、028~029 |
| REQ-NF-004 | Phase C / G | T-BE-004、T-QA-001 | I-RT-005、010 | CHK-SEC-001~009 | AC-RT-006~007、015、024 |
| REQ-NF-005 | Phase C / G | T-BE-004、T-QA-004 | I-RT-005、010 | CHK-SSE-008~010、CHK-QA-012、CHK-PERF-004 | AC-RT-015~016、021 |
| REQ-NF-006 | Phase F / G | T-INF-002、T-QA-005 | I-RT-009、011 | CHK-CFG-003、CHK-REL-001、004、CHK-QA-015~016 | AC-RT-014、022、027 |
| REQ-NF-007 | Phase F / G | T-INF-002、T-QA-005 | I-RT-009、011 | CHK-REL-002~004 | AC-RT-022 |
| REQ-NF-008 | Phase F / G | T-BE-005、T-QA-001 | I-RT-006、010 | CHK-OPS-003~005、CHK-SEC-008 | AC-RT-019、024 |
| REQ-NF-009 | Phase A / G | T-BE-001、T-DOC-001、T-QA-005 | I-RT-001~002、011 | CHK-CFG-005、CHK-REL-007 | AC-RT-026~027 |
| REQ-NF-010 | Phase G | T-QA-001~005 | I-RT-010~011 | CHK-QA-001~016 | AC-RT-023、027 |

---

## 17. 变更控制

1. Draft 阶段允许 Owner 修改决策；每次修改必须更新版本、修订记录、追溯矩阵和所有受影响任务 / checklist。
2. Frozen 后，D-RT、NRT、REQ、AC 的语义变化必须先把状态退回 Draft 并经 Owner 重新批准。
3. 实施中只允许不改变外部语义的小型实现澄清；须记录在 `implement.md` 证据台账。
4. 若基线 develop 已变化，实施 Agent 先完成 delta audit，再决定是否需要提升下一规格版本；不得静默沿用失效路径。

### 修订记录

| 版本 | 日期 | 状态 | 说明 |
| --- | --- | --- | --- |
| 0.1.0 | 2026-08-09 | Draft for Owner Review | 首版：SSE + PG commit hint + REST convergence |
| 0.2.0 | 2026-08-09 | Frozen for Implementation | Owner 批准 O-RT-01~08；冻结 NOTIFY 失败整体回滚、production-like LISTEN session gate、广播放大 P1 阈值 |
