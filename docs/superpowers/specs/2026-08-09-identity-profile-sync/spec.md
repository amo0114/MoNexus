# Spec: 当前用户资料同步与头像一致性

| 字段 | 值 |
| --- | --- |
| Spec ID | SPEC-IDENTITY-SYNC-001 |
| 版本 | 0.1.0 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation** |
| Owner | MoNexus Project Owner |
| 审查基线 | `develop@da38dd0580eeac737f5291556b9dbdf832d91970` |
| 并行契约 | [PAR-CMI-001](../2026-08-09-catalog-merch-identity-parallel-contract.md) |
| 关联规格 | SPEC-NOTIFY-RT-001（仅 Layout 文件锁，不改变其协议） |

> 本版本已经 Owner 批准并冻结。实施仍须以 docs-only `S` 为祖先，并逐卡满足 Entry Gate；Frozen 状态不构成预填下游证据的授权。

---

## 1. 目的、现状与问题

### 1.1 目的

修复用户在个人中心更新昵称或头像后，个人中心、桌面 Navbar、移动导航与后续页面之间显示不一致的问题；同时消除 `/auth/me`、资料 PATCH、token refresh 与会话切换之间的过期响应覆盖。

本问题的核心不是“缺少 WebSocket”，因为资料编辑与 Navbar 位于同一个 SPA、已经共享 Zustand store。正确边界是：服务端成功响应直接更新当前 Tab 的唯一 AuthUser 副本；后台 `/me` 只用于权威校准，并且不得覆盖更新更晚的本地权威响应。

### 1.2 已核实基线

| 已核实事实 | 代码位置 | 影响 |
| --- | --- | --- |
| `authStore.setUser` 无条件整对象替换，且没有 session/request revision | `src/stores/authStore.ts` | 任意晚到响应都可覆盖新状态 |
| `ProtectedRoute` 登录后调用 `fetchMeWithRoleHealing().then(setUser)` | `src/App.tsx` | 与 Layout 的请求并发 |
| `Layout` 在每次 pathname 变化调用 `/me` 后裸 `setUser` | `src/components/Layout.tsx` | 页面导航可把刚更新的头像回滚 |
| 昵称、上传头像、清除头像都用闭包旧 `user` 合并 PATCH 响应 | `src/components/profile/ProfileIdentityCard.tsx` | 并发资料 mutation 可互相丢字段 |
| 桌面 Navbar 的“头像”固定渲染 `User` icon | `src/components/Layout.tsx` | store 正确也不会显示真实头像 |
| Mobile drawer 固定渲染 `User` icon | `src/components/MobileNavDrawer.tsx` | 移动身份区不会显示真实头像 |
| `/me` GET/PATCH 返回完整当前用户 projection | `server/src/modules/auth/service.ts` | 可以直接原子替换，无需旧对象 merge |
| `/me` GET/PATCH 未设置显式 `Cache-Control` | `server/src/modules/auth/controller.ts` | 鉴权资料响应缺少明确缓存边界 |
| 上传 key 是内容 SHA-256 派生，GET 为一年 immutable | `server/src/lib/storage/types.ts`、`uploads/routes.ts` | 正确策略应保持，不应覆盖同 URL |
| token refresh 在完成时无条件写 `accessToken` | `src/api/authRefresh.ts` | 旧 refresh 可能污染已切换会话 |
| `updatePoints` 等局部用户更新与 `/me` 整对象替换共享 user | `src/stores/authStore.ts` | 资料修复不能反向覆盖更晚积分响应 |

### 1.3 可复现竞态

