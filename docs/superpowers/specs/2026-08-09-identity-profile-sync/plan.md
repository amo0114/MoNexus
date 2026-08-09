# Plan: 当前用户资料同步与头像一致性

| 字段 | 值 |
| --- | --- |
| Plan ID | PLAN-IDENTITY-SYNC-001 |
| 对应 Spec | SPEC-IDENTITY-SYNC-001 v0.1.0 |
| 版本 | 0.1.0 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation** |
| 审查基线 | `develop@da38dd0580eeac737f5291556b9dbdf832d91970` |

> 本计划已经 Owner 批准并冻结。每张 Implement 卡仍须在 `S` 形成后满足自身前置与 Entry Gate 才能执行。

---

## 1. 工程目标与非目标

### 1.1 目标

1. 建立一个可证明拒绝 stale response 的 current-user 提交协议。
2. 让 `/me` GET、role healing、profile PATCH、token refresh 与 session switch 共享同一会话边界。
3. 让 profile PATCH 顺序确定、完整响应原子落地，并与 points 等局部权威更新兼容。
4. 让 Profile、桌面 Navbar、移动抽屉共同渲染同一真实头像/fallback。
5. 在不触碰通知在建代码的情况下完成 Identity Core，并在文件锁移交后做最小 Layout 接线。
6. 用受控 transport 和真实浏览器证明正确性，而不是依赖人工刷新。

### 1.2 非目标

- 不新增数据库模型或 migration；
- 不引入 WS/SSE/TanStack Query/BroadcastChannel；
- 不重构全部 auth/session 后端；
- 不改通知 realtime protocol、appStore 或 auth middleware；
- 不改商品/分类/推广代码；
- 不实现头像裁剪、压缩、审核或旧对象同步删除；
- 不承诺多 Tab/跨设备亚秒资料传播。

---

## 2. 目标架构

~~~text
                           ┌─────────────────────────┐
Protected entry ──────────►│                         │
Visibility calibration ──►│ ProfileSyncCoordinator  │
Explicit workflow done ───►│                         │
                           └──────┬───────────┬──────┘
                                  │           │
                       guarded GET│           │FIFO PATCH
                                  ▼           ▼
                          GET /auth/me   PATCH /auth/me
                                  │           │
                          role skew?           │full AuthUser
                           │ yes               │
                           ▼                   │
                     guarded refresh          │
                           │                   │
                           └─► second GET      │
                                  └─────┬─────┘
                                        ▼
                         validate Commit Ticket
                 epoch + user + request + userRev + mutationRev
                                        │
                                accepted│discarded
                                        ▼
                              authStore.user
                         ┌──────────────┼──────────────┐
                         ▼              ▼              ▼
                   Profile card   Desktop Navbar   Mobile drawer
                         └─────── shared UserAvatar ────────┘
~~~

正确性来源是 commit validation 与 mutation FIFO；`/me` REST 是权威校准。Avatar blob 缓存只负责字节分发，不参与 profile 状态排序。

---

## 3. 模块与建议文件

文件名可在实现前按现有目录命名习惯微调，但所有权与职责不可合并回页面。

### 3.1 Identity Core

```text
src/
  auth/
    profileSync.ts                 # coordinator public API
    profileSync.types.ts           # ticket/result/reason types（可并入上文件）
    profileSync.test.ts            # fake transport deterministic race suite
  stores/
    authStore.ts                   # epoch/revisions/safe commit primitives
    authStore.test.ts              # persistence/session transition tests
  api/
    auth.ts                        # raw get/update 保持 transport-only；role healing 由 coordinator 编排
    authRefresh.ts                 # current-session token commit guard
  components/
    identity/UserAvatar.tsx
    identity/UserAvatar.test.tsx
    profile/ProfileIdentityCard.tsx
    MobileNavDrawer.tsx
  App.tsx                          # ProtectedRoute 统一入口
```

### 3.2 Backend

```text
server/src/modules/auth/
  controller.ts                    # GET/PATCH /me no-store
  __tests__/profile-cache.test.ts  # 或扩展 auth.test.ts
```

不改 `service.ts` 字段业务语义，除非 contract test 证明实际响应缺失规范字段；任何扩大修改先 Ask First。

### 3.3 后置 Integration

