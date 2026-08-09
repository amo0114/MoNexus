# Checklist: 订单通知实时化

| 字段 | 值 |
| --- | --- |
| 文档 ID | CHK-NOTIFY-RT-001 |
| 版本 | 0.2.0 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation — P0 / P1 实施项全部未验证** |
| 规格 | [SPEC-NOTIFY-RT-001](./spec.md) |

规则：checkbox 只能在同一 commit 上凭可重现证据勾选。代码存在、mock 通过、人工刷新后可见或 feature-off skip 均不构成证据。

---

## 1. P0 — 配置与范围

- [ ] **CHK-CFG-001** — `NOTIFICATION_REALTIME_ENABLED` 默认 false；8 个配置的 unset / empty / type / range / 非法退出与 spec 8.1 一致。证据：待填。
- [ ] **CHK-CFG-002** — realtime=true 且 notification=false 在 app.listen / listener 前以固定 guard 拒绝启动。证据：待填。
- [ ] **CHK-CFG-003** — flag 五态矩阵（REST / stream / insert / notify）自动化通过。证据：待填。
- [ ] **CHK-CFG-004** — 两份 env example、Compose mapping、生产 config check 同步且不含 secret；direct / Caddy overlay 分别强制 TRUST_PROXY=1 / 2。证据：待填。
- [ ] **CHK-CFG-005** — `schema.prisma` 和 `migrations/**` 无变化。证据：待填。

---

## 2. P0 — Dispatcher 与 PostgreSQL listener

- [ ] **CHK-BE-001** — 只新增 `pg` / `@types/pg`，lockfile 与 runtime 合法。证据：待填。
- [ ] **CHK-BE-002** — channel 固定为 `monexus_notification_created_v1`，不接收用户 / env 输入。证据：待填。
- [ ] **CHK-BE-003** — listener 先获 LISTEN ACK；failure proxy 恰好一次捕获 tx 参数化 `pg_notify` 的唯一 ID 对、root 零次，callback sentinel reject，独立 client 证明整体回滚且匹配 hint 静默完整 2 秒；正常 real-PG path 按已提交 ID 对在 commit 后 5 秒内恰好一个 hint。未 ready、无唯一 ID 或超时均失败。证据：待填。
- [ ] **CHK-BE-004** — transaction rollback 无 Notification、无 commit hint、无 SSE ghost。证据：待填。
- [ ] **CHK-BE-005** — dedupe / unique conflict 仅一行、一个 hint，且无 5xx。证据：待填。
- [ ] **CHK-BE-006** — 每 Node 进程恰好一条专用 `pg.Client`，不占 Prisma pool 做永久 LISTEN。证据：待填。
- [ ] **CHK-BE-007** — PG payload 只含 v / notificationId / recipientUserId，且严格校验正安全整数。证据：待填。
- [ ] **CHK-BE-008** — 有本地订阅才按 id + recipient 从 primary 重查 allowlist 摘要；无订阅跳过查询，且绝不整体转发 payload。证据：待填。
- [ ] **CHK-BE-009** — listener TCP keepalive / 30 秒 probe、generation CAS、error / end 后一次 drain、指数重连；旧 callback 无效，恢复后 healthy。证据：待填。
- [ ] **CHK-BE-010** — start / stop 幂等，停止后无 Client / retry timer 泄漏。证据：待填。

---

## 3. P0 — SSE HTTP 与连接治理

- [ ] **CHK-SSE-001** — `GET /api/notifications/stream` 复用 authenticate + requireActiveUser。证据：待填。
- [ ] **CHK-SSE-002** — 200 headers 精确包含 event-stream、no-cache/no-transform、keep-alive、X-Accel-Buffering=no。证据：待填。
- [ ] **CHK-SSE-003** — `registerAndReady` 无 yield，initializing 不收业务广播，字节流 ready 必定先于 notification。证据：待填。
- [ ] **CHK-SSE-004** — ready / notification / auth.expiring / degraded / heartbeat 字节格式与 v1 fixture 一致，业务 frame id 与 data id 相等。证据：待填。
- [ ] **CHK-SSE-005** — 401 / 403 / 404 / 429 / 503 在 headers 前返回，Retry-After 语义正确。证据：待填。
- [ ] **CHK-SSE-006** — local hub 按 user 路由，close / error / expiry cleanup 幂等。证据：待填。
- [ ] **CHK-SSE-007** — heartbeat 使用共享 scheduler，默认 20 秒且不触发业务 UI。证据：待填。
- [ ] **CHK-SSE-008** — per-user=5、per-IP=20、global=1000 cap 及建立速率限制通过。证据：待填。
- [ ] **CHK-SSE-009** — 写前 `res.writableLength > 64KiB` 或任一 `res.write(...) === false` 时立即停止排队业务事件，幂等清理并只 destroy 该慢连接；其他连接不受影响，重连后 REST 收敛。证据：待填。
- [ ] **CHK-SSE-010** — 连接反复建立 / 断开后 gauge、Map、timer、response 全部回收。证据：待填。

