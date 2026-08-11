# SPEC-NOTIFY-RT-001 Review 修复实施方案

| 字段 | 值 |
| --- | --- |
| 文档性质 | Review remediation / Agent handoff，不是冻结规格的新组成部分 |
| 适用 Worktree | `/root/projects/worktrees/monexus-order-notification-realtime` |
| 适用分支 | `feat/order-notification-realtime` |
| 审查 HEAD | `3ff3457f833d6f4bcd887e418116545e0f26a8e0` |
| 冻结基线 commit | `22ae95c8`，禁止 amend / rebase 掉祖先关系 |
| develop 冻结审查基线 | `origin/develop@da38dd0580eeac737f5291556b9dbdf832d91970` |
| 当前已同步 develop | `origin/develop@2482a7d176b1d40a3483ae8e3cc9a481fc18e201`（仅 PR #129 storage schema default 对齐） |
| 文档日期 | 2026-08-09 |
| 当前结论 | `goal_complete` 驳回；不得宣称 I-RT-011 Done、ready to merge 或 ready to enable |

> 本文只规定如何修复已确认缺陷、重建证据和恢复正确状态，不修改任何冻结的 D-RT、NRT、REQ、AC、endpoint、事件名、事件矩阵、收件人或 JWT TTL。若实现过程中发现必须改变冻结语义，应立即停止并走 Owner delta review，不得在本方案下自行扩项。

### Schema drift baseline debt