```text
src/components/Layout.tsx          # 通知 T-FE-002 释放后：移除 pathname /me，接 UserAvatar/visibility
```

`src/stores/appStore.ts`、`server/src/middlewares/auth.ts`、`server/src/modules/notifications/**` 永不由本规格修改。

---

## 4. 核心技术方案

### 4.1 Store runtime metadata

实施顺序先把 store 变成可验证状态机，再接网络：

```ts
interface IdentityRuntime {
  sessionEpoch: number
  userRevision: number
  profileMutationRevision: number
}
```

实现要求：

- 三字段必须排除在 `partialize` 之外；
- login/logout 是单次 Zustand `set` 原子转换；
- logout 的 state transition 必须使旧 epoch 先失效；实际在一个 `set` 中得到新 epoch 并清空即可；
- `updatePoints` 等现有局部 action 使用函数式 set，验证 current user，并推进 userRevision；
- raw `setUser` 从公开调用点消失；coordinator commit 返回 accepted boolean/result 供测试断言；
- 所有 counter 只要求进程内单调，不作为服务器版本、不写 localStorage。

### 4.2 Coordinator transport seam

为了稳定模拟响应顺序，coordinator 不应把 axios promise 写死在状态逻辑深处。建议最小依赖注入：

```ts
type ProfileTransport = {
  getMe(): Promise<AuthUser>
  patchMe(patch: ProfilePatch): Promise<AuthUser>
  refreshAccessToken(ticket: RefreshTicket): Promise<RefreshResult>
}
```

生产默认使用现有 API；测试传 deferred promises。该 seam 仅为 unit test，不新增 runtime service container。

### 4.3 Sync request coalescing

- 用 `{epoch,userId}` 作为单 Tab in-flight key；
- 非强制调用发现相同 key in-flight 时返回同一 Promise；
- `protected-entry` 可复用同 epoch/user 已 dispatch 的 in-flight；visibility 受 accepted-sync TTL 抑制；
- 业务完成、manual retry、mutation/userRevision reconcile 属 barriered force：调用时分配 force generation，只能由调用后 dispatch 的 GET 满足；
- 多个尚未 dispatch 的 force 合并为一个 trailing GET；若新 force 到达时 trailing 已 dispatch，则保留下一 trailing slot，不能用业务完成前的 accepted 响应冒充完成后校准；
- mutation pending 时 sync 等队列，不与 PATCH 并发；
- GET 因 `user_revision` 被拒时保留当前 delta，并按最高 invalidating revision 合并登记一个 trailing reconcile；不得直接递归或固定次数忙重试；
- `lastSuccessfulSyncAt` 按 epoch/user 保存，login/logout 清空；
- request ID 在真正 network dispatch 时分配，而不是每个合并 caller 分配。

### 4.4 Commit validator

用纯函数集中验证，返回低基数 reason：

```ts
validateProfileCommit(current, ticket, responseId, latestRequestId, pendingMutations)
  -> { ok: true }
   | { ok: false, reason:
       'session' | 'user' | 'response_user' | 'request' |
       'user_revision' | 'mutation_revision' | 'force_generation' |
       'pending_mutation' }
```

不得在 App/Profile/Layout 重复一部分判断。Validator unit test 覆盖每个 false 分支和组合优先级。

### 4.5 Mutation FIFO

实现可使用 module-private promise tail，但必须避免 rejection 永久 poison queue：

```ts
const operation = mutationTail.then(run, run)
mutationTail = operation.then(noop, noop)
return operation
```

每个 operation：

1. enqueue 时建立 mutation revision barrier；
2. 执行前 revalidate epoch/user；
3. 捕获 userRevision；
4. PATCH；
5. response id/session 校验；
6. userRevision 未变化则 full replace；
7. 已变化则 queue 后 force sync reconcile；
8. settled 后递减 pending，后项继续。

logout 时不必物理 cancel 已发 HTTP 才能保证正确性；AbortController 可作为资源优化，但 ticket guard 是必须的安全层。Queued 且尚未发出的旧 epoch operation 必须直接取消。

### 4.6 Upload session ticket

`uploadAndSetCurrentAvatar` 在上传前捕获 `{epoch,userId}`，上传完成后重新验证。若 stale：

