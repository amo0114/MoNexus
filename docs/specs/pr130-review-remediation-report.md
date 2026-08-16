# PR #130 审查问题修复 — 实施 agent 汇报(交回审核)

状态:实施完成,待审核
来源方案:`docs/specs/pr130-review-remediation.plan.md`

## 1. 分支与工作方式

- **worktree 路径**:`/root/projects/MoNexus-new-remediation`(独立 git worktree)
- **分支名**:`fix/notification-realtime-review-remediation`
- **基线 commit(origin/develop)**:`fcb0a0dbbc258198e1eba6b660c2b5247169813a`
- 目标 PR:`develop`,squash merge,加 `run-e2e` label。
- 已确认所有 commit 文本不含 `skip-ci` 字面量(CI OK 不会卡死)。

## 2. 每个问题的改动、测试与 commit

| 问题 | 改动文件 | 新增/修改测试 | commit |
|---|---|---|---|
| 1(中等,前端 401 环路) | `src/realtime/notificationStream.ts` | `src/realtime/__tests__/notificationStream.test.ts`(exhaustion + reset 两条) | `cca6624`(与问题 7 合并,见偏离说明) |
| 2(中等,NOTIFY 风暴) | `server/src/modules/notifications/realtime/listener.ts`、`realtime/constants.ts`、`lib/metrics.ts` | `realtime-listener-races.test.ts`(overload 闸门测试)、`realtime-metrics.test.ts`(+overload label) | `30fb849` |
| 3(中等,dispatcher 窄类型) | `server/src/modules/notifications/dispatcher.ts`、`modules/orders/fulfillment.ts` | 无新增(tsc 驱动,无窄桩需改) | `4d5e2f3` |
| 4(轻微,insert+findFirst) | **未改代码(放弃)** | `realtime-dispatcher-p2002-gate.test.ts`(前置集成测试,固化 tx abort 行为) | `dcd1734` |
| 5(轻微,sseParser TextEncoder) | `src/realtime/sseParser.ts` | 无新增(现有单测全绿,行为无变化) | `6890d56` |
| 6(轻微,hub 心跳空转) | `server/src/modules/notifications/realtime/hub.ts` | `realtime-hub-controller.test.ts`(注册→移除→timer 归零→再注册重启;并更新 3 条旧断言到新语义) | `587be8e` |
| 7(轻微,degraded reason) | `src/realtime/notificationStream.ts` | `notificationStream.test.ts`(合法帧 reason+retryAfterMs floor、无 retryAfterMs、畸形/非 string 回退) | `cca6624`(与问题 1 合并) |
| 8(轻微,401 指标) | `server/src/modules/notifications/realtime/streamController.ts`、`lib/metrics.ts` | `realtime-stream.test.ts`(auth_expired 指标断言) | `e7e9eb9` |

### 问题 3 的编译期保证
- `NotificationWriter` 由 `Pick<..., 'notification'> & { $queryRaw? }` 改为 `Pick<..., 'notification' | '$queryRaw'>`($queryRaw 必需)。
- 删除 `emit` 内 `typeof tx.$queryRaw !== 'function'` 运行时 throw 分支。
- `fulfillment.ts` `emitLifecycleNotifications` 参数类型补 `'$queryRaw'`(已由 `OrderStatusTransitionClient` 满足)。
- 用 `npx tsc --noEmit` 驱动:无其他报错窄化 Pick,测试无手工构造窄对象,故无测试桩需补 mock。
- 验收:`cd server && npx tsc --noEmit` 零错误(见 §4);全量后端测试通过(1099/1099)。

## 3. 问题 4 前置集成测试结论(tx abort 实证)与决定

**结论:事务被 abort。** 前置集成测试对真实测试库执行:

```
caughtP2002=true
subsequentWriteOk=false
committed=false
rejectedReason=... PostgresError { code: "25P02", message: "current transaction is aborted, commands ignored until end of transaction block" }
```

同一 Prisma interactive 事务内,`tx.notification.create` 触发唯一约束冲突抛 P2002 并被 catch 后,事务内**后续业务写入直接失败(25P02)**且整个 callback 回滚(落库 0 行)。证实 PostgreSQL 特性:Prisma interactive tx 不按语句建 savepoint,catch 掉 P2002 仍会毒化事务。