---

## 4. P0 — 鉴权与敏感数据

- [ ] **CHK-SEC-001** — 无 Bearer、损坏 Bearer、过期 Bearer 均无法建立 stream。证据：待填。
- [ ] **CHK-SEC-002** — 用户 A 永远不接收 / 查询用户 B 的 event；跨用户 ID 仍隔离。证据：待填。
- [ ] **CHK-SEC-003** — token 到期前 60 秒恰好一次 `auth.expiring`。证据：待填。
- [ ] **CHK-SEC-004** — token exp 到点硬关闭，不能靠 heartbeat 无限延长。证据：待填。
- [ ] **CHK-SEC-005** — 客户端 refresh 单飞，旧 stream abort 后才建新 stream，无 cookie replay / 双连接。证据：待填。
- [ ] **CHK-SEC-006** — token / refresh token 不在 URL、event、log、metric、trace、fixture、snapshot。证据：待填。
- [ ] **CHK-SEC-007** — SSE 唯一 projection 的类型 / 长度 / deeplink / allowlist 通过，且不含 delivery content、structured values、文件对象键 / URL、Webhook secret 或完整 Json payload。证据：待填。
- [ ] **CHK-SEC-008** — metrics 标签与日志字段 cardinality / redact 审核通过。证据：待填。
- [ ] **CHK-SEC-009** — limiter 只用 Express req.ip；TRUST_PROXY=1/2 拓扑正确，伪造 XFF 不绕过且真实客户端不被合并。证据：待填。

---

## 5. P0 — 前端连接与失效层

- [ ] **CHK-FE-001** — fetch SSE 携带 Bearer、credentials、AbortSignal，不使用原生 EventSource / URL token。证据：待填。
- [ ] **CHK-FE-002** — parser 正确处理逐字节 chunk、CRLF、多行 data、comment 和未知字段。证据：待填。
- [ ] **CHK-FE-003** — parser 对 malformed / 超 64KiB frame 安全降级。证据：待填。
- [ ] **CHK-FE-004** — 401 refresh、403 auth_blocked、404 polling_only、429/503/network backoff 与 timer ownership 正确。证据：待填。
- [ ] **CHK-FE-005** — exact-ID LRU 容量 512；101 先于 100 时两者均处理。证据：待填。
- [ ] **CHK-FE-006** — 同一 exact ID 只发布一次 live invalidation / Toast。证据：待填。
- [ ] **CHK-FE-007** — 300ms topic 合并与 in-flight dirty rerun 通过 burst 测试。证据：待填。
- [ ] **CHK-FE-008** — ready、reconnect、回前台均立即发布 all.visible 权威同步。证据：待填。
- [ ] **CHK-FE-009** — degraded 每 30 秒、healthy 每 5 分钟，两个 timer 不并存。证据：待填。
- [ ] **CHK-FE-010** — Layout 旧 30 秒未读 effect 已移除，没有重复 interval / stream。证据：待填。
- [ ] **CHK-FE-011** — Toast 仅 live + visible + first ID；ready / polling / 校准不补历史 Toast。证据：待填。
- [ ] **CHK-FE-012** — instant delivered 与未知事件默认静默，但状态仍同步。证据：待填。
- [ ] **CHK-FE-013** — logout / user change abort stream，清 LRU / timer / pending topic / 旧用户计数。证据：待填。
- [ ] **CHK-FE-014** — 客户端不发送 Last-Event-ID；服务端 Header 不回放 / 不授权；LRU 淘汰后的极晚重复只造成允许的额外 hint。证据：待填。

---

## 6. P0 — UI 接入

