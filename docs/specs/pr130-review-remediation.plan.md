# PR #130 审查问题修复方案(交接给实施 agent)

状态:待实施
来源:PR #130(feat/order-notification-realtime,已 squash 合入 develop,并随 #131 发布到 master/生产)
审核人:主会话 Claude(实施完成后交回审核)

## 0. 分支与工作方式(必读)

- **不是 hotfix**。生产虽已含该代码,但 `NOTIFICATION_REALTIME_ENABLED=false` 是默认值且未开启,所有问题均无生产事故;走常规流程。
- 基线:`origin/develop`(先 `git fetch origin`)。
- 分支名:`fix/notification-realtime-review-remediation`。
- **在独立 git worktree 中工作**(用 EnterWorktree 或 `git worktree add`),不要动主 checkout。
- 提交拆分:每个问题一个 commit,message 前缀 `fix(realtime): ...`(问题 4–8 可按 backend/frontend 各归并为一个 `chore(realtime):`/`fix(realtime):` commit)。
- PR 目标:`develop`,squash merge,加 `run-e2e` label(改动触及 realtime 代码,需跑专用 Playwright)。
- **禁止在任何 commit/PR 文本中出现 skip-ci 字面 token**(会卡死 required check `CI OK`,见 docs/branching-and-ci.md)。

## 1. 问题清单与具体修法

### 问题 1(中等)— 前端 401→refresh→重连无退避环路

文件:`src/realtime/notificationStream.ts`(`connect()` 中 401 分支,约 186–201 行)

现状:401 且 `refreshOnce` 成功时立即 `enterConnecting()`,无计数无退避。若服务端持续 401(时钟偏差、exp 异常),形成每轮打一次 `/api/auth/refresh` 的循环。

修法:
- 新增私有字段 `authRetryCount = 0` 与常量 `export const STREAM_AUTH_RETRY_LIMIT = 3`。
- 401 且 refresh 成功路径:`authRetryCount++`;若 `authRetryCount >= STREAM_AUTH_RETRY_LIMIT`,不再 `enterConnecting()`,改走 `this.enterDegraded(0, 'auth_retry_exhausted')`(degraded 自带指数退避,退避到期后 `enterConnecting` 会再次尝试,届时仍受本计数约束)。
- 计数清零点:`handleFrame` 收到 `stream.ready` 时(连接真正成功);`stop()`;`start()` 的 userChanged 分支。**注意**:不要在 `enterConnecting()` 里清零,否则计数失效。
- 新增单测(`src/realtime/__tests__/notificationStream.test.ts`):mock fetch 恒返 401 + refresh 恒成功,断言第 3 次后状态进入 `degraded` 且 fetch 调用次数封顶;再断言收到 `stream.ready` 后计数重置(下一次 401 又可刷新)。

### 问题 2(中等)— NOTIFY 风暴放大 DB 查询

文件:`server/src/modules/notifications/realtime/listener.ts`(`handleNotification`,约 179–209 行)

修法(轻量并发闸门,不引依赖):
- 新增私有字段 `inflightEnvelopeQueries = 0` 与常量 `NOTIFICATION_REALTIME_MAX_INFLIGHT_ENVELOPE_QUERIES = 8`(放 `constants.ts`)。
- 在 `hasSubscribers` 通过之后、调用 `getEnvelope` 之前:若 `inflightEnvelopeQueries >= 上限`,直接 `reportOutcome('overload')` 并 return(丢弃提示是安全的——NOTIFY 本就是有损唤醒,REST 兜底收敛)。
- `constants.ts` 的 `NotificationRealtimePgOutcome` 联合类型追加 `'overload'`;确认 `lib/metrics.ts` 的 counter label 无枚举白名单需要同步(prom-client 动态 label 值无需注册,但检查是否有测试断言 outcome 全集)。
- `getEnvelope` 调用包在 `try/finally` 中维护计数(现有 try/catch 结构上加 finally 递减)。
- 新增单测(放 `realtime-listener-races.test.ts` 或新文件):注入慢 `getEnvelope`(挂起的 Promise),连发 9 条 notification,断言第 9 条得到 `overload` outcome 且 `getEnvelope` 只被调 8 次;释放后计数恢复。
- **不要**引入队列/缓冲——spec 明确 listener 不得持有 backlog(NRT-014 / T-BE-003 Must Not Touch)。

### 问题 3(中等)— Dispatcher 窄类型 tx 的运行时抛错改为编译期保证

文件:`server/src/modules/notifications/dispatcher.ts`(约 33–38、193–195 行)、`server/src/modules/orders/fulfillment.ts`

现状:`NotificationWriter.$queryRaw` 可选 + 运行时 throw。已确认 `fulfillment.ts:295` `emitLifecycleNotifications(client: Pick<Prisma.TransactionClient, 'notification' | 'merchant'>, ...)` 类型上不含 `$queryRaw`,运行时靠传入完整 tx 侥幸不炸。