- 不调用 PATCH；
- 返回 `discarded:session_changed`；
- 不删除 object；
- 不在新会话发 toast；
- 由 StoredObject GC 处理未引用内容。

### 4.7 Session-safe refresh

在不破坏现有单飞、refresh cookie rotation、`navigator.locks` 的前提下，为 token write 增加 guard：

- requestRefreshToken 不应在 `.then` 中无条件写 store；
- refresh API 先返回 token，调用 guarded adoption；
- terminal error logout 前检查 epoch/user/stale token；
- localStorage 中其他 Tab token 只有 current subject/epoch 可接受；无法安全确定 subject 时宁可继续自己的 refresh，不盲目采用；
- `fetchMeWithRoleHealing` 的直接页面调用全部移除，或改成 coordinator 内部 helper，不再自行 commit。

### 4.8 Full profile contract

Backend integration test 锁定完整 top-level keys，尤其 `merchant` 必须显式 null/object。Frontend 不再使用：

```ts
merchant: me.merchant ?? old.merchant ?? null
```

这避免 API contract 缺陷被旧缓存掩盖。

### 4.9 Avatar renderer

`UserAvatar` 只做纯展示：

- `src` 变化立即渲染；
- internal image-error state 应在 `avatarUrl` 变化时重置；
- null/error 显示首字符 fallback；
- 不 fetch profile、不写 store；
- Profile 的 camera overlay 组合在外层 button，避免通用 avatar 自带业务 action；
- desktop/mobile 使用同组件、不同 size；
- 测试 source change、null、error reset、a11y。

---

## 5. API 与缓存实施

### 5.1 Controller

在 `me` 和 `updateMe` 成功响应前设置：

```ts
res.setHeader('Cache-Control', 'private, no-store')
```

测试读取实际 HTTP header。不得把 avatar blob 的 `public, max-age=31536000, immutable` 改成 no-store；两个 cache policy 面向不同资源：

| 资源 | Policy | 原因 |
| --- | --- | --- |
| `/api/auth/me` JSON | `private, no-store` | 每次是当前鉴权主体的可变资料 |
| `/uploads/:hash` blob | `public, max-age=31536000, immutable` | URL 已按内容寻址，不变字节 |

### 5.2 Projection test

GET 与 PATCH 都断言：

- id/email/role/status/nickname/avatarUrl/points/emailVerified/createdAt/merchant；
- merchant user 的完整安全 merchant projection；
- normal user 的 `merchant:null`；
- 响应不含 password、refresh token、MFA secret、pointAccount 内部字段。

---

## 6. 分阶段实施

### Phase A — Freeze、delta audit 与 fixtures

- Owner 批准 O-ID-01～12；六件套/PAR-CMI 同步 Frozen；协调者把 Freeze 时最新 `origin/develop` 记为 `D`，并以 `D` 为直接父提交创建 docs-only Frozen spec commit `S`；
- 用 `git rev-parse <S>^` 证明 `S^=D`；Identity Backend 与 Identity Core 均从 `S` 分叉，Identity Frontend 只能从以 `S` 为祖先的 Core contract tip 开始；任何较新的 develop 只能显式纳入且不得丢失 `S` 祖先；
- `rg` 枚举所有 `/me`、`setUser`、`updatePoints`、login/logout/token writer，并逐项映射到 Spec §11.4 的唯一迁移任务；新 caller 未分配 Owner 时不得开工；
- 建 AuthUser contract fixture、race scenario table，并为通知 Layout release `N`、Identity Core/FE handoff `C_ID` 与 Identity merge baseline `M_ID` 建待填 ledger；
- 不改业务。

### Phase B — Backend cache contract

- 写失败测试；
- 加 GET/PATCH no-store；
- 锁定完整 projection；
- 跑 auth/uploads 回归；
- 与 frontend Core 可并行。

### Phase C — Store state machine

- 给 authStore 增加非持久化 runtime metadata；
- login/logout/delta/token guard 原子动作；
- persist hydration 测试；
- 暂不改 Layout；
- 保留编译兼容 adapter 仅限同一 commit 迁移期，卡完成前清除裸 setter。

### Phase D — Coordinator 与 race harness

