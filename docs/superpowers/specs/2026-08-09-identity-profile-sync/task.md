# Tasks: 当前用户资料同步与头像一致性

| 字段 | 值 |
| --- | --- |
| 文档 ID | TASK-IDENTITY-SYNC-001 |
| 版本 | 0.1.0 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation — all tasks Pending** |
| 输入 | [spec.md](./spec.md) · [plan.md](./plan.md) · [PAR-CMI-001](../2026-08-09-catalog-merch-identity-parallel-contract.md) |

规格已经 Owner 冻结。任何任务仍须先满足 `S`、依赖与 Entry Gate 才能切换为 In Progress；每张卡先提交 Red 证据，再实现 Green，再运行直接影响回归，完成证据回填 `implement.md` 与 `checklist.md`。

---

## 1. 全局规则

1. 每张卡只修改 Owned files；同文件任务按依赖串行，不把“可 cherry-pick”误当作可同时写。
2. Identity Core 在通知 T-FE-002 完成前禁止修改 `src/components/Layout.tsx`。
3. 全部 Identity 任务禁止修改 `src/stores/appStore.ts`、`server/src/middlewares/auth.ts`、`server/src/modules/notifications/**`、通知 Worktree。
4. 禁止修改 `schema.prisma`、migrations、商品/订单/积分业务语义；`updatePoints` 只改变 revision bookkeeping，不改余额来源。
5. 不得以 WebSocket/SSE/BroadcastChannel、强制 reload、pathname 高频 GET 或 cache-busting query 替代提交协议。
6. race test 使用 deferred Promise/受控 route，不用不稳定固定 sleep 证明顺序。
7. 不在日志、trace attachment、snapshot 中写 access token、refresh cookie、完整 AuthUser、email 或生产 avatar URL。
8. 一个共享热点同时只有一个 owner；Layout 移交必须记录通知 release `N`、Identity Core/FE handoff `C_ID` 与二者共同可达的 merge baseline `M_ID`。
9. 测试只使用专用 DB/端口/fixture 账户，不访问 staging/production 或真实对象存储。
10. 邻近 auth 安全问题若超出 O-ID 冻结范围，先登记 Blocked/Ask First，禁止顺手扩大重构。

---

## 2. 文档与基线

### T-ID-DOC-001 — Owner freeze、delta audit 与并行锁

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 / 串行入口 Gate |
| 对应需求 | REQ-ID-015～017 |
| 依赖 | Owner approval O-ID-01～12 |
| 状态 | Pending |

**Owned**

- 本目录六件套；
- PAR-CMI-001 的 Identity/通知文件锁段；
- 只读 delta/evidence 记录。

**Must Not Touch**：全部业务代码、通知 Worktree、生产配置。

**工作**

- [ ] fetch 后把 Owner Freeze 时最新 `origin/develop` 记录为 `D`，并记录 SPEC-NOTIFY-RT-001 已完成 commits 与未提交状态。
- [ ] 记录批准人、版本、O-ID 范围，把六件套/PAR-CMI 同步 Frozen；协调者以 `D` 为直接父提交创建只含三套六件套与 PAR-CMI-001 的 docs-only `S`。
- [ ] 保存 `git rev-parse <S>^` 输出并证明等于 `D`；登记 Identity Backend/Core 从 `S` 分叉、Frontend 从包含 `S` 的 Core contract tip 开始。
- [ ] `rg` 枚举 `/me` caller、`setUser`、login/logout、token writer、updatePoints、avatar renderer。
- [ ] 确认 Identity Worktree/branch/DB/ports 唯一；确认 Layout owner 仍为通知或已释放。
- [ ] 建 race scenario/完整 AuthUser/头像 fixture 清单。
- [ ] 记录 `D/S` 与实施分支起始 SHA；若纳入较新的 develop，做逐文件 delta 决策并再次证明最终候选仍以 `S` 为祖先。

**DoD**