**决定:放弃本项修改,保留现状**(`createMany + skipDuplicates + findFirst`)。按方案唯一"可能不做"出口执行。前置测试保留为回归测试(`realtime-dispatcher-p2002-gate.test.ts`),固化 abort 行为,防止将来盲目重试该优化。PR 描述中会说明此原因。

## 4. 四条验证命令的完整结果尾部

### 4.1 后端全量 vitest(worktree `server/`,migrate deploy 已对 monexus_test 执行,56 个 migration 无 pending)
```
Test Files  128 passed (128)
     Tests  1099 passed (1099)
 Start at  23:56:07
 Duration  2331.62s (transform 11.07s, setup 74.93s, import 77.04s, tests 2155.95s, environment 15ms)
```
注:本环境实际耗时 ~39min,长于方案的 ~17min 估计;全部通过。

### 4.2 后端 tsc
```
cd server && npx tsc --noEmit   →   rc=0,零输出(零错误)
```

### 4.3 前端 vitest(src/realtime + src/utils)
```
 Test Files  8 passed (8)
      Tests  67 passed (67)
```

### 4.4 前端 tsc + build
```
npx tsc --noEmit   →   rc=0
npm run build      →   ✓ built in 13.18s(dist/index.html 4.01 kB 等)
```
build 需 Node 20(项目 `check-runtime` 要求 `>=20 <21`),以 `nvm use 20`(v20.19.5 / npm 10.8.2)执行通过;仅有既有 dynamic-import/chunk-size 警告,与本次改动无关。

## 5. flag-off(`NOTIFICATION_REALTIME_ENABLED=false`)行为无变化的依据

默认 flag 为 false 且生产未开启;本次改动全部位于 realtime 启用后才触发的代码路径:

- 问题 2(监听闸门):listener 仅在 realtime lifecycle 启动(flag on)时运行。
- 问题 3(dispatcher):$queryRaw 收紧是**纯类型**改动;运行时 `pg_notify` 仅在 `config.notificationRealtime.enabled` 分支内执行,flag off 时不走。
- 问题 6(hub 心跳):hub 仅在 flag on 时被 streamController 使用。
- 问题 8(401 指标):streamController 在 flag off 时直接 `next(notFound)` 返回 404,401 指标分支不会执行。

覆盖测试(均在 1099 条通过之列):
- `realtime-dispatcher.test.ts` "realtime off -> no pg_notify hint (D-RT-21 / CHK-BE-002)"(flag off 零 hint)
- `realtime-dispatcher.test.ts` "notification total off -> no write and no hint (D-RT-21 / NRT-019)"
- `dispatcher.test.ts` "skips writes when notification.enabled is false"
- `realtime-stream.test.ts` "CHK-CFG-003/CHK-SSE-005: realtime off -> 404"
- 前端问题 1/5/7 无服务端 flag 依赖,前端测试全绿。

## 6. 未解决 / 偏离方案之处(显式列出)

1. **问题 1 与问题 7 合并为一个 commit `cca6624`**:两者都改 `src/realtime/notificationStream.ts` 及其单测文件,改动交错无法按文件拆分;方案允许问题 4–8 归并,此处将 1 与 7 合并(同文件约束),commit message 已注明两件事。
2. **问题 4 放弃**:按方案"可能不做"出口,保留现状,新增回归测试固化 tx abort 证据(§3)。
3. **问题 5 未加新单测**:方案只要求"无行为变化,现有单测全绿",现有 sseParser 测试已覆盖 13 条并全绿,无需新增。
4. **后端全量耗时 ~39min > 方案 ~17min 估计**:环境因素,结果全绿,不影响结论。
5. **前端 build 需 Node 20**:项目 `check-runtime` 硬性要求;以 nvm v20.19.5 执行通过(与仓库 .nvmrc/CI 一致)。
6. **`server/package-lock.json` 安装期噪声已还原**:npm 安装引入的 optional 平台依赖变更与修复无关,已 `git checkout` 还原,分支仅含修复改动。

## 7. 审核通过后(主会话执行,本 agent 不做)

1. 复查 diff + 本报告证据。
2. push 分支 → PR → `develop`,标题 `fix(realtime): address PR #130 review findings`,body 引用本文件 + 验证证据,加 `run-e2e` label。
3. `CI OK` 绿后 squash merge。
4. 不单独发版;若未来生产开启 realtime flag,问题 1/3 修复必须已在 master(写入 release checklist)。