- 实现 commit validator、GET coalescing、trigger TTL；
- 接 role healing 和 session-safe refresh；
- 实现 profile FIFO/reconcile；
- 用 deferred transport 覆盖全部乱序矩阵；
- 与 UI 并行的前提是导出 contract fixture 已提交。

### Phase E — Profile 与共享头像组件

- 实现 UserAvatar；
- ProfileIdentityCard 改用 coordinator，不闭包 merge；
- nickname draft 同步规则；
- avatar upload stale guard、clear；
- MobileNavDrawer 改用 UserAvatar；
- App ProtectedRoute 改用 coordinator；
- 不改 Layout。

### Phase F — 通知释放与 Layout Integration

入口 Gate：通知 T-FE-002 的 release `N` 已记录、其 suite 绿、Layout 无未提交工作；Identity Core/FE 已形成以 `S` 为祖先的 handoff `C_ID`；协调者已建立同时以 `N` 与 `C_ID` 为祖先的 `M_ID`，且两条 `git merge-base --is-ancestor` 均为 exit 0。

- Identity Integration Owner 只能从 `M_ID` 开始工作；不得从 `N`、`C_ID` 或较新的 develop 单边分叉后再口头声称“共同可达”；
- 亲自阅读最终 Layout 的相关 effects/avatar/notification lifecycle；
- 删除 pathname `/me → setUser`；
- 接 visibility calibration；
- desktop avatar 接 UserAvatar；
- 不重写通知 stream/polling/invalidation；
- 运行 identity + notification frontend suites。

所有 consumer 迁移完成后，协调者把 `authStore.ts` 的“仅删除 deprecated raw `setUser`”小锁交给 Identity Integration Owner，单独提交 writer-closure commit；该 commit 不再修改同步算法。静态 caller 数为零后才允许进入 Final QA。

### Phase G — Browser、resilience 与发布

- 真实浏览器 desktop/mobile；
- route interception 控制旧 GET/old PATCH/old 401 顺序；
- 真实 backend header/upload immutable 测试；
- build/typecheck/lint；
- 对照 AC/Checklist 回填 evidence；
- 灰度与回滚 rehearsal。

---

## 7. 依赖与并行图

~~~text
Spec Frozen
    │
    ├──────────────┐
    ▼              ▼
Backend headers   Store state machine
    │              │
    │              ▼
    │         Coordinator + race harness
    │              │
    │         ┌────┴─────────┐
    │         ▼              ▼
    │      Profile UI    App/Mobile avatar
    │         └────┬─────────┘
    │              │
    └──────────────┼─────────────► Core Gate
                   │
Notification release N ───────┐
                              ├─► M_ID（N 与 C_ID 均为祖先）
Identity Core/FE handoff C_ID ┘              │
                                             ▼
                              Layout Integration（single owner）
                                             │
                                             ▼
                              Identity + Notification Regression
~~~

Catalog Foundation、Catalog BE/FE、Merch BE/FE 与 Identity Core 无文件依赖，可并行。Identity 不等待 FND-CMI-001；CMI 不等待 Identity。

---

## 8. 测试策略

### 8.1 Pure state/unit

- login/logout epoch transitions；
- runtime metadata 不持久化；
- updatePoints 推进 userRevision；
- validator 每个 reject reason；
- latest request、mutation barrier；
- queue rejection 后继续；
- UserAvatar URL change/error/null/a11y。

### 8.2 Deterministic race

使用 deferred Promise 而非 `setTimeout` 猜顺序：

- GET before PATCH, response after PATCH；
- GET A/B 全排列；
- PATCH nickname/avatar 交错；
- updatePoints during PATCH；
- logout/login during GET/upload/PATCH/refresh；
- role-healing first GET/refresh/second GET 与其他 sync 交错；
- current/old 401；
- queue first failure then second success。

至少循环/属性化生成 1,000 个允许排列，断言最终 profile 和副作用计数。

### 8.3 API integration

- 真实 Express + 测试 DB 的 `/me` fields/header/auth；
- PATCH nickname/avatar/null/invalid URL；
- upload hash key、不同/相同内容、immutable bytes/header；
- 不使用 mock response 证明 Cache-Control。

### 8.4 Browser E2E