- 六件套 ID/版本/状态/Owner 决策一致；
- REQ/AC/Task/CHK 无断链；
- 通知 release `N` 或“Core 阶段不可接 Layout”状态明确；
- `S^=D` 且 spec-only commit 无业务/依赖/配置 diff；Backend/Core 起始分支均以 `S` 为祖先。

**验证**：文档链接/ID `rg`、`git diff --check`、`git diff --name-only`、Worktree/branch/status 证据。

---

## 3. Backend 契约

### T-ID-BE-001 — `/auth/me` 完整 projection 与 no-store

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-ID-011、REQ-ID-016～017 |
| 依赖 | T-ID-DOC-001；实施分支从 `S` 分叉 |
| 状态 | Pending |

**Owned**

- `server/src/modules/auth/controller.ts`（只改 GET/PATCH me headers）；
- `server/src/__tests__/auth.test.ts` 或独立 profile contract test；
- 直接相关测试 fixture。

**Must Not Touch**

- `server/src/middlewares/auth.ts`；
- auth token/refresh/session service 语义；
- `server/src/modules/uploads/routes.ts` 的 immutable policy；
- schema/migrations/notification。

**工作**

- [ ] Red：真实 GET/PATCH 断言 `private, no-store` 失败。
- [ ] Red：normal/merchant profile 断言稳定完整 top-level keys。
- [ ] GET/PATCH success 设置 `Cache-Control: private, no-store`。
- [ ] 锁定 `merchant:null|object`、nickname/avatarUrl/emailVerified 显式字段。
- [ ] 保持外部 URL 拒绝、null 清除、401、nickname 校验。
- [ ] 验证响应不含密码/token/MFA/internal PointAccount。
- [ ] 回归 uploads blob 仍是 public immutable。

**DoD**

- AC-ID-014～017 Green；
- 仅 controller/header/test 小 diff；
- 无 auth middleware/schema/service 扩大变更；
- auth/uploads suites 全绿。

---

## 4. Identity Core

### T-ID-CORE-001 — authStore 会话状态机与安全动作

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-ID-002～003、007～008 |
| 依赖 | T-ID-DOC-001；实施分支从 `S` 分叉 |
| 状态 | Pending |

**Owned**

- `src/stores/authStore.ts`；
- `src/stores/authStore.test.ts`（新增或现有对应文件）；
- 必要的纯 identity ticket types。

**Must Not Touch**：App/Layout/Profile/API/appStore/notification。

**工作**

- [ ] Red：login/logout epoch、stale ticket、runtime metadata persist、updatePoints revision。
- [ ] 新增非持久化 sessionEpoch/userRevision/profileMutationRevision。
- [ ] login/logout 变成原子 session transition。
- [ ] 实现 expected user + ticket 的 guarded profile commit/token adoption。
- [ ] `updatePoints` 保持签名兼容，内部函数式更新并推进 userRevision。
- [ ] 提供 begin mutation barrier 与 typed reject reason 所需 snapshot。
- [ ] 从 persist `partialize` 排除 runtime metadata。
- [ ] 为 raw `setUser` 设计迁移：仅为尚未合并的旧 consumer 保留带 `@deprecated` 标记的过渡 adapter；新代码/本卡测试不得调用，最终由 T-ID-INT-002 物理删除。

**DoD**

- INV-ID-002～008 的 store 层 unit Green；
- hydration 后 runtime counter 不从 localStorage 恢复；
- current user delta 不会被旧 full profile ticket 接受；
- 不改任何 consumer 文件。

### T-ID-CORE-002 — GET coordinator、role healing 与 refresh guard

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-ID-001、003～004、008～009、014、017 |
| 依赖 | T-ID-CORE-001 |
| 状态 | Pending |

**Owned**

- `src/auth/profileSync.ts`、types/tests；
- `src/api/auth.ts`（profile transport/role-healing 边界）；
- `src/api/authRefresh.ts` 及直接测试。