- [ ] **CHK-UI-001** — 实时事件刷新全局 notification unread，铃铛总数正确。证据：待填。
- [ ] **CHK-UI-002** — 打开的消息 Tab 自动重载最新 5 条。证据：待填。
- [ ] **CHK-UI-003** — NotificationsPage 按当前 filter 重载第一页，load-more / realtime 无重复或覆盖。证据：待填。
- [ ] **CHK-UI-004** — mark-read / read-all / deeplink 既有行为回归。证据：待填。
- [ ] **CHK-UI-005** — buyer event 重取订单列表并重算 attention。证据：待填。
- [ ] **CHK-UI-006** — relatedOrderId 匹配时重取当前买家详情，secret 仍只经受权 REST。证据：待填。
- [ ] **CHK-UI-007** — modal 关闭 / focus query 与异步刷新无重新打开 / 旧响应覆盖。证据：待填。
- [ ] **CHK-UI-008** — merchant event 在当前 page / status / sort 下重取 orders。证据：待填。
- [ ] **CHK-UI-009** — merchant dashboard / orders Tab 重取 stats，未挂载页面不乱发请求。证据：待填。
- [ ] **CHK-UI-010** — 相关 merchant action dialog 对状态变化刷新或安全失效。证据：待填。
- [ ] **CHK-UI-011** — manual / processing / delivered / disputed / refunded / resolved / closed Toast 矩阵正确。证据：待填。
- [ ] **CHK-UI-012** — 10 个当前 eventType 全覆盖；未知事件只刷新 notifications。证据：待填。
- [ ] **CHK-UI-013** — realtime / polling background reload 保留现有数据和交互状态；失败不清空页面、不产生错误 Toast 风暴。证据：待填。

---

## 7. P0 — 代理与基础设施

- [ ] **CHK-INF-001** — Nginx exact stream location 不被普通 `/api/` 60 秒配置吞并。证据：待填。
- [ ] **CHK-INF-002** — buffering/cache/gzip 关闭，HTTP/1.1、Connection 正确；5m 是 idle timeout，所有上游 idle timeout >3×heartbeat 且无总寿命截断。证据：待填。
- [ ] **CHK-INF-003** — Authorization、Cookie、Host、X-Forwarded-* 原样 / 正确透传。证据：待填。
- [ ] **CHK-INF-004** — Caddy 对 SSE 即时 flush，未破坏普通 SPA / API。证据：待填。
- [ ] **CHK-INF-005** — raw small event / heartbeat 经 Nginx+Caddy 当次抵达，无 60 秒聚合。证据：待填。
- [ ] **CHK-INF-006** — upload、backup、MinIO SigV4 与普通 API proxy 回归通过。证据：待填。
- [ ] **CHK-INF-007** — endpoint-class 证据在 7×24 小时内且绑定同 endpoint / role / deployment revision；actual-role gate ≤65 秒：current_user match、P_pre/P0/P30/P60 distinct count=1、LISTEN ACK、独立 sender t≈0/30/60 三轮唯一 payload 均在 SQL success 后 5 秒内收到、4 个另行辅助连接各完成 10 个短事务，CONNECT / LISTEN / 参数化 pg_notify 无权限错误。只输出脱敏结论；证据缺失 / 过期或任一失败均阻断启用。证据：待填。

---

## 8. P0 — 生命周期与可观测性

- [ ] **CHK-OPS-001** — readiness 展示 disabled / ok / degraded / draining。证据：待填。
- [ ] **CHK-OPS-002** — listener degraded 不使核心 API unready；draining 必须 503。证据：待填。
- [ ] **CHK-OPS-003** — listener_up、connections、PG outcomes、events、disconnect、reject、lag 指标齐全；每条 NOTIFY 恰好一个非 probe 终态 outcome，cluster wakeups 统计全部消息终态，no-subscriber ratio 仅以 `routed + no_subscriber` 为分母并处理零分母。证据：待填。
- [ ] **CHK-OPS-004** — metrics 无 userId / orderId / IP / title / body 标签。证据：待填。
- [ ] **CHK-OPS-005** — logs 无 token、cookie、DATABASE_URL、PG 原 payload、通知正文、交付数据。证据：待填。
- [ ] **CHK-OPS-006** — SIGTERM 后 draining + 立即 server.close + stop cron，再 SSE drain / listener stop；在途 HTTP 完成后才断 Redis / Prisma。证据：待填。
- [ ] **CHK-OPS-007** — 活跃 SSE 5 秒内结束，总 shutdown 不超过 10 秒；重复 signal / stop 幂等，无孤儿 timer / Client。证据：待填。