- desktop Navbar img src 与实际显示；
- mobile drawer/profile 相同；
- delayed old `/me` after PATCH；
- clear avatar；
- image load failure fallback；
- pathname request count；
- visibility threshold；
- logout/login stale response；
- notification bell/SSE/polling smoke。

### 8.5 Static/contract

```bash
rg -n "\.then\(setUser\)|getState\(\)\.setUser|setUser\(\{ \.\.\.user" src
rg -n "fetchMeWithRoleHealing" src
rg -n "WebSocket|EventSource|BroadcastChannel" src/auth src/stores/authStore.ts
git diff --name-only <notification-release-sha>...HEAD
```

匹配需人工分类，但以下必须为零：页面直接提交 `/me`、Profile 闭包 merge、本规格新增 realtime transport、Identity diff 修改 forbidden files。

---

## 9. 可观测性与调试

- coordinator 结果使用 typed reason，开发环境可 debug，生产只聚合低基数计数；
- 记录 latest request/pending mutation 仅为数字，不输出 AuthUser；
- mismatch/security 事件不把 token/profile body写日志；
- E2E failure artifact 包括 request sequence timeline、截图、trace，不包括 Authorization header；
- 若现有项目没有前端 telemetry，不为本规格引入新 vendor；保留可注入 observer 与测试计数即可。

---

## 10. 发布顺序

1. 后端 no-store 与完整 projection contract 可先发布，完全向后兼容。
2. 前端 Store/Coordinator/Profile/Mobile/App Core 一起发布，不允许只发布半套 raw setter 过渡态。
3. Layout Integration 必须包含通知 release commit，独立小 commit 接线。
4. 先 internal/staging 验证 desktop/mobile 和乱序 E2E。
5. 灰度观察 profile sync error、stale discard 分布、auth logout 异常、`/me` 请求率。
6. 全量后保留旧 API fields；本规格不需要 DB rollout。

兼容窗口不允许同时保留两条 `/me` commit 路径。需要分批上线时，后端先、前端原子切换。

---

## 11. 回滚

### 11.1 Backend

`private,no-store` 可安全保留，无需随前端回滚。除非出现代理兼容故障，否则不回退敏感 profile cache policy。

### 11.2 Frontend

- 回滚 Identity commits 到通知完成基线；
- 必须整体回滚 coordinator/store/Layout 接线，不能只恢复裸 `setUser` 的一个调用点；
- 保持通知 T-FE-002 commits；不得用 checkout 覆盖其 Layout；
- 回滚不删除头像对象、不改用户 DB profile。

### 11.3 数据

无 schema/data migration。已成功 PATCH 的 nickname/avatar 是用户明确操作，不因前端回滚自动撤销。

---

## 12. 停止条件

任一情况发生，暂停对应卡并请求 Owner/协调者：

- 通知 Layout 仍有未提交变更或未提供释放 SHA；
- 实施需要修改 `auth middleware`、appStore、notification protocol 才能继续；
- `/me` 实际不再返回完整 projection；
- refresh guard 会改变 refresh cookie rotation/重放安全语义；
- 发现另一 Agent 同时修改 authStore/App/Profile/MobileNavDrawer；
- 需要跨 Tab即时同步才能满足 Owner 预期；
- 测试只能靠固定 sleep 或关闭通知通过；
- stale response 仍可引发 store/token/logout/Toast 任一副作用。
- delta audit 发现新的 `/me` commit caller 但尚未写入 Spec §11.4 并指定 Owner。

---

## 13. 完成信号

- O-ID-01～12 已批准且六件套/PAR-CMI Frozen；
- Frozen docs-only `S` 的直接父提交 `D` 已记录；Backend/Core/FE 与最终候选 HEAD 均可证明保留 `S` 祖先；
- Backend、Core、Layout Integration 均为独立可审 commit；
- 24 个 AC 有自动化证据；
- deterministic race、真实 API、desktop/mobile browser、通知回归全绿；
- static scan 无裸 commit/闭包 merge/forbidden file；
- deprecated raw `setUser` 已在独立 writer-closure commit 删除，不只是不再调用；
- 无 migration、无 realtime transport、无生产数据操作；
- Evidence Ledger 记录 `D/S/N/C_ID/M_ID`、两条 `N/C_ID → M_ID` ancestor 命令、Identity commits、测试命令与结果。