审查发现的三条 Prisma live diff 已由独立 [PR #129](https://github.com/amo0114/MoNexus/pull/129) 修复并进入 develop `2482a7d176b1d40a3483ae8e3cc9a481fc18e201`：三个 storage `updatedAt` 字段补充 `@default(now())`，忠实描述既有数据库默认值且不新增 migration。Realtime 分支已合并该 develop 基线；Verifier 恢复严格 live diff exit 0，不再保留临时 allowlist。

---

## 1. 目标与完成边界

本轮目标是在现有分支上追加修复 commit，使实现真正满足冻结规格，并把被当前代码或错误证据推翻的状态恢复为可审计状态。

需要明确区分两个终态：

1. **Local remediation complete**：全部代码缺陷修复；目标测试、完整本地 verify、真实专用 PostgreSQL、浏览器 E2E 和双实例验证通过；文档绑定当前 HEAD；无 schema / migration 变化。
2. **Release gates complete**：在 local remediation complete 之上，另有未过期的 staging P95/P99、production-like AC-RT-029 / CHK-INF-007、代理 smoke、发布与回滚演练、Owner 审阅证据。

接手 Agent 可以在没有部署权限时完成第 1 项，但必须把第 2 项保持为 `Pending`。只完成第 1 项时，正确交接措辞是“本地修复与验证完成，部署门禁待执行”，不是 `goal_complete`、ready to merge 或 ready to enable。

---

## 2. 强制约束

### 2.1 环境与数据安全

- 必须使用 Node 20 / npm 10：

  ```bash
  source /root/.nvm/nvm.sh
  nvm use 20
  node --version
  npm --version
  ```

- 只使用专用数据库 `monexus_test_notification_realtime`。
- 专用端口固定为 backend A `3112`、backend B `3113`、Vite `5182`。
- 不得运行 `prisma migrate dev`，不得新增或修改 Prisma schema / migration。
- 不得新增依赖。
- 不得使用生产账号、生产订单或生产 secret 作为本地 fixture。
- 测试与脚本只能终止自己记录的 PID，不得清理共享服务或其他 Agent 的进程。

### 2.2 冻结语义与 Git

- 不修改 `spec.md` 中任何 D-RT / NRT / REQ / AC 的含义或阈值。
- 不改 endpoint `/api/notifications/stream`、PG channel、SSE event 名、v1 envelope、事件矩阵、recipient 规则、15 分钟 JWT TTL。
- 不实现 P1 的 broker、outbox、Last-Event-ID replay、BroadcastChannel leader election。
- 不 amend 冻结 commit；所有修复使用新 commit。
- 开始和结束都验证冻结 commit 仍为祖先：

  ```bash
  git merge-base --is-ancestor 22ae95c8 HEAD
  ```

- 保留无关的用户改动；若工作树出现来源不明且与本方案重叠的修改，先停止并确认，不覆盖、不 reset。

### 2.3 实施纪律

- 严格执行 Red → Green → Refactor：先提交或至少先运行会失败的回归测试，再改生产代码。
- 同一时刻只能重开一个现有 `I-RT-*` Implement card；完成其目标测试并记录证据后，才能进入下一卡。
- 不用删除、跳过、放宽断言、增加无条件重试或延长冻结阈值的方式“修绿”。
- 浏览器 AC 不得使用 `page.reload()`、测试主动 GET polling 或 `expect.poll()` 冒充应用自身收敛。
- 每条 evidence 必须绑定完整 HEAD、命令、exit code、测试数、耗时和非敏感环境标识。

---

## 3. 审查结论与缺陷清单

以下问题均已在审查 HEAD 上确认，不是待调查假设。

| ID | 级别 | 已确认问题 | 主要影响 | 修复包 |
| --- | --- | --- | --- | --- |
| F-RT-001 | Blocker | `scripts/verify-notification-realtime.sh` 的 secret regex 匹配脚本自身；Node 20 下 Step 7 失败、最终 exit 1 | I-RT-011 的“final verify exit 0”不可复现 | R-RT-004 |
| F-RT-002 | Blocker | `OrdersPage` 的 `buyer.orders` 只刷新列表，已打开详情只在 `all.visible` 时刷新 | 直接违反 AC-RT-002 | R-RT-002 |
| F-RT-003 | Blocker | `NotificationRealtimeBridge` 没有组件 unmount cleanup | logout 直接卸载 Layout 时旧 SSE 可能继续存活，违反 AC-RT-020 | R-RT-001 |
| F-RT-004 | Blocker | `NotificationStream` 无 connection generation / request identity | 旧 fetch、reader、EOF、401 refresh 的迟到结果可污染新连接 | R-RT-001 |
| F-RT-005 | Blocker | 200 response 一到即标 `healthy`、取消 fallback 并调用 `onReady`，真正 `stream.ready` 又重复调用 | 假 healthy、重复同步、fallback 丢失 | R-RT-001 |
| F-RT-006 | Blocker | parser 跨重连复用且 reconnect 不 reset；旧连接残帧可与新连接 chunk 拼接 | 可合成不存在的业务事件 | R-RT-001 |
| F-RT-007 | Blocker | listener lifecycle 在 `await previous.stop()` 后不重查 stopped / draining / generation | shutdown 与 reconnect 并发时 stop 返回后仍可新建 `pg.Client` | R-RT-003 |
| F-RT-008 | Blocker | `InvalidationScheduler` 的 inflight 只包住同步 callback 调用，不等待异步 reload | 动态复现 `calls=2,maxActive=2`，不是 single-flight dirty rerun | R-RT-002 |
| F-RT-009 | Blocker | `NotificationsPage` 把 realtime 首屏追加到历史末尾，不更新同 ID，并覆盖历史 cursor | 最新顺序错误，分页可重复、漏项或错位，违反 AC-RT-012 | R-RT-002 |
| F-RT-010 | Blocker | AC-RT-029 脚本吞掉 4 个辅助连接事务失败，PASS 不等待/不检查 4×10 次事务 | production session gate 可假绿 | R-RT-004 |
| F-RT-011 | P0 | SSE parser 用 JS 字符数而非 UTF-8 byte 数执行 64KiB cap，且无换行长行可先无限累积 | CHK-FE-003 的 byte cap 证据不成立 | R-RT-001 |
| F-RT-012 | P0 | `registerAndReady` 忽略 `res.write()` 的 false / throw，仍将 entry 标为 ready | 可留下孤儿/慢消费者 entry，违反写入与清理约束 | R-RT-003 |
| F-RT-013 | P0 Security | deeplink 校验接受包含反斜杠、可被 URL 规范化为外部地址的值，例如 `/\\evil.example` | SSE projection 的站内路径边界可绕过 | R-RT-003 |
| F-RT-014 | P0 Security | stream controller 对缺失/非法 `exp` 不阻断，可能不给连接安排 hard-expiry timer | NRT-011 的强制过期边界依赖未校验假设 | R-RT-003 |
| F-RT-015 | P0 | backoff index 在每次 `enterConnecting()` 被重置；fallback 在每次 retry connecting 被清除 | 实际不形成 1/2/4/8/16/30 秒退避，持续错误时 fallback 可被反复推迟 | R-RT-001 |
| F-RT-016 | P0 | merchant action dialog 持有打开瞬间的 `MerchantOrder`，realtime reload 只替换列表 | 已打开操作对话框可能继续展示/提交过期状态 | R-RT-002 |
| F-RT-017 | P0 | proxy smoke 声称 ready ≤2 秒且 token 不进入代理/app log，但命令最多等 8 秒且只检查 metrics | CHK-INF-005 / CHK-PERF-001 证据范围大于实际断言 | R-RT-004 |
| F-RT-018 | Blocker | 实际业务 browser E2E 只实证 AC-RT-001；另外 3 项是 parser/LRU/匿名 smoke | AC-RT-002/011/012/013/020/026 无当前浏览器证据 | R-RT-005 |
| F-RT-019 | Blocker | `task.md`、`implement.md`、`checklist.md` 同时存在 Done、未勾工作和 Pending gate 的矛盾 | 102 项“已验证”和 I-RT-011 Done 不可信 | R-RT-006 |
| F-RT-020 | P0 | Bridge 对已在 exact-ID LRU 中的重复事件仍发布全部 invalidation，只抑制 Toast | CHK-FE-006“同一 exact ID 只发布一次 live invalidation / Toast”不成立 | R-RT-001 |
| F-RT-021 | P0 | NotificationsPage 无 filter/request identity；旧 filter 慢响应可覆盖新 filter | 快速切换 category 后可显示错误分类和分页状态 | R-RT-002 |
| F-RT-022 | P0 | OrdersPage 连续打开订单 A/B 时无 request identity；A 的迟到响应可覆盖 B，并错误清除 loading | selected-order/detail race，当前交互状态不可靠 | R-RT-002 |
| F-RT-023 | P0 | listener 的 `handleNotification` 在 await 主库查询后不重查 stopped/client identity | stop 后在途查询仍可 broadcast 并记录 routed | R-RT-003 |

补充证据矛盾：

- `task.md` 将 T-QA-005 标为 Done，但该任务的五个工作项仍全部未勾选。
- T-QA-003 把 staging 100 样本标为已完成，证据段却写“需 staging 执行”。
- `implement.md` 将 I-RT-011 标为 Done，同时 G-PR-001 / 006 / 009 仍为 Pending。
- `implement.md` 明确规定任一 Gate Pending / Failed 时不得宣称 ready to merge。

---

## 4. 推荐执行顺序与 Implement card 映射

不要把 R-RT 编号新增为冻结实施卡；它们是本次 review 的工作包。实际执行时按下表逐个重开原卡。

| 顺序 | 工作包 | 重开原卡 | 退出条件 |
| --- | --- | --- | --- |
| 0 | 状态纠偏（仅撤销失实 Done / evidence） | I-RT-011 / T-QA-005 退回 Pending，不置任何卡 In Progress | 文档不再声称 goal complete；全部 G-PR 先按证据有效性置 Pending |
| 1 | R-RT-001 客户端连接正确性 | I-RT-007 | stream/parser/Bridge 目标测试及前端 build 通过 |
| 2 | R-RT-002 异步失效与 UI 收敛 | I-RT-008 | scheduler、订单详情、dialog、通知分页测试通过 |
| 3a | R-RT-003A listener 生命周期 | I-RT-004 | shutdown/reconnect race 与 connect cleanup 测试通过 |
| 3b | R-RT-003B hub / HTTP / projection | I-RT-005 | ready/control write、JWT exp、deeplink 测试通过 |
| 4 | R-RT-004 验证与部署脚本 | I-RT-009 | secret、session gate 自测、proxy timing、本地/release gate 分离通过 |
| 5 | R-RT-005 AC 浏览器证据 | I-RT-010 | 指定 6 个 AC 的真实业务 E2E 通过 |
| 6 | R-RT-006 全量回归与证据重建 | I-RT-011 | 本地证据绑定最终 HEAD；外部证据缺失项保持 Pending |

如果某个 E2E 暴露新的生产代码缺陷，不得在 I-RT-010 内顺手修改对应模块：先把 I-RT-010 退回 Pending，重开拥有该文件的原卡修复并验证，再回到 I-RT-010。

---

## 5. R-RT-001 — 客户端 stream generation、ready、parser 与卸载清理

### 5.1 Owned files

- `src/realtime/notificationStream.ts`
- `src/realtime/sseParser.ts`
- `src/components/NotificationRealtimeBridge.tsx`
- `src/realtime/notificationStream.test.ts`
- `src/realtime/sseParser.test.ts`
- 必要时增加 Bridge 的专用测试；不改 Layout 的业务结构

### 5.2 先写失败测试

至少增加以下确定性用例：

1. 旧 fetch 在 token change 后迟到返回 200，不得替换新 reader、改 state 或触发 `onReady`。
2. 旧 reader 在新连接 healthy 后迟到 EOF / throw，不得把新连接置 degraded。
3. 旧连接留下半个 frame，新连接首 chunk 不能与其拼成 `notification.created`。
4. 200 + 正确 Content-Type 但尚未收到 `stream.ready` 时，不得 healthy、不得调用 `onReady`、不得启动 calibration 或取消已存在 fallback。
5. 同一 generation 即使收到重复 `stream.ready`，`onReady` 也只执行一次。
6. 连续 503 / network 的退避使用 1/2/4/8/16/30 秒序列（允许冻结规格的 ±20%），不能每轮重置为 1 秒。
7. degraded → connecting 重试期间 30 秒 fallback 保持唯一且持续运行；只有真正 ready 才切换为 5 分钟 calibration。
8. 超过 65536 **UTF-8 bytes** 的多字节 frame 触发一次 `tooLarge`；65536 bytes 边界允许，65537 bytes 拒绝。
9. 没有换行的超长 chunk 也在 byte cap 处降级，不能先无限写入 parser buffer。
10. oversized frame 的剩余字段在空行前全部丢弃，不能把尾部解析成第二个合法业务事件。
11. Bridge unmount 会同步 stop/abort stream、清 timer、pending topic 和当前用户 LRU；StrictMode effect cleanup/re-run 不留下双连接。
12. 同一 exact notification ID 到达两次时，第二次既不 Toast，也不再次发布任何 invalidation topic；LRU 仍保持容量 512 和正确 recency。

测试使用可控 deferred promise / fake timer / mock reader，不使用真实 sleep 制造竞态。

### 5.3 实现设计

#### A. 每次连接使用不可复用的 identity

在 `NotificationStream` 中增加单调递增 generation。每次开始新 fetch、stop、logout 或 user change 都使旧 generation 失效。一次 connection attempt 的以下对象必须是局部且同属一个 generation：

- `AbortController`
- `ReadableStreamDefaultReader`
- `TextDecoder`
- `SseParser`
- `readySeen`

每个 `await fetch`、`await refresh`、`await reader.read` 之后，以及每次 state / timer / callback 写入前，都检查：

```text
!stopped
attemptGeneration === currentGeneration
attemptController === currentController
userId / token scope 仍属于本 attempt
```

旧 attempt 失效后只能自行 cancel/abort/释放局部资源；它的 200、401、frame、EOF、throw 均必须 no-op，不能进入公共状态机。

#### B. ready 是唯一 healthy 边界

- HTTP 200 只证明传输层可读；校验 Content-Type/body 后开始 read loop，状态仍不是 healthy。
- 只有当前 generation 的首个合法 `stream.ready` 才能：
  - 切换 `healthy`；
  - reset backoff index；
  - 停止 fallback / backoff；
  - 启动唯一 calibration；
  - 调用一次 `onReady`，从而触发 `all.visible` REST 权威同步。
- `notification.created` 不得使连接自动 healthy；ready 前业务 frame 应按协议异常处理并回到权威同步路径。
- malformed、id mismatch、tooLarge、`stream.degraded`、当前 reader EOF/error 都必须先使当前 attempt 失效/abort，再进入 degraded，避免该 read loop 继续处理同批后续 frame。

#### C. timer ownership

- new user / logout / stop：清全部 timer。
- token change：abort 旧流并立即新 fetch；不把旧 EOF 当失败。
- degraded：一个 fallback timer + 一个 backoff timer。
- degraded 的 backoff 到期进入 connecting 时只消费/清当前 backoff，不清仍需持续收敛的 fallback。
- healthy：无 fallback/backoff，只有一个 calibration timer。
- backoff index 只在新 session/user 或真正 `stream.ready` 后重置，不在每次 retry entry 重置。

#### D. parser 按原始 UTF-8 bytes 限制

parser 必须对当前未完成 frame 的原始 UTF-8 byte 数计数，包括尚未遇到换行的 buffer；不能用 `string.length`。可使用平台内建 `TextEncoder` 或等价增量记账，不新增依赖。

增加明确的 oversized-discard 状态：首次越界只返回一个 `tooLarge`，随后忽略该 frame 直到空行边界，再完整 reset。comment / unknown field 也不能绕过内存上限。连接 generation 更换时直接丢弃旧 parser / decoder，不跨连接 reset 后复用。

#### E. Bridge 生命周期

拥有 stream 的 effect 必须返回 cleanup：

```text
stop stream
resetRealtimeRuntime
清 last user/token refs
```

依赖变化 cleanup 与组件最终 unmount 都应幂等。logout 即使让 Layout 直接卸载，也必须在同一清理链上 abort 旧 SSE。

#### F. exact-ID 在发布前短路

Bridge 必须在 `resolveInvalidation()` 和 scheduler publish 之前判断 exact-ID。首次 ID 记录后按矩阵发布；重复 ID 可刷新 LRU recency，但必须直接返回，不再发布 topic 或 Toast。不得改成 `maxSeen`，101 先于 100 仍都作为首次事件处理。

### 5.4 完成断言

- 任意时刻每 Tab / user 最多一个可产生副作用的 fetch/read loop。
- 旧连接的任何迟到动作都不能影响新 user/token。
- `onReady` 与 REST resync 每 generation 恰好一次。
- degraded fallback 在持续 503 下不晚于 35 秒产生应用自身同步。
- parser 对 Unicode 与无换行攻击输入仍有真实 64KiB byte 上限。

---

## 6. R-RT-002 — 异步 single-flight、订单详情、merchant dialog 与通知分页

### 6.1 Owned files

- `src/realtime/notificationInvalidation.ts`
- `src/realtime/runtime.ts`
- `src/hooks/useNotificationInvalidation.ts`
- `src/pages/OrdersPage.tsx`
- `src/pages/NotificationsPage.tsx`
- `src/pages/MerchantDashboardPage.tsx`
- 对应前端单元/组件测试

### 6.2 先写失败测试

1. subscriber 返回 deferred Promise；同 topic 第一次 reload 未完成时再 invalidation，断言 `maxActive=1`，第一次完成后只 dirty rerun 一次。
2. burst 期间多次 dirty 仍只合并成一次 rerun；callback reject 也会释放 inflight，且无 unhandled rejection。
3. `clearAll()` 后旧 user 的 in-flight completion 不得再次调度 dirty rerun。
4. `buyer.orders` 到达且详情已打开时，列表、attention 和当前详情都重载；详情关闭后迟到结果不能重开 modal。
5. merchant action dialog 打开期间相关订单变化，dialog 通过订单 ID 重新取权威详情，或在 action 已失效时安全关闭/禁用，不能保留旧可操作状态。
6. NotificationsPage 已加载两页时收到首屏 realtime reload：
   - 新通知位于最前；
   - 同 ID 使用首屏权威新对象替换；
   - 无重复；
   - 已加载历史顺序保留；
   - 历史 tail 的 `nextCursor` / `hasMore` 不被首屏 cursor 覆盖；
   - 下一次 load-more 继续从原 tail，结果仍无重复/漏页。
7. 当前 category filter 改变时，只合并该 filter 的结果；旧 filter 的迟到 response 不污染当前页。
8. 连续打开订单 A、B 并让 A 响应晚于 B：modal 最终仍显示 B；A 的 finally 不得清除 B 的 loading 状态。

### 6.3 实现设计

#### A. subscriber 合约异步化

把 subscriber 类型改为 `() => void | Promise<void>`。每 topic 保持一条执行链：

1. 若 topic 正在执行，只置 `dirty=true` 并返回。
2. 否则快照当前 subscribers，进入 inflight。
3. await 该轮所有 subscriber（建议 `Promise.allSettled`，避免一个页面失败阻断同 topic 的其他权威同步）。
4. 若期间 dirty，清 dirty 后再执行恰好一轮；重复直到干净。
5. finally 释放 inflight。

`invalidate()` 和 `publishNow()` 的外部调用仍可保持 void fire-and-forget，但内部必须真正 await subscriber Promise。`clearAll()` 增加 runtime epoch，使旧 epoch 的 completion 不再触发 rerun。

所有页面订阅 callback 必须 **return reload Promise**，不能继续写成 `void load(...)` 后立即返回。

#### B. 买家订单

`buyer.orders` 和 `all.visible` 都应返回同一个可等待的后台 reload 流程：

- 重取当前订单列表并重算 attention；
- 若当前 detail 存在，按当前 detail.id 调用授权 REST detail；
- `setSelectedOrder(prev => prev?.id === requestedId ? detail : prev)`，防止关闭或切换后旧响应重开/覆盖。

不得从 SSE envelope 填充交付 secret；详情仍只来自既有授权 REST。

#### C. merchant action dialog

列表 reload 不能被当作 dialog 权威数据。对 `deliveringOrder`、`disputeOrder`、`progressOrder`、`rejectingOrder` 中当前打开的唯一 ID 集合，使用现有 `getMerchantOrderDetail(id)` 重取，再按 exact ID 更新相应 dialog。若 404/403、订单 action 已不再允许或状态已经使当前动作无效，应安全关闭/禁用对应 dialog并保留页面数据，不使用旧对象继续提交。

#### D. NotificationsPage 分页模型

背景首屏同步不是 append，也不是覆盖整个已加载历史。使用 exact-ID merge：

```text
merged = authoritativeFirstPage
       + previousItems 中不在 authoritativeFirstPage ID set 的历史项
```

这会把最新项置顶、更新已有 ID，同时保留已加载的旧页。背景首屏同步不得覆盖当前历史 tail 的 `nextCursor` / `hasMore`；只有初始/filter reload 或成功 load-more 能改变对应分页 tail。load-more 本身也要按 ID 去重，避免与刚合并的首屏重叠。

对 filter/request 使用 generation 或等价 identity，避免旧 filter 响应迟到覆盖新 filter。

#### E. 订单详情请求 identity

`openOrder()` 为每次用户选择/focus 请求分配 request generation（或 AbortController）。只有当前 request 且目标 ID 仍是最后选择时才能写 `selectedOrder` 和清对应 loading。关闭 modal、切换 focus 或打开另一个订单都会使旧请求失效；旧 A 响应不能覆盖新 B，也不能清 B 的 loading。

### 6.4 完成断言

- 动态并发测试为 `maxActive=1`，且 dirty 期间最终不丢同步。
- processing/delivered 在 AC-RT-002 硬上限内更新买家列表、attention、打开详情和通知。
- 打开的 merchant action dialog 不保留已失效动作。
- NotificationsPage 最新优先、exact-ID 更新、历史 pagination 连续。

---

## 7. R-RT-003 — listener shutdown race、hub 写入、JWT exp 与 deeplink

此包必须分成 I-RT-004 和 I-RT-005 两次重开，不能同时标 In Progress。

### 7.1 R-RT-003A：listener lifecycle（I-RT-004）

#### Owned files

- `server/src/modules/notifications/realtime/lifecycle.ts`
- 必要时 `server/src/modules/notifications/realtime/listener.ts`
- `server/src/modules/notifications/__tests__/realtime-listener.integration.test.ts`

#### 先写失败测试

1. 用 deferred `previous.stop()` 建立屏障：reconnect 进入 await 后调用 lifecycle `stop()`，再释放屏障；断言不创建新 listener / `pg.Client`、状态保持 stopped、无 retry timer。
2. 同一场景改为 `beginDraining()`；释放后不得创建新 client。
3. 新 listener 的 connect / LISTEN / first probe 失败时，该 client 在 backoff 前已关闭，不保留半连接。
4. 旧 generation 的 `onReady` / `onUnavailable` 在新 generation 或 stop 后均为 no-op。
5. repeated error/end 只 drain 一次、只安排一个 reconnect。
6. notification 到达后主库 `getEnvelope` 保持 pending；期间 stop listener，再 resolve 查询；断言 stop 后不 broadcast、不记录 routed。

#### 实现设计

- 在任何可能 yield 的 teardown 之前先保留 attempt generation / intent。
- `await previous.stop()` 返回后，必须重新检查 `started`、`status !== draining/stopped`、attempt generation 仍为 current。
- 新 listener 创建、赋给 `this.listener`、connect 返回/失败后都做 CAS identity 检查。
- stale attempt 若已经创建局部 listener，必须主动 `stop()` 它，不能只忽略 callback。
- connect / LISTEN / probe 失败应关闭失败 client 后再进入 degraded/backoff。
- `stop()` 必须让所有 in-flight attempt 失效并等待/清理其局部 client，确保返回时以后不会再出现新 `pg.Client`。
- notification handler 必须绑定触发它的 client identity，并在主库查询 await 返回后重查 `!stopped && this.client === sourceClient`；失效结果直接丢弃，不能在 stop 后 broadcast/routed。

#### 完成断言

`stop()` 或 draining 一旦开始，就是不可逆的 no-new-client 边界；任何旧 promise 的完成都不能复活 listener、timer 或 healthy 状态。

### 7.2 R-RT-003B：hub / stream controller / protocol（I-RT-005）

#### Owned files

- `server/src/modules/notifications/realtime/hub.ts`
- `server/src/modules/notifications/realtime/streamController.ts`
- `server/src/modules/notifications/realtime/protocol.ts`
- 对应 realtime hub/stream/protocol tests

#### 先写失败测试

1. `registerAndReady` 的 `res.write(ready)` 返回 false：entry 不得进入 ready，Map/gauge/IP count 全部回收，只关闭该 response。
2. ready write throw：同样幂等清理，不留下 orphan entry。
3. `auth.expiring`、degraded、heartbeat 等 control write 返回 false/throw 时，遵守同一 slow/write-error 清理契约。
4. 缺失 `exp`、非有限/非整数 `exp`、已过期 `exp` 均在 SSE 200 headers 前返回 401；有效 exp 仍按冻结的 lead=60 秒恰好一次 expiring 并在到点关闭。
5. `/\\evil.example`、反斜杠/control-char 等可规范化为非本站的 deeplink 被拒绝；合法 `/orders?focus=1#x` 保持通过。

#### 实现设计

##### A. ready/control write 使用单一受控路径

`registerAndReady` 仍必须同步、无 yield，以保持 D-RT-13；但只有 ready frame 成功通过冻结写入契约后才能把 entry 从 initializing 置 ready。任一 `res.write() === false` 或 throw 都应：

- 不再投递后续业务事件；
- 从 user/IP/global 结构幂等移除；
- 记录 dropped / slow 或 write_error；
- 定向 destroy/end 当前 response；
- 让 controller 不再为该 entry 安装 auth timers。

可把返回类型改为 `HubEntry | null`，或使用等价的显式成功结果。auth.expiring、degraded、heartbeat 不得继续绕过 hub 的安全写入与清理逻辑。

##### B. 强制 exp 前置校验

在写 200 headers 前验证 `req.user.exp` 为未来的有限整数秒。缺失/非法/过期按无效 access token 返回既有 401 结构。不要修改 JWT 签发或 TTL；这里只落实冻结规格对“有效 bearer 必须有 exp”的边界。通过后再以该值安排 expiring / expiry timer。

##### C. deeplink 规范化安全

除单个 leading slash、长度、scheme/userinfo 规则外，还要拒绝反斜杠与 ASCII control characters，并用固定 dummy origin 做 URL resolve，确认解析后的 origin 仍为 dummy origin。测试覆盖浏览器/WHATWG URL 会改写 authority 的输入。不得把 production host 写入协议，也不要错误拒绝正常站内 query/hash。

### 7.3 完成断言

- initializing → ready 只有成功写出 ready 一条路径。
- 任一 write false/throw 都不会留下连接 Map、gauge 或 timer。
- 无 exp 的 bearer 不能建立无限 SSE。
- SSE projection 的 deeplink 解析后仍严格站内。

---

## 8. R-RT-004 — verify、session gate、proxy smoke 与门禁分层

### 8.1 Owned files

- `scripts/verify-notification-realtime.sh`
- `scripts/verify-notification-realtime-listen-session.sh`
- `server/scripts/verify-notification-realtime-listen-session.mjs`
- `scripts/verify-notification-realtime-proxy.sh`
- 必要的脚本自测文件
- 若命令或环境要求变化，同步 `docs/ops-runbook.md`

### 8.2 secret scan

修复原则：不能简单排除 verify 脚本自身，因为这会制造扫描盲区。

- 把敏感 marker 从若干不形成完整 marker 的 shell 片段在运行时组合，再扫描所有 tracked text files。
- clean tree 运行必须 exit 0，且输出不能含 secret 内容。
- 用临时目录 / `git grep --no-index` 或抽出的 scanner helper 做 positive self-test：包含 synthetic private-key header 的 fixture 必须 exit non-zero。
- 不把 synthetic secret fixture 提交到仓库。

### 8.3 AC-RT-029 session gate

重构辅助事务为受控 Promise 集合，而不是 detached async：

- 4 个 aux connection 均必须连接成功，否则 gate 失败。
- 每个 aux 必须在 t≈0~60 秒窗口内完成 10 个明确计数的短事务；建议按 deadline 调度到约 0/6/12/.../54 秒，而不是在前 15~30 秒随机跑完。
- BEGIN / SELECT / COMMIT 任一步失败都记录失败；rollback 只用于清理，不能把原失败吞掉。
- 主流程必须 await 全部 4 个 worker，最终断言 `connected=4`、`attempted=40`、`committed=40`、`failed=0`、`completed=true`。
- sender 仍必须独立于 4 个 aux。
- PASS 必须同时要求：声明 role 存在且 current_user match、endpoint class 合法、revision 非占位、PID distinct=1、LISTEN ACK、三轮唯一 payload 各在 SQL success 后 5 秒内收到、notify permission ok、40/40 aux transactions 成功、总时长不超过冻结的 65 秒。
- 任一异常路径都在 finally 关闭 listener/sender/aux；不输出 PID、URL、username、password 或 payload。

增加不需要真实 production secret 的脚本级测试，至少覆盖：一个 aux transaction reject 时最终 FAIL、39/40 时 FAIL、worker 未完成时 FAIL、三轮全收但 role mismatch 时 FAIL。真实 AC-RT-029 仍只能由实际 production-like endpoint 证明，mock/self-test 不能替代。

### 8.4 proxy smoke

- 对 `stream.ready` 的**业务字节抵达**测量真实 elapsed time，而不仅是 headers 的 time-to-first-byte。
- 在 2 秒 deadline 内轮询专用临时 body 或使用能在匹配 ready 后退出的无缓冲 reader；超过 2 秒即 FAIL。
- 当前 token sentinel 检查只覆盖 response/metrics，不能声称覆盖 Nginx/Caddy/app logs。两种可接受处理：
  1. release smoke 接收明确的脱敏 log query/文件输入并对三层日志都检查，缺任一层即 Pending/FAIL；或
  2. 把本地脚本证据措辞收窄到实际验证范围，并把完整 log 泄漏检查保留为部署人工 gate。
- 所有 tempfile 与 curl PID 用 trap 精确清理；不得打印 Bearer。

### 8.5 本地 gate 与 release gate 分离

`scripts/verify-notification-realtime.sh` 可以作为可重复的 local implementation gate，但在 session/staging/release 项未运行时，结尾必须明确输出：

```text
[PASS] local implementation gate
[PENDING] deployment/release gates: ...
```

不得再输出含义为“全部门禁完成”的总 PASS。另提供显式 release 入口或 `--release` 模式，要求所有外部证据存在、未过期且通过；缺少 production-like env 时非零退出，不静默 skip。

### 8.6 完成断言

- Node 20 下 local verify 不再 self-match，真实 exit 0。
- synthetic secret 能让 scanner 失败。
- session gate 不能在 aux 失败/未完成时 PASS。
- proxy ready 的 ≤2 秒断言与实际测量一致。
- local PASS 不再被解释为 release PASS。

---

## 9. R-RT-005 — 补齐真实业务 Browser E2E

### 9.1 Owned files

- `e2e/notification-realtime.spec.ts`
- 可按场景拆分新的 `e2e/notification-realtime-*.spec.ts`
- `server/scripts/notification-realtime-e2e-seed.mjs` 或等价专用 fixture
- `playwright.notification-realtime.config.ts`
- `scripts/verify-notification-realtime-e2e.sh`

保持 3112 / 5182 / dedicated DB / `reuseExistingServer=false`；不要修改默认 Playwright 3000 / 5173 栈。

### 9.2 共同测试规则

- 业务状态变化必须通过真实上游 REST/API 或真实 UI action 产生，并走真实 DB transaction → PG NOTIFY → listener → SSE → app invalidation → REST convergence。
- API 可用于 fixture setup 和触发业务动作，但不能在测试中主动 GET 目标资源来替应用刷新。
- 断言目标必须是用户可见 DOM、应用 request 计数或真实连接状态；不以 parser 函数调用代替业务 AC。
- 禁止 `page.reload()`、主动 poll、`expect.poll()`。
- 记录 trace；每条用例使用唯一 ID，避免并行噪声。
- 两条正常核心链路目标 ≤5 秒；fallback ≤35 秒。staging P95/P99 仍另行采样，不由本地单次 E2E 冒充。

### 9.3 必补场景

#### AC-RT-002 — 买家详情实时收敛

Given 买家打开订单列表并保持目标订单详情 modal；When 商家依次 processing、deliver；Then 无刷新地验证：

- 列表状态变化；
- attention 变化；
- 已打开详情两次都更新；
- 通知未读/消息出现；
- SSE response / trace 中不存在 delivery secret，secret 只在买家授权 detail REST 中出现。

#### AC-RT-011 — 持续 503 / stream blocked fallback

让应用 stream 请求持续得到 503 或被阻断，先确认 UI 处于非 healthy。随后通过业务 API 改变订单/未读；页面保持打开且不刷新，验证应用自身 30 秒 fallback 在 35 秒内更新 DOM。测试不能主动调用刷新接口。

#### AC-RT-012 — 通知 filter 与分页

打开 NotificationsPage 的指定 filter，先加载至少两页历史；产生符合 filter 的新通知。验证新项置顶、已有 ID 不重复、已读状态等权威字段能更新，然后点击 load-more，确认 cursor 连续、无重复/错位。

#### AC-RT-013 — instant 静默

创建 instant order 并直接 delivered。验证买家状态和消息更新，但页面没有打扰性 Toast；商家侧没有 new-order realtime event/Toast。不得通过隐藏 Toast selector 超时作为唯一证据，应同时验证消息/状态确实已到达。

#### AC-RT-020 — logout / user switch 隔离

用户 A 建立 stream 后 logout 或切换到用户 B；确认 A 的 request 被 abort。随后只为 A 产生事件，验证 B 的 unread、订单、消息和 Toast 都不变化；再为 B 产生事件，验证 B 正常收到且每 Tab 只有一条有效 stream。

#### AC-RT-026 — 公告与事务消息共存

准备一条待确认公告并打开铃铛；同时产生事务通知。验证单铃铛总数为两类计数之和，但公告强制 Tab、确认按钮和确认语义不变；消息 Tab/消息页仍接收事务消息。

### 9.4 建议额外覆盖

- 当前 connection generation 下 ready 只触发一次 REST sync。
- 重连前后 network request 证明没有并存的旧/新 stream。
- 101 先到、100 后到在真实页面都能触发收敛；该项不能只留在 LRU 单测。

### 9.5 完成断言

专用 Playwright 报告必须能逐项指向 AC-RT-002/011/012/013/020/026；“4 tests passed”但只有 1 条业务 AC 的旧证据不再使用。

---

## 10. R-RT-006 — 状态纠偏、全量回归与 Evidence Ledger 重建

### 10.1 先撤销失实状态

在改代码前先做一次最小文档纠偏，避免后续 Agent 误以为已有证据仍有效：

- T-QA-003 退回 Pending，至少将“processing/delivered detail、消息分页、instant、announcement、fallback、staging 100 样本”等未实际证明项撤销勾选。
- T-QA-005 从 Done 退回 Pending；它当前五个工作项本来就未勾选。
- I-RT-011 退回 Pending。
- 受本轮缺陷影响的 I-RT-004、005、007、008、009、010 依次在实施时重开；不得同时 In Progress。
- 在 Evidence Ledger 中保留历史但明确把旧 I-RT-011 行标为 **Invalidated by review**：Node 20 复跑在 secret scan self-match 处 exit 1，且多项 AC 缺证据。不得继续保留“final verify exit 0”的无注释事实声明。
- checklist 顶部的“102/112 已验证”必须按撤销后的真实计数更新。

至少撤销或重新审计以下 checkbox 的旧 HEAD 证据：

- listener / hub：CHK-BE-009~010、CHK-SSE-003、006、009~010；
- security：CHK-SEC-003~005、007；
- frontend：CHK-FE-003~004、007~010、013；
- UI：CHK-UI-003、006~007、010、013；
- infra / QA：CHK-INF-005、CHK-QA-002、006~008、012~014、016；
- deployment：CHK-INF-007、CHK-PERF-001~003、CHK-REL-002、004 本来就必须保持未勾选。

不要机械撤销完全不受影响且仍有独立真实证据的 dispatcher AC-RT-028 等项目；逐项按 evidence 是否仍绑定有效 HEAD 判断。

代码一旦变化，`implement.md` 规则要求基于旧 HEAD 的 G-PR Passed 证据先退回 Pending。最终本地重跑后，只恢复有当前 HEAD 证据的 gate；G-PR-001/006/009 在缺部署/Owner 证据时必须继续 Pending。

### 10.2 分层验证

每个工作包先跑目标 suite，全部生产代码完成后按以下顺序执行：

```bash
cd /root/projects/worktrees/monexus-order-notification-realtime
source /root/.nvm/nvm.sh
nvm use 20

npm run check:runtime
npm run build
(cd server && npm run build)
npm run check:nginx

set -a
. ./.env.notification-realtime.local
set +a
case "$TEST_DATABASE_URL" in
  */monexus_test_notification_realtime\?schema=public) ;;
  *) echo "unsafe TEST_DATABASE_URL" >&2; exit 1 ;;
esac

(cd server && npx vitest run \
  src/modules/notifications/ \
  src/modules/health/ \
  src/__tests__/config-realtime-guards.test.ts \
  src/__tests__/config-production-guards.test.ts \
  src/__tests__/faka-bridge-config.test.ts)

npx vitest run src/realtime/ src/utils/
bash scripts/verify-notification-realtime-e2e.sh
bash scripts/verify-notification-realtime-multi-instance.sh
bash scripts/verify-notification-realtime.sh

git diff --check
git diff --exit-code -- server/prisma/schema.prisma server/prisma/migrations
git merge-base --is-ancestor 22ae95c8 HEAD
git status --short
```

注意：完整 local verify 应直接显示并保留各 suite 的测试数和最终 exit code；不能全部重定向到 `/dev/null` 后只留一句泛化 PASS 作为 Evidence Ledger 的唯一依据。

### 10.3 外部门禁

以下项目只有取得对应权限与真实环境后才执行：

- production-like AC-RT-029 / CHK-INF-007；
- 经 Nginx/Caddy 的 raw proxy ready 与日志泄漏 smoke；
- staging 专用账号/fixture 的至少 100 个独立样本及 P50/P95/P99；
- backend-first → flag-on → frontend 发布演练；
- flag-off → 代码回滚 → REST/polling/history 无损演练；
- Owner review / merge / enable 批准。

证据必须绑定 endpoint class、role、deployment revision、采集时间与 reviewer；AC-RT-029 在 7×24 小时后或三元组变化时过期。没有访问权限不是脚本失败，但状态只能是 Pending。

### 10.4 Evidence Ledger 写法

每个修复包新增一行，不覆盖历史 commit：

| 字段 | 要求 |
| --- | --- |
| 时间 | 带 timezone 的实际执行时间 |
| HEAD | 完整 40 字符 SHA |
| I / T | 当前唯一重开的原 Implement card / Task |
| REQ / AC / CHK | 精确列出，不写笼统的 AC-RT-001~029 除非真有逐项索引 |
| 命令 | 可复制命令，注明 Node/npm 版本与专用 DB/ports，隐藏 secret |
| 结果 | exit code、tests passed/failed/skipped、耗时 |
| Artifact | trace/report/log 的仓库外安全路径或 CI artifact ID |

旧证据若被代码变化失效，应标 `Superseded` / `Invalidated`，不能删除导致审计断链，也不能继续当当前 HEAD 证据。

---

## 11. 交付验收矩阵

| Gate | Local remediation complete 要求 | Release complete 要求 |
| --- | --- | --- |
| Stream generation / cleanup | R-RT-001 全部竞态测试通过 | 同左 |
| UI convergence | R-RT-002 unit/component + 指定 browser AC 通过 | staging 延迟达标 |
| Listener / hub / security | R-RT-003 tests + real local PG 通过 | production metrics/smoke 无异常 |
| Secret scan | clean tree pass + synthetic positive fail | CI/release artifact 通过 |
| AC-RT-029 | 脚本 self-test 能拒绝 aux 假绿 | 实际 endpoint gate 未过期且 PASS |
| Proxy | 本地脚本 timing/assertion 正确 | 实际 Nginx/Caddy ready≤2s、日志审查通过 |
| Browser E2E | AC-RT-002/011/012/013/020/026 全通过 | staging 100 样本 P95≤2s、P99≤5s |
| Schema | schema/migration 零 diff | 同左 |
| Rollout / rollback | runbook 与命令可执行 | 两次实际演练有证据 |
| G-PR | 仅当前 HEAD 有证据项可 Passed | G-PR-001~010 全 Passed + Owner 批准 |

---

## 12. 接手 Agent 的最终报告模板

### 12.1 仅完成本地修复时

```text
SPEC-NOTIFY-RT-001 local remediation complete at <FULL_HEAD>.

Completed:
- R-RT-001 ...
- R-RT-002 ...
- R-RT-003 ...
- R-RT-004 local/self-tests ...
- R-RT-005 browser AC ...
- R-RT-006 current-HEAD evidence ...

Verification:
- Node/npm: ...
- backend: <count>, exit 0
- frontend: <count>, exit 0
- browser: <count>, exit 0
- multi-instance: PASS
- final local verify: exit 0
- schema/migrations: no diff
- frozen commit ancestor: yes

Pending deployment gates:
- AC-RT-025 staging P95/P99
- AC-RT-029 / CHK-INF-007 production-like session gate
- deployed proxy/log smoke
- rollout/rollback rehearsal
- Owner review

Conclusion: local remediation complete; NOT ready to merge/enable while the above gates remain Pending.
```

### 12.2 只有全部外部门禁也完成时

只有在 Evidence Ledger 已绑定同一最终 HEAD、G-PR-001~010 全为 Passed、Final DoD 全勾选且 Owner 明确批准后，才允许报告：

```text
goal_complete: SPEC-NOTIFY-RT-001 implementation and all release gates complete at <FULL_HEAD>.
```

---

## 主审新增发现 / 安全证据策略

- 专用 Playwright 配置关闭 trace、screenshot、video；Bearer、登录密码和 delivery secret 不得进入 artifact。E2E 证据只接受脱敏 list reporter/stdout，禁止用不存在的 trace 路径作证。
- 静默 artifact 策略不降低 AC-RT-025、AC-RT-029、deployed proxy/log、rollout/rollback 或 Owner gate 的证据要求；这些状态继续 Pending。

## 13. 禁止的“完成”替代品

以下均不能作为完成依据：

- “代码里有 generation / timer / cap”但没有能复现旧竞态的失败测试；
- “callback 被调用过”但没有 await 真实异步 reload；
- parser/LRU 浏览器 smoke 冒充订单/消息业务 AC；
- session gate 脚本存在但 aux worker 未纳入 PASS；
- proxy 命令允许 8 秒却声称 ≤2 秒；
- production-like/staging 项因无权限被 skip 后仍输出总 PASS；
- checklist 全勾但 Evidence Ledger 绑定旧 HEAD；
- G-PR 仍有 Pending 却声称 ready to merge；
- 本地 `verify` 绿灯替代 Owner review、发布/回滚演练或 production enable 批准。