**Must Not Touch**：App/Layout/Profile components/appStore/auth middleware。

**工作**

- [ ] 实现纯 commit validator，每个拒绝 reason 有测试。
- [ ] 实现 current epoch/user in-flight coalescing、latest request、60s accepted-sync TTL。
- [ ] 实现 barriered force generation：调用先推进 required generation并使此前 GET 无提交资格；业务完成/manual retry/reconcile 只能由调用后 dispatch 的 GET 满足，尚未 dispatch 的 force 可合并。
- [ ] GET 等待 profile queue seam（初期可为空队列），捕获完整 ticket。
- [ ] role healing 的第一 GET 不 commit，最多一次 guarded refresh，第二 GET 才验证提交。
- [ ] refresh token 结果按 epoch/user/stale token guard；stale terminal error 不 logout 新会话。
- [ ] response user ID mismatch 拒绝并产生无 PII observer event。
- [ ] transient error 保留 user，typed result 不产生 unhandled rejection。
- [ ] `user_revision` discard 保留 delta，按最高 revision 合并一个 trailing reconcile；无同步递归/忙重试。
- [ ] 暴露 protected/visibility/explicit reason API，不把 pathname 作为 reason。

**DoD**

- AC-ID-001～007、021～022 的 coordinator 层确定性测试 Green，含 force 不能复用业务完成前请求；
- old GET/token/401 对新 session 零副作用；
- 相同 epoch in-flight 实际 transport 调用数为 1；
- 不改变 refresh cookie rotation/single-flight/security contract。

### T-ID-CORE-003 — Profile mutation FIFO、reconcile 与 avatar upload guard

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-ID-005～007、010、016～017 |
| 依赖 | T-ID-CORE-002 |
| 状态 | Pending |

**Owned**

- `src/auth/profileSync.ts`、types/tests；
- avatar upload orchestration helper（若独立文件）；
- `src/api/auth.ts` 仅 transport signature。

**Must Not Touch**：UI consumer、upload backend/storage、orders/points business、Layout。

**工作**

- [ ] Red：nickname/avatar parallel request max concurrency、failure recovery、points race、session switch。
- [ ] 入队同步推进 mutation revision；旧/新 GET 均遵守 barrier/queue drain。
- [ ] 实现 per-session FIFO，rejection 后 tail 仍继续。
- [ ] PATCH 发送前和响应后验证 epoch/user；完整 profile 原子 commit。
- [ ] PATCH 期间 userRevision 改变则拒绝 full replace、queue 后 force reconcile。
- [ ] 上传前捕获 session，上传后 revalidate，再入队 PATCH；同主体 token refresh 允许继续并使用当前 token。
- [ ] upload/clear/second-upload 共用 avatar-operation busy gate；nickname 只在实际 PATCH 阶段与其共享 FIFO。
- [ ] stale upload/PATCH 不删 object、不 Toast、不污染新 user。
- [ ] mutation 结果区分 applied/discarded/failed，供 UI 正确反馈。

**DoD**

- AC-ID-008～012 Green；
- 1,000 个 race 排列零 stale commit；
- 任一时刻 PATCH transport 最大并发 1；
- 不新增 optimistic state/DB/realtime transport。

---

## 5. Frontend Core

### T-ID-FE-001 — UserAvatar 与 ProfileIdentityCard

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-ID-005～006、010、012～013 |
| 依赖 | T-ID-CORE-003 public contract；组件可先基于 fixture 开发，正式分支从包含 `S` 的 Core contract tip 开始 |
| 状态 | Pending |

**Owned**

- `src/components/identity/UserAvatar.tsx` 与测试；
- `src/components/profile/ProfileIdentityCard.tsx` 与测试。

**Must Not Touch**：Layout/MobileNavDrawer/App/authStore/profileSync internals/appStore。

**工作**