---

## 9. P0 — QA

- [ ] **CHK-QA-001** — protocol serializer / parser fixture 双端一致。证据：待填。
- [ ] **CHK-QA-002** — config、hub、token timer、cleanup 单元测试通过。证据：待填。
- [ ] **CHK-QA-003** — real PG commit / rollback / NOTIFY SQL failure 整体回滚 / dedupe 集成测试通过。证据：待填。
- [ ] **CHK-QA-004** — auth、expiry、跨用户、payload allowlist 集成测试通过。证据：待填。
- [ ] **CHK-QA-005** — 前端 10 eventType、unknown、Toast、exact-ID、burst 合约通过。证据：待填。
- [ ] **CHK-QA-006** — ready / subscribe / REST sync 并发窗口只重复不遗漏。证据：待填。
- [ ] **CHK-QA-007** — listener 断开 / reconnect 测试通过。证据：待填。
- [ ] **CHK-QA-008** — PostgreSQL restart / backend restart 后 polling + reconnect 收敛。证据：待填。
- [ ] **CHK-QA-009** — 两个独立 Node PID 和同一专用 PG 已验证。证据：待填。
- [ ] **CHK-QA-010** — stream 在 A、业务写 B，A 收到事件。证据：待填。
- [ ] **CHK-QA-011** — 任一实例重启后无永久遗漏，跨实例不是内存 EventEmitter。证据：待填。
- [ ] **CHK-QA-012** — 慢消费者测试分别命中 `writableLength > 64KiB` 与 `res.write() === false`，验证仅慢 response 被清理 / destroy、快消费者继续接收且重连后 REST 收敛；caps、buffer、100 burst 测试通过。证据：待填。
- [ ] **CHK-QA-013** — SSE 阻断 / 503 时应用自身 fallback ≤35 秒，不用测试主动 poll。证据：待填。
- [ ] **CHK-QA-014** — logout 后旧流关闭，旧用户后续事件不污染新用户。证据：待填。
- [ ] **CHK-QA-015** — 既有 notification dispatcher / service / integration / E2E 全绿。证据：待填。
- [ ] **CHK-QA-016** — order、auth、announcement 受影响回归与前后端 build 全绿。证据：待填。

---

## 10. P0 — 性能

- [ ] **CHK-PERF-001** — healthy 首次 ready / small event 不被代理缓冲。证据：待填。
- [ ] **CHK-PERF-002** — staging 样本量、环境、P50 / P95 / P99 报告已保存。证据：待填。
- [ ] **CHK-PERF-003** — UI 可见 P95 ≤2 秒、P99 ≤5 秒。证据：待填。
- [ ] **CHK-PERF-004** — 慢客户端与 burst 下 Node RSS / FD / event loop 无无界增长。证据：待填。

---

## 11. P0 — 文档、发布与回滚

- [ ] **CHK-DOC-001** — Owner O-RT-01~08 全批准，六件套 Frozen。证据：待填。
- [ ] **CHK-DOC-002** — 旧 SPEC-NOTIFY-001 / DESIGN-NOTIFY-001 有精确 superseded 指针。证据：待填。
- [ ] **CHK-DOC-003** — env、metrics、health、proxy、troubleshooting runbook 完整。证据：待填。
- [ ] **CHK-DOC-004** — 所有 task / AC / checklist / evidence 追溯无断链。证据：待填。
- [ ] **CHK-DOC-005** — README 场景 / eventType / 配置数量与 spec 一致。证据：待填。
- [ ] **CHK-DOC-006** — Known limitations 明示无 Last-Event-ID 回放、每 Tab 连接、非可靠 hint。证据：待填。

- [ ] **CHK-REL-001** — realtime 默认 false，关闭态部署验证通过。证据：待填。
- [ ] **CHK-REL-002** — 所有 backend 先升级，再开 flag，再发 frontend 的滚动顺序已演练。证据：待填。
- [ ] **CHK-REL-003** — 旧 frontend + 新 backend、新 frontend + off / on 兼容通过。证据：待填。
- [ ] **CHK-REL-004** — 先关 flag 再回滚代码，REST / polling / Notification 历史无损。证据：待填。
- [ ] **CHK-REL-005** — production-like smoke 不在 feature-off 时 skip / 假绿。证据：待填。
- [ ] **CHK-REL-006** — PR 描述含规格、配置、发布、指标、风险、回滚、证据索引。证据：待填。
- [ ] **CHK-REL-007** — migration status / drift 正常，schema / migrations 无 diff。证据：待填。