~~~text
t0  ProtectedRoute 发起 GET /me #41，ticket={epoch:7,user:12,revision:5}
t1  Layout 因路由变化发起 GET /me #42
t2  用户 PATCH avatar，新 profile 已在服务端提交并返回
t3  UI 写入 avatarUrl=/uploads/new-hash.webp
t4  旧 GET #41 最后返回 avatarUrl=/uploads/old-hash.webp
t5  当前代码裸 setUser(#41)，个人中心/Navbar 回到旧状态
~~~

另一个独立缺陷是：即使 t3 后 store 始终正确，当前 Navbar 与移动抽屉也只渲染固定 `User` 图标，所以用户仍会观察到“头像没变”。本规格必须同时修复提交协议和渲染接线，不能只做其中之一。

### 1.4 根因

1. 当前用户状态有多个非协调写入者，没有“谁有资格提交”的单一协议。
2. fetch 与 mutation 没有 happens-after 信息；网络完成顺序被错误当成业务新旧顺序。
3. React handler 使用旧闭包 merge，完整服务端 profile 的权威性被削弱。
4. session/token 主体切换没有 generation，旧响应无法识别自己属于旧会话。
5. 导航身份组件没有消费 `avatarUrl`。

### 1.5 成功标准

- PATCH 成功被当前会话接受后，同一 Tab 内所有已挂载头像/昵称视图在下一次 React commit 中一致，不需要刷新或再次 GET。
- 任何更早发起的 `/me`、旧会话 PATCH、旧 refresh 或旧 401 均不能覆盖/登出新会话。
- 昵称与头像操作可由用户交错触发，但服务器 PATCH 不并发执行，最终 store 与最终 GET `/me` 一致。
- Navbar、移动抽屉、个人中心都真实渲染 `avatarUrl`；清除后一起恢复 fallback。
- 不引入数据库 migration、WebSocket、SSE、跨 Tab broker 或新的全局数据层。

---

## 2. 范围

### 2.1 范围内

- authStore 的 session epoch、user revision、安全 commit primitive 与持久化边界；
- profile sync coordinator、请求去重、新鲜度与 role-healing 接入；
- token refresh 结果的 current-session guard；
- nickname/avatar mutation 串行队列与上传后的 session revalidation；
- `ProtectedRoute`、资料相关 workflow 与最终 `Layout` 的统一接线；
- GET/PATCH `/auth/me` 的 `private, no-store` 响应头；
- 可复用 `UserAvatar` 组件；
- 桌面 Navbar、MobileNavDrawer、ProfileIdentityCard 的即时一致性；
- 受控乱序、会话切换、并发 mutation、role healing、缓存和真实浏览器测试；
- 与通知实时化的文件锁、接线 commit 和回归 Gate。

### 2.2 明确范围外

- 通过 WS/SSE/Web Push 广播用户资料；
- 多浏览器 Tab 的主动 BroadcastChannel/localStorage 同步；
- 跨设备即时同步；
- 修改昵称/头像字段的业务校验、裁剪器、压缩器或图片审核；
- 替换现有对象存储、修改内容寻址算法或新增图片表；
- 乐观更新、离线写队列、ETag/If-Match、多设备冲突编辑；
- 通知 unread/SSE 状态、订单实时化、商品/分类/推广；
- `server/src/middlewares/auth.ts`、`src/stores/appStore.ts` 或通知模块修改；
- 删除旧头像对象；继续由既有 StoredObject/GC 策略处理未引用对象。

---

## 3. 术语

| 术语 | 定义 |
| --- | --- |
| Current User | 当前 Tab 中 access token 所代表且 authStore 正在显示的用户主体 |
| Authoritative Profile | GET/PATCH `/auth/me` 返回的完整 AuthUser 安全 projection |
| Session Epoch | 仅进程内单调递增的会话代次；登录、登出或主体切换时推进 |
| User Revision | 当前 epoch 内每次被接受的 user 完整替换或局部权威更新所推进的单调值 |
| Profile Mutation Revision | 每次资料 mutation 入队时推进的 barrier；让已经/即将发生的 GET 识别写意图 |
| Request ID | 每次真正发出 profile sync 时分配的进程内单调编号 |
| Commit Ticket | `{sessionEpoch, expectedUserId, userRevision, profileMutationRevision, forceGeneration, requestId}`；force generation 可由 coordinator 私有维护 |
| Current-session Guard | 响应落地前验证它仍属于相同 epoch、相同 user 和允许的 revision |
| Coordinator | 唯一组织 `/me` fetch、role healing、资料 PATCH 与 commit 的前端模块 |
| Full Replace | 使用服务端完整 AuthUser 替换 store user，不与闭包旧对象 merge |
| Immutable Avatar URL | 内容改变则 key/URL 改变；给定 URL 的字节永不改变 |
| Identity Core | 不触碰 Layout/通知共享热点即可实现和测试的 store/coordinator/profile/component 部分 |
| Identity Integration | 通知 T-FE-002 释放 Layout 后进行的唯一宿主接线卡 |
| Frozen Spec Baseline `S` | 直接父提交为 Freeze 时最新 develop `D`、且只包含三套六件套与 PAR-CMI-001 的文档提交；所有 Identity 实施链必须保留其祖先关系 |
| Identity Merge Baseline `M_ID` | 同时以通知 Layout release `N` 与 Identity Core/FE handoff `C_ID` 为祖先的接线基线 |

---

## 4. Owner 冻结决策

| ID | 决策 | 理由/后果 |
| --- | --- | --- |
| O-ID-01 | 不引入 WS/SSE；同 Tab 由共享 store 同步 | 网络推送不能修复本地 stale overwrite，且扩大连接/鉴权复杂度 |
| O-ID-02 | authStore 是当前 Tab 唯一 AuthUser 副本；`/me` 只能由 coordinator commit | 消除多个页面各自拥有 current profile |
| O-ID-03 | 使用非持久化 epoch/revisions/request ID/expected user ticket | 以业务顺序而非完成顺序决定可提交性 |
| O-ID-04 | 所有 profile PATCH 进入 per-session FIFO；成功响应 full replace | 避免 nickname/avatar 并发响应互相覆盖 |
| O-ID-05 | login/logout/主体切换推进 epoch；同主体 refresh 不推进，但 token commit 要 guard | 隔离旧会话，同时不让正常 refresh 重建整个 UI |
| O-ID-06 | `/me` GET/PATCH 显式 `private, no-store`，返回完整 projection | 缓存不参与资料新旧判断，客户端无需旧对象补字段 |
| O-ID-07 | 保持内容寻址 immutable avatar | 浏览器/CDN 可长期缓存，且新图无需 cache-busting |
| O-ID-08 | 三个用户可见身份面共同使用 `UserAvatar` | 修复固定 icon，并锁定 fallback/a11y 一致性 |
| O-ID-09 | 删除 pathname 裸 fetch；使用受保护入口、显式完成、可见性校准触发器 | 降低请求风暴并让触发行为可测试 |
| O-ID-10 | Identity Core 与通知并行；Layout 接线后置，禁止改 auth middleware/appStore | 文件级零冲突，而非依赖最后手工解冲突 |
| O-ID-11 | P0 不做跨 Tab 主动资料广播；保留既有 token-only refresh 协调 | 当前用户问题可在一个 SPA 内闭环；不得借 refresh channel 传播 AuthUser/profile |
| O-ID-12 | stale success/error/401/refresh 均不得影响新会话或发 Toast | 会话安全优先于展示旧操作结果 |

---

## 5. 目标状态与 Store 契约

### 5.1 持久化字段

继续只持久化：

```ts
type PersistedAuthSlice = {
  user: AuthUser | null
  accessToken: string | null
  isLoggedIn: boolean
}
```

不得持久化 request ID、Promise、AbortController、队列、时间戳或 revision。页面 reload 后不存在旧 JS 请求，运行时计数从新实例初始化即可。

### 5.2 运行时字段

目标最小运行时契约：

```ts
type RuntimeIdentityState = {
  sessionEpoch: number
  userRevision: number
  profileMutationRevision: number
}

type ProfileCommitTicket = {
  sessionEpoch: number
  expectedUserId: number
  userRevision: number
  profileMutationRevision: number
  forceGeneration: number
  requestId: number
}
```

`requestId`、force generation、latest issued ID、in-flight Promise、mutation queue 与 `lastSuccessfulSyncAt` 可由 coordinator 模块私有保存；实施者不得把不可序列化对象放进 Zustand persist。

### 5.3 Store 对外动作

冻结语义，不冻结确切函数名：

| 动作 | 必须行为 |
| --- | --- |
| login(profile, token) | 建立/替换主体，推进 epoch，原子写 profile/token/isLoggedIn，推进 userRevision |
| logout() | 先推进 epoch，再清空 user/token/login；使所有旧 ticket 失效 |
| setAccessTokenIfCurrent(ticket, token) | 只在 epoch/user/预期 stale token 仍匹配时写入；同主体不推进 epoch |
| commitProfileIfCurrent(ticket, profile) | 完整验证 ticket 后 full replace，并推进 userRevision |
| applyCurrentUserDelta(expectedUserId, delta) | 对订单积分等服务端权威局部响应做函数式更新，并推进 userRevision |
| updatePoints(points) | 保留现有调用面，但内部必须走安全 delta 并推进 userRevision |
| beginProfileMutation(expectedUserId) | 同步推进 profileMutationRevision，返回 mutation ticket |

`setUser(AuthUser)` 不得继续作为任意组件可调用的无条件 API。可删除、改为 coordinator 私有 action，或保留为带 ticket 的受控函数；仓库静态检查不得再出现 `.then(setUser)` 或 `getState().setUser(/meResponse)`。

### 5.4 主体定义

- `expectedUserId` 以 authStore 当前 `user.id` 为准，不从响应自我声明“当前”。
- 响应 `profile.id` 必须等于 ticket.expectedUserId；不等则视为安全异常，拒绝提交并记录脱敏 metric。
- token refresh 的新 token subject（如客户端可解码）必须与当前用户一致；至少要验证 epoch、当前 user ID 和发起时 stale token 未被替换。
- access token 的常规同主体轮换不推进 epoch；明确 login、logout、terminal refresh logout 与不同 `user.id` 的 login 推进。

---

## 6. Profile Sync Coordinator

### 6.1 唯一入口

建议新增 `src/auth/profileSync.ts`（确切目录可按仓库约定调整），公开：

```ts
syncCurrentProfile(reason, options?): Promise<ProfileSyncResult>
mutateCurrentProfile(patch, reason): Promise<ProfileMutationResult>
uploadAndSetCurrentAvatar(file): Promise<ProfileMutationResult>
```

调用方只能根据结果显示 UI，不得自行对响应调用 store setter。

### 6.2 GET 算法

`syncCurrentProfile` 必须满足以下顺序：

1. 读取当前 epoch/user/login；未登录则返回 `skipped:not_authenticated`。
2. 等待属于该 epoch 的 profile mutation FIFO 排空；等待期间主体改变则返回 `discarded:session_changed`。
3. 应用触发器新鲜度/同请求去重；普通校准允许多个调用者等待同一个 in-flight Promise，barriered force 必须遵守 §6.3 的 dispatch-after-invocation 规则。
4. 分配 requestId，捕获完整 Commit Ticket，并把它登记为当前 epoch 的 latest issued request。
5. 执行 GET `/auth/me`；若 token role 与 profile role 不一致，最多一次 session-safe refresh，再 GET 一次。第一次 profile 绝不提交。
6. 提交前同时验证：
   - sessionEpoch 未变；
   - current user ID、response profile ID 均等于 expectedUserId；
   - requestId 等于本 epoch latest issued request；
   - userRevision 与捕获值相同；
   - profileMutationRevision 与捕获值相同；
   - ticket.forceGeneration 不低于当前 required force generation；
   - 当前没有 queued/in-flight profile mutation。
7. 全部满足才 full replace；否则返回明确的内部 discarded reason，不改 store、不发用户 Toast。若唯一拒绝原因是 `user_revision`，登记一个按最新 revision 合并的 trailing reconcile。
8. 仅 accepted response 更新 `lastSuccessfulSyncAt`。

允许 GET 丢弃、重复、乱序；最终状态来自最新可提交的 REST profile。Coordinator 不使用响应完成时间推断新旧。`user_revision` trailing reconcile 在当前 in-flight 和 mutation queue 结束后发出；同一目标 revision 只保留一个 trailing slot。若它又被更高 revision 失效，则更新 slot 并再发一轮，不做同步自旋或固定次数忙重试。

### 6.3 请求合并与新鲜度

| reason | 网络行为 |
| --- | --- |
| `protected-entry` | 当前 epoch 首次进入受保护区时绕过 TTL；可由相同 epoch/user 的既有 in-flight 满足 |
| `visibility-calibration` | `document.visibilityState=visible` 且距上次 accepted sync ≥60 秒才请求 |
| `merchant-application-complete` | barriered force；必须由调用发生后才 dispatch 的 GET 满足 |
| `email-verification-complete` | barriered force；必须由调用发生后才 dispatch 的 GET 满足 |
| `manual-retry` | barriered force；绕过 TTL，不能复用调用前已 dispatch 的 GET |
| `profile-mutation-reconcile` | barriered force；PATCH/delta 冲突后在 queue 排空再 dispatch |
| `user-revision-reconcile` | coordinator 内部 trailing force；合并相同/更低 revision |

pathname 变化本身不是触发器。TTL 是网络抑制，不是正确性来源；显式 mutation 成功不等待 TTL。Barriered force 调用先推进 required force generation，使此前已 dispatch 的 GET 在 commit validator 处立即失效；只有 `ticket.forceGeneration >= callerGeneration` 的新请求可满足该 caller。多个尚未 dispatch 的 force 可合并成一个 trailing GET；force 到达时若 trailing GET 已 dispatch，则再排一个，避免用业务完成前的快照冒充完成后校准。

### 6.4 Role healing

- role healing 是一次 sync 内的子流程，而不是另一个可独立 commit 的 fetch。
- 第一次 `/me` 只用于比较服务端 role；若一致则可进入 ticket commit。
- 若不一致，刷新 access token 并重新 `/me`；只有第二次完整 profile 可进入 commit。
- refresh 返回 token 前会话改变时，token/profile 均丢弃；旧流程不得 logout 新会话。
- 一次 sync 最多 refresh 一次，避免无限循环。
- 最终仍 role skew 或 terminal auth error 时，只有当前 ticket 仍属于当前 epoch 才能触发 logout。

### 6.5 GET 错误语义

| 情况 | 行为 |
| --- | --- |
| 网络错误/5xx | 保留已持久化 user，记录失败；不登出、不清头像 |
| 当前会话的 terminal 401/refresh 失败 | 走既有安全登出，但先验证 epoch/user |
| 旧会话的 401/403/失败 | 丢弃，不登出、不 Toast |
| 响应 user ID 不匹配 | 拒绝提交，记录 security metric；不泄露响应内容 |
| stale request/mutation revision | 预期控制流，debug/metric 计数，不作为 error log 风暴 |
| stale userRevision | 保留当前 user，合并登记一次 `user-revision-reconcile`，不直接递归请求 |

---

## 7. Profile Mutation 协议

### 7.1 FIFO 与 barrier

所有昵称/头像 PATCH 共享一个 per-session FIFO：

1. 调用 `mutateCurrentProfile` 时同步验证 payload，并立即推进 `profileMutationRevision`；这一步是 GET barrier。
2. 捕获 epoch/user；请求排在该 epoch 已有 mutation 之后。
3. 真正发送前再次验证 epoch/user；已切换则不发请求。
4. 同一时刻最多一个 PATCH `/auth/me` 在飞。
5. PATCH 成功响应必须是完整 AuthUser，且 ID 与 expectedUserId 相同。
6. 若 epoch/user 未变且没有外部 `userRevision` 并发推进，完整响应原子替换 store 并推进 userRevision。
7. 若订单积分等权威 delta 在 PATCH 期间推进了 userRevision，禁止用可能较旧的完整响应覆盖；立即经 FIFO 后执行 `profile-mutation-reconcile`，以 accepted GET 完成后再向调用方报告 applied。
8. 队列中的下一 PATCH 只在上一项 settled 后发出；失败不阻塞后续项。

该协议允许用户在头像上传期间保存昵称：上传本身不占 PATCH 队列，先准备好 URL 的操作再入队；实际 PATCH 仍串行，后一个完整 profile 必然包含先一个已提交字段。

### 7.2 禁止闭包 merge

以下模式为 P0 静态失败：

```ts
const me = await updateMe(patch)
setUser({ ...user, ...me })
```

不得用 `merchant: me.merchant ?? user.merchant` 补齐；`/me` 的完整 projection 必须显式包含 `merchant: object|null`。若后端漏字段，应修 API contract/test，而不是从旧前端对象补值。

### 7.3 头像上传

~~~text
capture {epoch,userId}
  → POST /uploads/image
  → validate same epoch/user
  → enqueue PATCH /auth/me {avatarUrl: returned.url}
  → coordinator commit
  → all avatar surfaces rerender
~~~

- 上传期间 logout/login 后，不得把 URL PATCH 到新用户。
- 同一 user/epoch 内 access token 正常 refresh 不取消上传；PATCH 使用当前 token。若 role/status 已使操作无权，按服务端错误失败，不把旧 token 结果写回。
- 已上传但因 session change 未引用的对象不做同步删除，以免误删内容寻址共享对象；交给既有 GC。
- 不对 URL 添加 `?v=timestamp`；不同内容的 hash key 自然产生不同 URL。
- 相同字节重复上传得到相同 key 是合法 dedupe，不视为“头像未更新”。
- `avatarUrl:null` 走同一 FIFO 和 full-replace 协议。
- 上传按钮和清除按钮共享 avatar-operation busy gate；同一会话不会在早先上传仍准备 URL 时接受后发 clear/第二次 upload。Nickname 可并行准备，但实际 PATCH 仍进入共享 FIFO。

### 7.4 UI busy/toast

- 昵称与头像可以各有独立 busy 状态；同字段重复操作在 pending 时禁用。
- “头像已更新/昵称已更新”只在当前 session 的 operation 最终 applied 后显示。
- 服务器已成功但会话已切换的 stale operation 不在新会话显示 Toast。
- mutation 失败不做 optimistic rollback，因为本规格不做 optimistic write；保留当前 store。
- 昵称输入框在非 editing 状态随 accepted profile 同步；正在编辑时不覆盖用户草稿。成功后以服务器规范化 nickname 收敛。

---

## 8. 会话与 Token Refresh

### 8.1 Session epoch 转换

| 事件 | epoch | user/profile | token |
| --- | --- | --- | --- |
| cold hydrate | 新 runtime epoch | 使用持久化快照，随后 protected-entry 校准 | 使用持久化 token |
| login（即使同 ID） | +1 | 原子写 login profile | 原子写 login token |
| logout | +1 后清空 | null | null |
| login 为不同 user.id | +1 | 新主体 | 新 token |
| 同主体 refresh 成功 | 不变 | 不变 | guard 后替换 |
| terminal refresh failure | 仅当前会话可 logout，因 logout +1 | null | null |

每次明确 login 都推进 epoch，可以简单、可靠地使登录页之前的异步任务失效。

### 8.2 Refresh guard

refresh 发起时至少捕获：

```ts
{ sessionEpoch, expectedUserId, staleAccessToken }
```

写新 token 时必须仍满足：epoch 相同、current user ID 相同、当前 token 仍等于 staleAccessToken（或已经等于相同 refresh 结果）。如果不满足，返回 discarded/采用当前 token，不得覆盖。

跨 Tab `navigator.locks` 与 localStorage token adoption 可以保留，但仅传播 access token，adoption 前必须验证 current epoch/user/stale token（可解码时还验证 subject）。禁止经该通道传播 AuthUser/profile；本规格不扩展成完整跨 Tab profile 同步。

---

## 9. `/api/auth/me` 契约

### 9.1 GET

```http
GET /api/auth/me
Authorization: Bearer <access-token>

200 OK
Cache-Control: private, no-store
Content-Type: application/json
```

响应继续为完整安全 projection：

```ts
type AuthUser = {
  id: number
  email: string
  role: 'user' | 'admin' | 'merchant'
  status: string
  nickname: string | null
  avatarUrl: string | null
  points: number
  emailVerified: string | null
  createdAt: string
  merchant: {
    id: number
    name: string
    status: string
    commissionRate: string
  } | null
}
```

可选字段在 TypeScript 兼容窗口中可以暂时保留，但实际 200 body 必须稳定包含 `nickname/avatarUrl/emailVerified/merchant`，不得用“省略代表没变”的 PATCH projection。

### 9.2 PATCH

现有请求字段保持：

```ts
{ nickname?: string; avatarUrl?: string | null }
```

- strict schema、nickname 1–20、平台图床 URL、null 清除语义保持。
- 200 返回更新提交后的完整 AuthUser，而不是 patch echo。
- 设置 `Cache-Control: private, no-store`。
- 空 patch、外部 avatar URL、非法 nickname 继续 400，不改变 store。
- P0 不新增 ETag/If-Match；同一客户端由 FIFO 保序，多客户端同字段仍按数据库最后提交结果并由后续 GET 收敛。

### 9.3 数据与日志安全

- 不记录 access token、refresh cookie、完整 `/me` body、email 或 avatar URL query secret。
- stale metric 标签仅使用 reason，不使用用户 PII；必要时 user ID 仅在受控结构化日志按既有策略记录。
- Cache-Control 测试必须覆盖成功 GET/PATCH；错误响应沿用全局敏感响应策略。

---

## 10. UserAvatar 与可见身份投影

### 10.1 单一组件

建议 `src/components/identity/UserAvatar.tsx`：

```ts
type UserAvatarProps = {
  avatarUrl: string | null | undefined
  displayName: string
  size: 'sm' | 'md' | 'lg'
  testId?: string
  decorative?: boolean
}
```

渲染规则：

1. `avatarUrl` 非空时 `<img src=... class=object-cover>`；URL 变化自然换图。
2. null/加载失败时显示 displayName 首个可见字符；无字符为 `?`。
3. 有相邻可读姓名时图片 `alt=""`；单独作为身份内容时提供可读 alt。不得把 URL 放进 alt/title。
4. 图片失败只影响本组件 fallback，不把服务端 `avatarUrl` 清空，也不触发无限重试。
5. focus ring、圆形尺寸、layout shift 与现有 design token 对齐。

### 10.2 接入点

| 接入点 | P0 行为 | Test ID 建议 |
| --- | --- | --- |
| ProfileIdentityCard | 可编辑 64px 头像，保留 Camera overlay | `profile-avatar` |
| Desktop Navbar | ≥md 显示真实头像/fallback，点击进 Profile | `nav-profile-avatar` |
| MobileNavDrawer | 身份卡显示真实头像/fallback | `mobile-nav-profile-avatar` |

BottomTabBar 的“我的”图标不在 P0 必改范围，因为它是导航语义 icon，不是用户身份头像；不得为了本规格改其信息架构。

### 10.3 即时一致性

三个接入点都直接选择 `useAuthStore(s => s.user?.avatarUrl/nickname/email)`，不得复制为长期 local state。Profile 的 nickname 编辑 draft 是唯一允许的 local state，且遵守 §7.4。

---

## 11. 触发器与生命周期

### 11.1 ProtectedRoute

- 登录 epoch 首次进入受保护路由调用 `syncCurrentProfile('protected-entry')`。
- transient failure 软失败保留缓存用户。
- 只有 coordinator 判定“当前会话 terminal auth failure”才能 logout。
- ProtectedRoute 不再持有 `setUser`。

### 11.2 Layout

- 删除 pathname effect 中的动态 import + `/me → setUser`。
- Identity Backend/Core 从 Frozen spec baseline `S` 分叉，Frontend 从包含 `S` 的 Core contract tip 开始；完成后形成 `C_ID`。
- 通知 T-FE-002 释放 Layout 并形成 `N` 后，协调者建立同时以 `N`、`C_ID` 为祖先的 `M_ID`；两条 `git merge-base --is-ancestor` 必须为 exit 0，Identity Layout 只能从 `M_ID` 开始。
- Layout 仅接入 visibility calibration 和 `UserAvatar`。
- Identity 不重写通知的 stream/polling/useEffect；接线必须基于通知完成 commit 做最小 diff。
- 用户 ID 变化仍由 authStore 正常驱动通知 lifecycle；identity coordinator 不调用 appStore。

### 11.3 显式业务完成

现有会改变 `/me` projection 的流程（如商家申请、邮箱验证）应调用 coordinator 强制校准，不能直接 `getMe().then(setUser)`。积分更新保留业务响应的 `updatePoints`，但该 action 必须推进 userRevision，使旧 `/me` 无资格覆盖。

### 11.4 基线 Profile 写入点与唯一迁移归属

| 基线文件/符号 | 当前问题 | 唯一迁移任务 |
| --- | --- | --- |
| `src/App.tsx` / `ProtectedRoute` | `fetchMeWithRoleHealing().then(setUser)` | T-ID-FE-002 |
| `src/components/Layout.tsx` pathname effect | 动态 `/me` 后 `getState().setUser` | T-ID-INT-001（通知释放后） |
| `src/components/profile/ProfileIdentityCard.tsx` | 三个 PATCH 用闭包旧 user merge | T-ID-FE-001 |
| `src/pages/MerchantApplyPage.tsx` | `getMe()` 后 direct setUser | T-ID-FE-002 |
| `src/pages/VerifyEmailPage.tsx` | `getMe().then(setUser)` | T-ID-FE-002 |
| `src/pages/ProductDetailPage.tsx` / points response | 调用兼容 `updatePoints`；基线 action 未推进 revision | caller 文件不改；T-ID-CORE-001 将中央 action 改为 safe delta，T-ID-QA-001 验证 delayed GET 竞态 |
| `src/pages/ProfilePage.tsx` / points response | 调用兼容 `updatePoints`；基线 action 未推进 revision | caller 文件不改；T-ID-CORE-001 将中央 action 改为 safe delta，T-ID-QA-001 验证 delayed GET 竞态 |
| `src/components/OrderDetailModal.tsx` / points response | 调用兼容 `updatePoints`；基线 action 未推进 revision | caller 文件不改；T-ID-CORE-001 将中央 action 改为 safe delta，T-ID-QA-001 验证 delayed GET 竞态 |
| `src/stores/authStore.ts` | 公开无条件 `setUser` | T-ID-CORE-001 引入 deprecated 过渡 adapter；T-ID-INT-002 在全部 caller 迁移后删除 |

Delta audit 新发现的 `/me` commit 或 user-delta caller 必须在开工前加入此表、指定唯一 Owner；不得只“登记以后再说”。`updatePoints` caller 只要继续调用中央 safe-delta action即可保持零业务文件 diff；出现直接 user merge/replace 时必须迁移。`getMeWithAccessToken` 用于登录前 profile 获取时不写既有 session，仍需由 login 原子 transition 接收，不能误归为后台 sync。

---

## 12. 不变量

| ID | 不变量 |
| --- | --- |
| INV-ID-001 | 任一时刻，每个 session epoch 最多一个 profile PATCH 在飞 |
| INV-ID-002 | 任一 `/me` 响应只有 epoch/user/request/userRevision/mutationRevision/forceGeneration ticket 全部匹配才可写 user |
| INV-ID-003 | response profile.id 不得决定 current user；只能验证 expectedUserId |
| INV-ID-004 | login/logout 后所有旧 epoch 的 success/error/401/token 均无副作用 |
| INV-ID-005 | PATCH 成功 profile 使用 full replace，禁止闭包旧 user merge |
| INV-ID-006 | profile mutation 入队立即建立 GET barrier |
| INV-ID-007 | user 的任何权威局部更新推进 userRevision，旧 full profile 不得覆盖；被此 revision 拒绝的 GET 合并触发 trailing reconcile |
| INV-ID-008 | transient profile sync failure不清空已登录用户 |
| INV-ID-009 | 三个身份头像视图消费同一 store 字段和同一 fallback 规则 |
| INV-ID-010 | 新头像内容不覆盖 immutable object key |
| INV-ID-011 | `/me` 成功响应始终 `private, no-store` 且不含敏感 token |
| INV-ID-012 | Identity Core 不修改 Layout/appStore/auth middleware/notifications |
| INV-ID-013 | Layout 只有通知释放后的一名 Identity Integration Owner 修改，且接线分支只能从 `N` 与 `C_ID` 均为祖先的 `M_ID` 开始 |
| INV-ID-014 | P0 不依赖 WS/SSE、跨 Tab channel 或 DB migration |
| INV-ID-015 | stale discard 是预期控制流，不向用户显示错误/成功 Toast |

---

## 13. 功能需求

| ID | 优先级 | 需求 |
| --- | --- | --- |
| REQ-ID-001 | P0 | 建立唯一 profile coordinator 并移除所有 `/me` 裸 store 写入 |
| REQ-ID-002 | P0 | authStore 提供非持久化 sessionEpoch、userRevision、profileMutationRevision |
| REQ-ID-003 | P0 | GET 使用 expected user/request/revision commit ticket |
| REQ-ID-004 | P0 | 同 epoch GET 合并或 latest-request-wins，乱序旧响应丢弃 |
| REQ-ID-005 | P0 | nickname/avatar PATCH 使用 per-session FIFO |
| REQ-ID-006 | P0 | PATCH 成功完整替换 profile；禁止旧闭包 merge |
| REQ-ID-007 | P0 | profile mutation 与 updatePoints 等 user delta 不互相覆盖 |
| REQ-ID-008 | P0 | login/logout/主体切换使旧 response/error/refresh 失效 |
| REQ-ID-009 | P0 | role healing 保持一次 refresh 上限并纳入同一 ticket |
| REQ-ID-010 | P0 | 头像上传完成后重新验证 epoch/user 再 PATCH |
| REQ-ID-011 | P0 | GET/PATCH `/me` 设置 private, no-store 并保持完整 projection |
| REQ-ID-012 | P0 | 引入复用 UserAvatar 并接 Profile、desktop Navbar、mobile drawer |
| REQ-ID-013 | P0 | 清头像/null、图片加载失败和文字 fallback 行为一致可访问 |
| REQ-ID-014 | P0 | pathname 不再直接 fetch profile；按触发器表同步 |
| REQ-ID-015 | P0 | Identity Core/Layout Integration 遵守通知文件锁和 commit 移交 |
| REQ-ID-016 | P0 | 建立乱序、并发、session switch、role-healing 的确定性测试 harness |
| REQ-ID-017 | P0 | 记录低基数 accepted/discarded/error 指标，不记录 PII/token |
| REQ-ID-018 | P1 | 另行评估 BroadcastChannel 多 Tab资料传播，不阻塞 P0 |

---

## 14. 非功能需求

| ID | 类别 | 要求 |
| --- | --- | --- |
| NFR-ID-001 | 正确性 | 1,000 次可重复乱序矩阵中零 stale commit、零跨 user overwrite |
| NFR-ID-002 | 性能 | profile mutation accepted 后无需额外 GET 即首帧更新；正常 route change 零新增 `/me` |
| NFR-ID-003 | 网络 | 同 epoch 并发 protected/visibility 调用合并；60s 内 visibility 不重复请求 |
| NFR-ID-004 | 安全 | old token/401/profile ID mismatch 无法污染新 session；日志无 token/body |
| NFR-ID-005 | 缓存 | `/me` private,no-store；avatar blob 继续 public immutable、内容改变 URL 改变 |
| NFR-ID-006 | 可访问性 | 头像按钮键盘可达、label 明确、fallback 对比度达现有标准、无重复朗读 |
| NFR-ID-007 | 稳定性 | transient `/me` 故障保留 UI；discard 不产生 unhandled rejection |
| NFR-ID-008 | 可维护性 | 单一 coordinator、单一 avatar renderer；无第二套 profile cache |
| NFR-ID-009 | 并行 | Identity Core diff 对通知/Catalog/Merch 共享热点为零；Layout 仅后置一次接线 |
| NFR-ID-010 | 兼容 | 现有 login、refresh single-flight、merchant role healing、points 更新回归全绿 |

---

## 15. 验收标准

### 15.1 状态与竞态

- `AC-ID-001`：给 GET-A 返回旧头像并延迟，在 PATCH 新头像 accepted 后释放 GET-A；store、Profile、Navbar 都保持新头像。
- `AC-ID-002`：GET-A 后发但先回、GET-B 先发但后回等全排列中，只允许 latest valid ticket commit；若 GET 因更晚 points/user delta 的 userRevision 被拒，保留 delta并在空闲后只合并发出一条 trailing reconcile。
- `AC-ID-003`：old user A 的 `/me` 在 logout→login user B 后返回，B 的 user/token/登录状态完全不变。
- `AC-ID-004`：old user A 的 `/me` 401/refresh failure 在 user B 登录后返回，不得 logout B。
- `AC-ID-005`：old refresh A 或其他 Tab 的 token-only adoption 在 login B/epoch变化后到达，不得覆盖 B token；该通道从不传播 AuthUser/profile。
- `AC-ID-006`：profile.id 与 expectedUserId 不同，拒绝 commit，并产生脱敏 mismatch metric。
- `AC-ID-007`：transient `/me` 5xx/断网后保留持久化 profile，不闪成未登录或默认头像。

### 15.2 Mutation

- `AC-ID-008`：头像上传与 nickname 保存交错触发时，实际 PATCH 最大并发数为 1，最终 GET 与 store 同时包含两项更新。
- `AC-ID-009`：连续 nickname mutation 按入队顺序发送，最后成功项获胜；前项失败不阻塞后项。
- `AC-ID-010`：PATCH 在更新 points 响应期间完成时，旧完整 profile 不覆盖新 points；reconcile 后两者都正确。
- `AC-ID-011`：上传期间 logout/login 后不发送 avatar PATCH 到新会话，且新会话不显示旧成功 Toast；同主体 token refresh 不误取消，avatar busy gate 阻止 clear/第二上传越过仍在准备的上传。
- `AC-ID-012`：clear `{avatarUrl:null}` accepted 后三个头像面同步 fallback，无页面刷新。
- `AC-ID-013`：服务端规范化 nickname 后，非 editing 输入和所有 displayName 使用服务端值；editing 草稿不被后台 sync 强制覆盖。

### 15.3 API/媒体

- `AC-ID-014`：真实 API GET `/api/auth/me` 200 含 `Cache-Control: private, no-store` 和完整字段。
- `AC-ID-015`：真实 API PATCH `/api/auth/me` 200 含相同 cache header、完整 profile 和 `merchant:null|object`。
- `AC-ID-016`：外部 avatar URL 仍 400；null 清除仍成功；未认证仍 401。
- `AC-ID-017`：上传不同字节得到不同 hash key/URL；相同字节允许同 key；旧 URL 的响应字节不被覆盖且保持 immutable header。

### 15.4 UI/生命周期

- `AC-ID-018`：桌面 1280px 中 PATCH accepted 后 `nav-profile-avatar` 的 img src 在下一 React commit 变为新 URL。
- `AC-ID-019`：移动 375px 抽屉打开时 `mobile-nav-profile-avatar` 与 Profile 使用同一 URL；clear 后都显示同一首字符 fallback。
- `AC-ID-020`：头像加载 404 时局部 fallback，无 store mutation、无无限请求、按钮仍有可读 label。
- `AC-ID-021`：仅 pathname 连续变化不会新增 `/me`；protected-entry 一次，visibility 超过 60s 后一次，短于阈值零次。
- `AC-ID-022`：role-skew 只 refresh 一次，第二次 `/me` 才可能提交；第一 profile 从不短暂写入 UI。
- `AC-ID-023`：通知完成版 Layout 的 SSE/polling/未读行为全绿，Identity 接线 diff 不修改 appStore/realtime 模块。
- `AC-ID-024`：静态扫描无 raw `setUser` 定义/调用、无 `/me` 裸 commit、无 Profile 闭包 user merge、无新 WS/SSE/DB migration。

任一 AC 仅靠 mock store 赋值、手工刷新、关闭通知 feature 或跳过 race 用例通过，均不算验收。

---

## 16. 可观测性

建议低基数指标/事件（可复用现有 logger/前端 telemetry；没有基础设施时至少测试内暴露）：

| 名称 | 标签 |
| --- | --- |
| `identity_profile_sync_total` | `result=accepted|discarded|skipped|error`, `reason` |
| `identity_profile_mutation_total` | `field=nickname|avatar|clear_avatar`, `result` |
| `identity_profile_stale_discard_total` | `reason=session|user|request|user_revision|mutation_revision|force_generation|pending_mutation` |
| `identity_profile_sync_duration_ms` | `reason`, `result` |
| `identity_profile_id_mismatch_total` | 无 PII label |

不得将 user ID、email、avatar URL、token、请求 body 放进 metric label。开发 debug 日志也不得输出 token 或完整 profile。

---

## 17. 风险与处理

| 风险 | 处理 |
| --- | --- |
| Coordinator 过度复杂、自己制造死锁 | FIFO 只串行 PATCH；GET 等 queue settled；用 fake transport + exhaustive race test |
| mutation 与积分局部更新竞态 | userRevision 检测，拒绝完整覆盖并强制 reconcile |
| 旧 refresh 覆盖新 login | epoch/user/stale-token 三重 guard |
| Layout 与通知 Agent 冲突 | Core 禁改；记录通知释放 SHA 后单 Owner 接线 |
| API 声称完整却漏 merchant 字段 | contract test 锁定所有 top-level 字段，不允许旧对象补齐 |
| immutable 缓存被误判为 bug | 新字节新 hash URL；浏览器 E2E 同时断言 src 和实际像素/响应 |
| 相同图片重传 URL 不变 | 合法内容去重；UI 已是同一内容，不强制伪版本 URL |
| transient sync 被当作登出 | 只有 current ticket 的 terminal auth failure 可 logout |
| profile queue 在 logout 后继续 | epoch 检查使 queued 项在发请求前取消，in-flight 结果丢弃 |
| 多 Tab 仍短暂不一致 | 明确 P0 边界；回前台校准最终收敛，主动广播后置 P1 |

---

## 18. 假设与 Owner 待核实项

- `A-ID-01`：P0 用户反馈发生在同一 SPA Tab；若必须实现多 Tab 亚秒同步，需要单独批准 O-ID-11 变更。
- `A-ID-02`：`/me` 继续返回完整 Profile，不计划改为 JSON Merge Patch response。
- `A-ID-03`：通知 T-FE-002 会先完成并提供 Layout release `N`；协调者可据此与 Identity handoff `C_ID` 建立可证明双祖先的 `M_ID`。
- `A-ID-04`：现有 avatar storage content hash/immutable 语义在生产 provider 与 memory provider 一致。
- `A-ID-05`：60 秒 visibility 校准阈值可在 Owner 审核时调整；它不影响 mutation 即时同步。

---

## 19. Owner 批准记录

| 决策范围 | 状态 | 批准人 | 日期 | 备注 |
| --- | --- | --- | --- | --- |
| O-ID-01～O-ID-12 | Approved | MoNexus Project Owner | 2026-08-09 | 全部冻结决策获批 |
| SPEC-IDENTITY-SYNC-001 v0.1.0 | Frozen for Implementation | MoNexus Project Owner | 2026-08-09 | 实施仍须满足 `S` 与逐卡 Entry Gate |

批准范围、版本、批准人和日期已记录；六件套与 PAR-CMI-001 已统一切换 `Frozen for Implementation`。

---

## 20. 需求追溯矩阵

| 需求 | 设计/不变量 | 验收 | 任务 |
| --- | --- | --- | --- |
| REQ-ID-001～004 | §5、§6、INV-ID-001～007 | AC-ID-001～007、021～024 | T-ID-CORE-001、T-ID-CORE-002、T-ID-INT-001～002 |
| REQ-ID-005～007 | §7、INV-ID-001/005/006/007 | AC-ID-008～013 | T-ID-CORE-003、T-ID-FE-001 |
| REQ-ID-008～010 | §6.4、§7.3、§8 | AC-ID-003～006、011、022 | T-ID-CORE-002、T-ID-CORE-003 |
| REQ-ID-011 | §9、INV-ID-011 | AC-ID-014～017 | T-ID-BE-001 |
| REQ-ID-012～014 | §10、§11、INV-ID-009 | AC-ID-018～021 | T-ID-FE-001、T-ID-FE-002、T-ID-INT-001 |
| REQ-ID-015 | §2.2、§11.2～11.4、INV-ID-012～013 | AC-ID-023～024 | T-ID-DOC-001、T-ID-INT-001～002 |
| REQ-ID-016～017 | §15、§16 | AC-ID-001～024 | T-ID-QA-001、T-ID-QA-002 |
| REQ-ID-018 | §2.2、O-ID-11 | P1，不阻塞 P0 | T-ID-P1-001 |

---

## 21. 变更控制

- Draft 阶段的 Owner 修改必须同步 `README/spec/plan/task/implement/checklist` 与 PAR-CMI-001。
- Frozen 后修改 O-ID、Commit Ticket 字段、PATCH FIFO、触发器、API cache 或文件 owner，必须提升版本并重新批准。
- 实施发现新 `setUser`/AuthUser 写入点时，先登记到 delta audit；不能在组件里临时绕过 coordinator。
- Frozen `D/S`、通知 `N`、Identity handoff `C_ID`、merge baseline `M_ID`、相应 ancestor 命令与 Identity 接线 commit 必须写入 Evidence Ledger。

### 修订记录

| 版本 | 日期 | 状态 | 说明 |
| --- | --- | --- | --- |
| 0.1.0 | 2026-08-09 | Frozen for Implementation | Owner 批准：profile coordinator、revision ticket、mutation FIFO、avatar projection、通知文件锁 |