- [ ] UserAvatar 支持 URL/null/error/source change、首字符 fallback、sizes/a11y/testid。
- [ ] Profile avatar 组合 camera overlay，使用共享 renderer。
- [ ] nickname/avatar/clear 全部调用 coordinator，不直接调用 `setUser`。
- [ ] 删除 `{...user,...me}` 与 merchant fallback merge。
- [ ] nickname local draft 在非 editing 随 accepted profile同步，editing 时保护草稿。
- [ ] Toast 只对 current applied operation 显示；same-field pending 禁止重复提交。
- [ ] upload input 清理与既有错误文案保持。

**DoD**

- AC-ID-008～013、020 的 component/unit Green；
- Profile 文件无 `setUser`、无闭包 user merge；
- keyboard/focus/label/alt Green；
- 不要求页面 reload或后台 GET 才更新。

### T-ID-FE-002 — App、Mobile drawer 与显式 workflow 接线

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-ID-001、008、012、014 |
| 依赖 | T-ID-CORE-002、T-ID-FE-001 UserAvatar；分支保留 `S` 祖先 |
| 状态 | Pending |

**Owned**

- `src/App.tsx`；
- `src/components/MobileNavDrawer.tsx`；
- `src/pages/MerchantApplyPage.tsx`、`src/pages/VerifyEmailPage.tsx` 中只替换 profile sync 调用；
- 对应 unit/component tests。

**Must Not Touch**：Layout/BottomTabBar/appStore/notification；不得改商家申请或邮箱验证业务语义。

**工作**

- [ ] ProtectedRoute 只调用 coordinator；current terminal auth result 才 logout。
- [ ] Mobile drawer 身份区使用 UserAvatar 和 store displayName。
- [ ] 商家申请/邮箱验证完成后强制 coordinator sync，移除 direct setUser。
- [ ] 按 Spec §11.4 完整迁移 App、MerchantApply、VerifyEmail；delta 新 caller 必须先回写表格并取得唯一 Owner，不能留作模糊后续。
- [ ] 保持 BottomTabBar 导航 icon 不变。

**DoD**

- App/Mobile/workflows 无 `/me → setUser`；
- protected-entry transport count/soft failure/session switch tests Green；
- Mobile drawer URL/fallback/a11y Green；
- 没有 Layout diff。

---

## 6. 后置共享集成

### T-ID-INT-001 — Layout 身份接线（通知释放后唯一 Owner）

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 / 共享热点锁 |
| 对应需求 | REQ-ID-001、012、014～015 |
| 依赖 | `M_ID` 已建立（含 T-ID-CORE-003、T-ID-FE-001～002 的 `C_ID` 与通知 release `N`） |
| 状态 | Pending |

**入口 Gate**

- 通知协调者已记录 T-FE-002 release `N`；
- 通知 Worktree 对 Layout 无未提交修改；
- Identity Core/FE handoff `C_ID` 已记录且 `S` 是其祖先；
- 协调者已建立 `M_ID`，`git merge-base --is-ancestor <N> <M_ID>` 与 `git merge-base --is-ancestor <C_ID> <M_ID>` 均为 exit 0；Identity Layout branch 从 `M_ID` 开始；
- Identity Integration Owner 亲自阅读最终 Layout 的 profile、notification、visibility effects。

**Owned**

- `src/components/Layout.tsx`（本卡独占、最小接线）；
- Layout identity integration tests。

**Must Not Touch**

- `src/stores/appStore.ts`；
- notification realtime/invalidation/hook/protocol；
- auth middleware；
- Layout 中与 profile/avatar/visibility 无关的结构、搜索、公告、订单逻辑。

**工作**

- [ ] 删除 pathname 动态 import `/me → setUser` effect。
- [ ] 接 visibility calibration；事件 cleanup 严格，避免与通知 visibility listener 冲突/重复注册。
- [ ] desktop profile button 使用 UserAvatar，保持点击/尺寸/响应式布局。
- [ ] 验证 user.id 变化仍正确驱动通知 lifecycle，不直接调用 appStore。
- [ ] 生成相对通知 release `N` 的精确 diff，人工审核无 notification rewrite。