---

## 12. P1 — 明确后置，不阻断首次发布

- [ ] **CHK-P1-001** — 根据真实多 Tab 连接数据评估 BroadcastChannel leader election。
- [ ] **CHK-P1-002** — 根据断线恢复数据评估有界 Last-Event-ID replay；不得先承诺可靠回放。
- [ ] **CHK-P1-003** — 根据外部渠道需求另立 Transactional Outbox / Delivery / retry / DLQ 规格。
- [ ] **CHK-P1-004** — 聊天 / presence 出现时另立 WebSocket 规格。
- [ ] **CHK-P1-005** — D-RT-25：已批准容量计划或 deployment / autoscaling manifest 的 desired / max replicas≥32（证据含 revision、Owner、日期）、实际 listeners≥32，或同一 5 分钟 recording rules 显示 wakeups≥1000/s、`routed + no_subscriber > 0`、ratio≥90% 且告警 `for: 15m` 时另立评估规格；零分母 unavailable，不自动改变 P0。

P1 未勾选不阻断 G-PR；若实现中提前加入任一 P1，视为范围扩张，必须重新审核规格。

---

## 13. AC 验收索引

| AC | 主要 Checklist |
| --- | --- |
| AC-RT-001 | CHK-UI-008~009、013、CHK-QA-010、CHK-PERF-003 |
| AC-RT-002 | CHK-UI-005~007、013、CHK-SEC-007、CHK-PERF-003 |
| AC-RT-003 | CHK-BE-003~004、CHK-QA-003 |
| AC-RT-004 | CHK-BE-005、CHK-FE-006 |
| AC-RT-005 | CHK-QA-009~011 |
| AC-RT-006 | CHK-SEC-001~002 |
| AC-RT-007 | CHK-SEC-003~005、CHK-FE-004 |
| AC-RT-008 | CHK-SSE-003、CHK-FE-008、CHK-QA-006 |
| AC-RT-009 | CHK-FE-005、CHK-FE-014、CHK-QA-005 |
| AC-RT-010 | CHK-BE-009~010、CHK-QA-007~008 |
| AC-RT-011 | CHK-FE-009、CHK-QA-013 |
| AC-RT-012 | CHK-UI-001~004、013 |
| AC-RT-013 | CHK-FE-012、CHK-UI-011 |
| AC-RT-014 | CHK-CFG-002~003、CHK-REL-001 |
| AC-RT-015 | CHK-SSE-008、CHK-SSE-010、CHK-SEC-009 |
| AC-RT-016 | CHK-SSE-009、CHK-QA-012 |
| AC-RT-017 | CHK-INF-001~005、CHK-PERF-001 |
| AC-RT-018 | CHK-OPS-001~002、CHK-OPS-006~007 |
| AC-RT-019 | CHK-OPS-003~005 |
| AC-RT-020 | CHK-FE-013、CHK-QA-014 |
| AC-RT-021 | CHK-FE-006~007、CHK-QA-012 |
| AC-RT-022 | CHK-REL-001~004 |
| AC-RT-023 | CHK-REL-005~006、CHK-QA-015~016 |
| AC-RT-024 | CHK-BE-007~008、CHK-SEC-006~008 |
| AC-RT-025 | CHK-PERF-002~004 |
| AC-RT-026 | CHK-UI-001~004、CHK-QA-016 |
| AC-RT-027 | CHK-CFG-005、CHK-QA-015~016、CHK-REL-007 |
| AC-RT-028 | CHK-BE-003、CHK-QA-003 |
| AC-RT-029 | CHK-INF-007 |

---

## 14. Final DoD Gate

- [ ] **CHK-FINAL-001** — 所有 P0 checkbox 已勾选并有当前 HEAD 证据。
- [ ] **CHK-FINAL-002** — implement.md G-PR-001~010 全为 Passed。
- [ ] **CHK-FINAL-003** — 所有 P0 task Done；没有遗留 In Progress / Blocked 卡。
- [ ] **CHK-FINAL-004** — git diff check、secret scan、schema / migration audit 通过。
- [ ] **CHK-FINAL-005** — Owner 审阅证据、发布顺序和回滚后明确批准合并 / 启用。