修法:
- `NotificationWriter` 中 `$queryRaw` 改为**必需**:`type NotificationWriter = Pick<Prisma.TransactionClient, 'notification' | '$queryRaw'>`。
- 删除 `emit` 内 `typeof tx.$queryRaw !== 'function'` 的运行时 throw 分支(编译期已保证)。
- 修 `fulfillment.ts`:`emitLifecycleNotifications` 的参数类型加 `'$queryRaw'`;顺藤摸瓜修所有因此报错的窄化 Pick(用 `npx tsc --noEmit` 驱动,预计还有 `orders/service.ts` 传参处与测试桩)。
- 测试桩若手工构造窄对象,需补 `$queryRaw` mock(返回 resolved promise 即可)。
- 验收:`cd server && npx tsc --noEmit` 零错误;全量后端测试通过。

### 问题 4(轻微)— Dispatcher 插入后 findFirst 回查 id

文件:`server/src/modules/notifications/dispatcher.ts`(约 145–186 行)

修法:`createMany + skipDuplicates + findFirst` 改为单次 `tx.notification.create({ data: {...}, select: { id: true } })`,catch Prisma `P2002`(`instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'`)时走原 duplicate 日志分支并 return。删除 `missing_id` 分支(不再可能)。
**风控**:P2002 在事务内不是 savepoint 回滚问题——Prisma interactive tx 中被 catch 的唯一约束冲突会使整个 tx 进入 aborted 状态(PostgreSQL 特性)!**实施前必须先写一个集成测试验证**:同一事务中触发重复通知后,后续业务写入是否仍成功。若测试证明 tx 被 abort,则**放弃本项修改,保留现状**,在 PR 描述中说明原因。这是本清单唯一带"可能不做"出口的项。

### 问题 5(轻微)— sseParser 每行 new TextEncoder()

文件:`src/realtime/sseParser.ts`(43、48、97 行)

修法:模块顶层 `const utf8Encoder = new TextEncoder()`,三处调用点替换。无行为变化,现有单测须全绿。

### 问题 6(轻微)— hub 心跳空转

文件:`server/src/modules/notifications/realtime/hub.ts`

修法:`removeEntry` 末尾若 `this.connectionCount === 0` 则 `this.stopHeartbeat()`。`streamController` 已在每次注册后调 `startHeartbeat()`(幂等),无需其他改动。补一条单测:注册→移除→断言 heartbeatTimer 为 null;再注册→断言重新启动。

### 问题 7(轻微)— stream.degraded 的 reason 传原始 JSON

文件:`src/realtime/notificationStream.ts`(`handleFrame` 末尾,约 305–307 行)

修法:`JSON.parse(frame.data)` 取 `.reason` 字段(服务端 `serializeDegraded` 产出 `{v, reason, retryAfterMs}`);parse 失败或 reason 非 string 时回退 `'server'`。同时把 `retryAfterMs`(若为正数)作为 `enterDegraded` 的 floor 传入,与服务端退避建议对齐。补单测覆盖合法帧与畸形帧。

### 问题 8(轻微)— 401 未计 rejection 指标

文件:`server/src/modules/notifications/realtime/streamController.ts`(约 142–146 行)

修法:401 返回前加 `notificationRealtimeConnectionRejectionsTotal.inc({ reason: 'auth_expired' })`。确认 metrics 定义处 label 说明文档(若有 reason 枚举注释)同步追加。补/改一条 `realtime-stream.test.ts` 断言。

## 2. 验证要求(实施 agent 必须全部执行)

```bash
# 后端(worktree 内 server/,先 migrate deploy 到 monexus_test,见 memory 约定)
cd server && TEST_DATABASE_URL='postgresql://monexus:monexus_dev_2026@localhost:5432/monexus_test?schema=public' \
  REDIS_ENABLED=false API_RATE_LIMIT_MAX=3000 npx vitest run   # 全量,后台跑,~17min
cd server && npx tsc --noEmit
# 前端
npx vitest run src/realtime src/utils
npx tsc --noEmit && npm run build
```

注意事项(来自项目 memory):worktree 新建后需 `npm install`(双端)+ `npx prisma generate`;若常驻 codex 宿主进程重写了 .prisma 客户端,重新 generate;`dashboard.service.test.ts` 月初两天有已知 flake,与本次改动无关。

## 3. 实施 agent 的汇报格式(交回审核用)

逐项汇报,缺一不可:
1. worktree 路径、分支名、基线 commit(develop 的 SHA)。
2. 每个问题:改了哪些文件哪些行(diff hunk 或 `git show` 摘要)、新增测试名称、该问题对应 commit SHA。
3. 问题 4 的前置集成测试结论(tx abort 与否的实证输出),以及做/不做的决定。
4. 四条验证命令的**完整结果尾部**(测试通过数/失败数原文,不要只说"通过")。
5. 明确声明:flag-off(`NOTIFICATION_REALTIME_ENABLED=false`)行为无变化的依据(哪些测试覆盖)。
6. 未解决/偏离方案之处的清单(允许偏离,但必须显式列出理由)。

## 4. 审核通过后的提交流程

1. 审核人(主会话)复查 diff + 测试证据。
2. push 分支,开 PR → `develop`,标题 `fix(realtime): address PR #130 review findings`,body 引用本文件,贴验证证据,加 `run-e2e` label。
3. 等 `CI OK` 绿后 squash merge 到 develop。
4. **不单独发版**:这些修复随下一次常规 develop→master release PR 上线即可(生产 flag 未开,无紧急性)。若 Owner 决定在生产开启 realtime flag,则问题 1/3 的修复必须已包含在当时的 master 中——这是开关前置条件,写入 release checklist。