**DoD**

- AC-ID-018、021、023 Green；
- 本卡业务 diff 只有 Layout/tests；
- notification frontend/realtime regression 全绿；
- `N/C_ID/M_ID`、两条 ancestor 命令与 identity integration SHA 写入 Evidence Ledger。

### T-ID-INT-002 — Raw profile writer closure

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 / 最终写入口 Gate |
| 对应需求 | REQ-ID-001～003、REQ-ID-015 |
| 依赖 | T-ID-FE-001～002、T-ID-INT-001；Spec §11.4 全部 caller 已迁移 |
| 状态 | Pending |

**Owned**

- `src/stores/authStore.ts`（只删除 deprecated raw `setUser` 及死类型）；
- static writer contract test/evidence。

**Must Not Touch**：coordinator 算法、Layout、appStore、notification、其他 authStore action。

**工作**

- [ ] `rg` 证明所有基线与 delta caller 都已改走 coordinator/login/safe delta。
- [ ] 删除过渡 `setUser` action/interface/implementation；不新增同义 `replaceUserUnsafe` 后门。
- [ ] build/typecheck，使任何未来 direct caller 编译失败。
- [ ] 单独提交 writer-closure commit，随后转交 Final QA。

**DoD**：AC-ID-024 Green；raw setter 定义与调用均为零；commit 不含同步算法或 UI 改动。

---

## 7. QA、发布与交接

### T-ID-QA-001 — Deterministic race、API 与静态 Gate

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-ID-003～011、016～017 |
| 依赖 | T-ID-BE-001、T-ID-CORE-001～003 |
| 状态 | Pending |

**Owned**：identity unit/race harness、auth API integration、专用验证脚本/evidence；不得修业务代码，失败退回对应 Owner。

**工作**

- [ ] 运行/扩展全部 deferred race matrix 1,000 排列。
- [ ] 真实 backend GET/PATCH/cache/upload contract。
- [ ] refresh single-flight/rotation/role-healing/auth regressions。
- [ ] 对 §11.4 三个 `updatePoints` caller 做静态清单和 delayed GET 竞态；证明都经中央 safe delta 推进 revision，caller 文件无需为 bookkeeping 改动。
- [ ] Core 阶段静态扫描新代码无 raw setter/闭包 merge/realtime transport；记录尚待 T-ID-INT-001、T-ID-INT-002 清除的精确基线命中，不误报 Final Green。
- [ ] typecheck/build/lint/test coverage。
- [ ] 作为 primary evidence owner 回填 AC-ID-001～017、022；AC-ID-024 只做预审，最终归 T-ID-INT-002、T-ID-QA-002。

**DoD**：零 flaky retry 依赖；真实 HTTP 与内容寻址证据存在；无 secret artifact；目标/回归全绿。

### T-ID-QA-002 — Desktop/mobile E2E、通知回归与 Final Gate

| 字段 | 值 |
| --- | --- |
| 优先级 | P0 |
| 对应需求 | REQ-ID-012～017 |
| 依赖 | T-ID-FE-001～002、T-ID-INT-001～002、T-ID-QA-001 |
| 状态 | Pending |

**Owned**

- `playwright.identity-sync.config.ts`（如需独立配置）；
- `e2e/identity-profile-sync*.spec.ts`；
- screenshots/traces（脱敏）、发布/回滚证据；
- checklist evidence 回填。

**Must Not Touch**：用 E2E 卡顺手修产品代码；失败交回相应 task owner。

**工作**

- [ ] 1280px Navbar、375px drawer/Profile 即时 avatar/nickname。
- [ ] delayed old GET、logout/login stale、clear、image 404 fallback。
- [ ] route-change request count、visibility ≥/<60s。
- [ ] 通知 SSE/polling/bell/order invalidation smoke。
- [ ] Final 静态扫描 raw setter 定义/调用、闭包 merge、新 realtime/DB/forbidden files 全为零或经明确允许分类。
- [ ] a11y、console error、network secret、responsive layout。
- [ ] 灰度指标/回滚 rehearsal 与全仓回归。

**DoD**

- 作为 primary evidence owner 回填 AC-ID-018～021、023～024；AC-ID-022 引用 QA-001 的 role-healing evidence；
- 全部 24 AC 有自动化或明确可复核证据；
- 无 feature-off/手工刷新/skip 假绿；
- PR/Release/Parallel Gates 全通过。

### T-ID-P1-001 — 多 Tab profile propagation 评估

| 字段 | 值 |
| --- | --- |
| 优先级 | P1 / 不阻塞 P0 |
| 对应需求 | REQ-ID-018 |
| 依赖 | P0 生产指标与明确 Owner 需求 |
| 状态 | Pending |

**工作**：评估 BroadcastChannel/storage event 的主体隔离、logout/login、token/profile data minimization；另立增量 Spec 后方可实施。

**禁止**：在 P0 coordinator 中悄悄加入跨 Tab协议或广播完整 AuthUser/token。

---

## 8. 依赖总表

| Task | 前置 | 可并行 | 解锁 |
| --- | --- | --- | --- |
| T-ID-DOC-001 | Owner approval | 无 | 全部实施卡 |
| T-ID-BE-001 | DOC | CORE-001 | QA-001 |
| T-ID-CORE-001 | DOC | BE-001 | CORE-002 |
| T-ID-CORE-002 | CORE-001 | BE-001 | CORE-003、FE-002 |
| T-ID-CORE-003 | CORE-002 | UserAvatar fixture work | FE-001、QA-001、INT |
| T-ID-FE-001 | CORE-003 contract | BE-001 | FE-002、INT、QA-002 |
| T-ID-FE-002 | CORE-002 + UserAvatar | BE-001/QA-001 | Core Gate、INT |
| T-ID-INT-001 | `M_ID`（`N + C_ID`） | CMI lanes（不同文件） | INT-002 |
| T-ID-INT-002 | FE + INT-001 + caller zero | 无 | QA-002 |
| T-ID-QA-001 | BE + Core | FE/等待 Layout | QA-002 evidence |
| T-ID-QA-002 | FE + INT-001～002 + QA-001 | 无 | Final Gate |
| T-ID-P1-001 | P0/Owner | P0 后 | 增量规格 |

同一 Identity Core Owner 按 CORE-001 → 002 → 003 串行，因为后两卡共享 coordinator/API；不得分给多个 Agent 同时编辑。

---

## 9. 总体 DoD

- [ ] 规格/PAR-CMI 已批准 Frozen；`D/S/N/C_ID/M_ID` 与实施 baseline 可追溯，`S^=D`、`N→M_ID`、`C_ID→M_ID` 均有命令证据。
- [ ] Backend no-store/完整 projection、Store state machine、Coordinator/FIFO、三个 avatar surface 全完成。
- [ ] raw `setUser` profile commit、pathname fetch、Profile 闭包 merge 为零。
- [ ] deprecated raw `setUser` 定义已由独立 closure commit 删除，而非仅无调用。
- [ ] old GET/PATCH/refresh/401 对新 session 零副作用。
- [ ] 24 个 AC、1,000 race 排列、真实 API、desktop/mobile、通知回归全绿。
- [ ] Identity diff 无 schema/migration/appStore/auth middleware/notification/product/merch 改动。
- [ ] Backend/Core/FE 与最终候选 HEAD 均保留 `S` 祖先；Layout/closure/final HEAD 还保留 `M_ID` 祖先。
- [ ] 无 token/PII 泄露、无 runtime WS/SSE/BroadcastChannel、无手工刷新依赖。
- [ ] 每张卡独立 commit/evidence/owner，失败与 rollback 路径已演练。
