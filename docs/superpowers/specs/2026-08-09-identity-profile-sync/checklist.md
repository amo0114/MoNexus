# Checklist: 当前用户资料同步与头像一致性

| 字段 | 值 |
| --- | --- |
| 文档 ID | CHK-IDENTITY-SYNC-001 |
| 版本 | 0.1.0 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation — all implementation items unchecked** |
| 对应规格 | SPEC-IDENTITY-SYNC-001 v0.1.0 |

任何复选框只有在证据已写入 IMPL Evidence Ledger 后才能勾选。仅 build 通过、手工刷新后正确、mock store 赋值、feature-off 或测试 skip 均不能勾选 P0。

---

## 1. P0 — 文档、基线与并行边界

- [ ] `CHK-ID-DOC-001`：Owner 明确批准 O-ID-01～12 和 v0.1.0。
- [ ] `CHK-ID-DOC-002`：Identity 六件套内部版本/状态/审查基线一致并 Frozen；PAR-CMI-001 记录的 Identity 批准版本与基线匹配，PAR 自身也已 Frozen，不要求二者数字版本相同。
- [ ] `CHK-ID-DOC-003`：Freeze 时最新 `origin/develop` 已记录为 `D`；spec-only `S` 仅含三套六件套与 PAR-CMI-001、无业务/依赖/配置 diff，且 `git rev-parse <S>^` 精确等于 `D`。
- [ ] `CHK-ID-DOC-004`：Backend/Core 从 `S` 分叉、Frontend 从包含 `S` 的 Core contract tip 开始；implementation baseline、通知锁状态、Owner 与待填 `N/C_ID/M_ID` ledger 已记录。
- [ ] `CHK-ID-DOC-005`：Backend/Core/Frontend/Layout Integration Worktree、DB、ports 唯一。
- [ ] `CHK-ID-DOC-006`：delta audit 覆盖所有 `/me` caller、user/token writer、avatar surface。
- [ ] `CHK-ID-DOC-007`：Identity Core 在通知释放前对 Layout/appStore/auth middleware/notification 零 diff。
- [ ] `CHK-ID-DOC-008`：REQ/INV/AC/Task/Implement/Checklist 追溯无断链。

## 2. P0 — Backend Profile Contract

- [ ] `CHK-ID-BE-001`：真实 GET `/api/auth/me` 200 返回完整 AuthUser projection。
- [ ] `CHK-ID-BE-002`：真实 PATCH `/api/auth/me` 200 返回提交后的完整 AuthUser projection。
- [ ] `CHK-ID-BE-003`：两者均含 `Cache-Control: private, no-store`。
- [ ] `CHK-ID-BE-004`：normal user 显式 `merchant:null`；merchant user 返回安全 merchant projection。
- [ ] `CHK-ID-BE-005`：外部 avatar URL、非法昵称、空 patch、未认证仍按既有契约拒绝。
- [ ] `CHK-ID-BE-006`：`avatarUrl:null` 清除成功。
- [ ] `CHK-ID-BE-007`：响应不含 password/token/MFA secret/PointAccount 内部字段。
- [ ] `CHK-ID-BE-008`：头像 blob 仍 public immutable；不同内容不同 key，相同内容可 dedupe。

## 3. P0 — Store 与 Session State Machine

- [ ] `CHK-ID-STATE-001`：sessionEpoch/userRevision/profileMutationRevision 为 runtime-only。
- [ ] `CHK-ID-STATE-002`：persist slice 只含 user/accessToken/isLoggedIn。
- [ ] `CHK-ID-STATE-003`：每次 login/logout/主体切换推进 epoch 并原子转换。
- [ ] `CHK-ID-STATE-004`：同主体 refresh 不推进 epoch；本 Tab/其他 Tab 的 token-only adoption 均有 epoch/user/stale-token guard，且不传播 AuthUser/profile。
- [ ] `CHK-ID-STATE-005`：response profile ID 必须匹配 expected user。
- [ ] `CHK-ID-STATE-006`：ProductDetail/ProfilePage/OrderDetailModal 的 updatePoints 与其他权威 user delta 均经中央 safe action 推进 userRevision；旧 GET 不覆盖。
- [ ] `CHK-ID-STATE-007`：raw `setUser` 不再是页面/组件无条件提交 API。
- [ ] `CHK-ID-STATE-008`：hydrate 后 runtime metadata 不从 localStorage 恢复。

## 4. P0 — GET Coordinator 与 Role Healing

- [ ] `CHK-ID-SYNC-001`：所有 `/me` response 只经统一 coordinator + validator commit。
- [ ] `CHK-ID-SYNC-002`：ticket 同时验证 epoch/user/request/userRevision/mutationRevision/forceGeneration/pending mutation。
- [ ] `CHK-ID-SYNC-003`：同 epoch/user in-flight GET 合并，latest issued request 规则有测试。
- [ ] `CHK-ID-SYNC-012`：业务完成/manual retry/reconcile 先推进 forceGeneration 使旧 GET 失效，只能由调用后 dispatch 的 GET 满足；尚未 dispatch 的 force 才可合并。
- [ ] `CHK-ID-SYNC-004`：旧 GET 在新 PATCH 后返回会 discarded，不能回滚 profile。
- [ ] `CHK-ID-SYNC-005`：old user GET/success/error/401 不影响 new user。
- [ ] `CHK-ID-SYNC-006`：transient error 保留持久化 profile，不登出/清头像。
- [ ] `CHK-ID-SYNC-007`：role healing 最多 refresh 一次，第一 profile 永不 commit。
- [ ] `CHK-ID-SYNC-008`：response ID mismatch 产生脱敏 metric，不写 PII/body。
- [ ] `CHK-ID-SYNC-009`：pathname 变化不触发 `/me`；protected/visibility/explicit reason 符合表格。
- [ ] `CHK-ID-SYNC-010`：60 秒 TTL 仅抑制网络，不延迟 mutation 的本地 accepted commit。
- [ ] `CHK-ID-SYNC-011`：GET 因 userRevision 被拒时保留 delta，按最高 revision 只保留一个 trailing reconcile slot，无递归请求风暴。

## 5. P0 — Mutation FIFO 与 Upload

- [ ] `CHK-ID-MUT-001`：所有 nickname/avatar/clear PATCH 进入相同 per-session FIFO。
- [ ] `CHK-ID-MUT-002`：mutation 入队同步推进 barrier，GET 等 queue settled。
- [ ] `CHK-ID-MUT-003`：实际 PATCH 最大并发数为 1，失败不会 poison 后续 queue。
- [ ] `CHK-ID-MUT-004`：成功 profile full replace；没有 `{...user,...me}`/merchant fallback merge。
- [ ] `CHK-ID-MUT-005`：PATCH 期间 userRevision 改变时不覆盖 points，完成 reconcile。
- [ ] `CHK-ID-MUT-006`：avatar upload 完成后 revalidate epoch/user，再 PATCH。
- [ ] `CHK-ID-MUT-011`：同主体 token refresh 不误取消上传；avatar upload/clear/second-upload 共用 busy gate。
- [ ] `CHK-ID-MUT-007`：上传/PATCH stale 后不污染新 session、不误 Toast、不同步删 object。
- [ ] `CHK-ID-MUT-008`：applied/discarded/failed typed result 驱动正确 UI。
- [ ] `CHK-ID-MUT-009`：clear null 与普通 avatar mutation 使用同一协议。
- [ ] `CHK-ID-MUT-010`：1,000 个受控 race 排列零 stale commit。

## 6. P0 — UI 与可访问性

- [ ] `CHK-ID-UI-001`：Profile/desktop Navbar/mobile drawer 共用 UserAvatar。
- [ ] `CHK-ID-UI-002`：URL 非空显示 object-cover image；null/error 显示同一文字 fallback。
- [ ] `CHK-ID-UI-003`：UserAvatar 的 error state 在新 URL 时重置，无无限加载。
- [ ] `CHK-ID-UI-004`：Profile camera overlay、file input、busy/error 保持可用。
- [ ] `CHK-ID-UI-005`：nickname editing 草稿不被后台 sync 覆盖；非 editing 随 accepted profile。
- [ ] `CHK-ID-UI-006`：成功 Toast 只对 current applied operation 显示。
- [ ] `CHK-ID-UI-007`：desktop 1280px PATCH 后 Navbar 下一 React commit 更新，无 refresh。
- [ ] `CHK-ID-UI-008`：mobile 375px drawer/Profile 同 URL，clear 后同 fallback。
- [ ] `CHK-ID-UI-009`：头像按钮 keyboard/focus/aria-label/alt 语义正确。
- [ ] `CHK-ID-UI-010`：BottomTabBar 导航信息架构未因本规格改变。

## 7. P0 — Layout/通知并行 Gate

- [ ] `CHK-ID-INT-001`：通知 T-FE-002 release `N`、以 `S` 为祖先的 Identity Core/FE handoff `C_ID`、clean Layout 移交与 merge baseline `M_ID` 均已记录。
- [ ] `CHK-ID-INT-002`：`git merge-base --is-ancestor <N> <M_ID>` 与 `git merge-base --is-ancestor <C_ID> <M_ID>` 均为 exit 0；Identity Layout branch 从 `M_ID` 开始后才写。
- [ ] `CHK-ID-INT-003`：Layout 删除 pathname raw `/me`，接 visibility coordinator。
- [ ] `CHK-ID-INT-004`：desktop avatar 只做最小 UserAvatar 接线。
- [ ] `CHK-ID-INT-005`：Identity diff 对 appStore/realtime/auth middleware 为零。
- [ ] `CHK-ID-INT-006`：通知 SSE、fallback polling、bell、typed invalidation 回归全绿。
- [ ] `CHK-ID-INT-007`：user.id 变化仍正确启动/停止通知 lifecycle。
- [ ] `CHK-ID-INT-008`：Layout 只有一名 Identity Integration Owner 和一个以 `M_ID` 为基线的可审接线 commit。
- [ ] `CHK-ID-INT-009`：所有 caller 迁移后以独立 commit 删除 deprecated raw `setUser` 定义，未新增同义 unsafe writer。

## 8. P0 — 安全、性能与可观测性

- [ ] `CHK-ID-NF-001`：old refresh/token/401 对新 session 零副作用。
- [ ] `CHK-ID-NF-002`：日志/metric/trace/screenshot 无 token/cookie/完整 profile/真实 PII。
- [ ] `CHK-ID-NF-003`：正常 pathname route change 新增 `/me` 数为 0。
- [ ] `CHK-ID-NF-004`：同 epoch protected/visibility concurrent caller 只产生 1 个 transport request。
- [ ] `CHK-ID-NF-005`：stale discard 为低基数预期 metric，不制造 error log 风暴。
- [ ] `CHK-ID-NF-006`：profile accepted 后不依赖额外 GET 即更新全部身份面。
- [ ] `CHK-ID-NF-007`：未新增 WS/SSE/BroadcastChannel/runtime image API/DB migration。
- [ ] `CHK-ID-NF-008`：无 unhandled rejection、React warning、console error 或 listener leak。

## 9. P0 — QA、发布与回滚

- [ ] `CHK-ID-QA-001`：logic/race tests 使用 deferred control，不用固定 sleep 判顺序。
- [ ] `CHK-ID-QA-002`：真实 API headers/upload bytes，不用 mock 替代。
- [ ] `CHK-ID-QA-003`：desktop/mobile E2E 覆盖 delayed GET、session switch、clear、404 fallback。
- [ ] `CHK-ID-QA-004`：role-healing/refresh rotation/auth security 回归全绿。
- [ ] `CHK-ID-QA-005`：static scan 无 raw `/me → setUser`、闭包 merge、forbidden files。
- [ ] `CHK-ID-QA-006`：frontend/backend build、目标 suites、直接受影响全仓回归 Green。
- [ ] `CHK-ID-QA-007`：灰度观察 `/me` request rate、sync error、discard reason、异常 logout。
- [ ] `CHK-ID-QA-008`：回滚 rehearsal 保留通知 commits/no-store header，不撤销用户已提交 profile。
- [ ] `CHK-ID-QA-009`：Worktrees clean、commits 原子、Evidence Ledger 完整。
- [ ] `CHK-ID-QA-010`：无 feature-off、人工 refresh、skip/retry 假绿。
- [ ] `CHK-ID-QA-011`：Backend/Core/FE/final candidate 均保留 `S` 祖先；Layout/writer-closure/final candidate 还保留 `M_ID` 祖先。

## 10. P1 — 后置

- [ ] `CHK-ID-P1-001`：基于真实需求评估多 Tab propagation。
- [ ] `CHK-ID-P1-002`：如批准，另立 BroadcastChannel data-minimization/session isolation 规格。
- [ ] `CHK-ID-P1-003`：评估头像裁剪/压缩/审核，不与 sync correctness 混做。
- [ ] `CHK-ID-P1-004`：评估 leaderboard/review 等公开头像展示的独立产品范围。

P1 全部不阻塞 P0，也不得提前混入本波 diff。

---

## 11. AC 索引

| AC | 主要 Checklist |
| --- | --- |
| AC-ID-001～007 | CHK-ID-STATE-003～007；CHK-ID-SYNC-001～008、011～012；CHK-ID-NF-001 |
| AC-ID-008～013 | CHK-ID-MUT-001～011；CHK-ID-UI-004～006 |
| AC-ID-014～017 | CHK-ID-BE-001～008；CHK-ID-QA-002 |
| AC-ID-018～020 | CHK-ID-UI-001～009；CHK-ID-QA-003 |
| AC-ID-021～022 | CHK-ID-SYNC-003、007、009～012；CHK-ID-NF-003～004 |
| AC-ID-023 | CHK-ID-INT-001～008；CHK-ID-QA-011 |
| AC-ID-024 | CHK-ID-INT-009、CHK-ID-QA-005～006、CHK-ID-QA-010、CHK-ID-NF-007 |

---

## 12. Final Gate

只有以下全部成立才能声明 SPEC-IDENTITY-SYNC-001 完成：

- [ ] `FINAL-ID-001`：O-ID-01～12、所有 P0 checklist、AC-ID-001～024 全部有证据。
- [ ] `FINAL-ID-002`：用户更新/清除头像后，Profile/Navbar/Mobile 同 Tab 即时一致且旧响应无法回滚。
- [ ] `FINAL-ID-003`：session/user/token/points 在所有受控乱序中保持不变量。
- [ ] `FINAL-ID-004`：`D/S/N/C_ID/M_ID` 与通知 release/接线顺序可追溯，`S^=D`、`N→M_ID`、`C_ID→M_ID` 有命令证据，通知回归无退化。
- [ ] `FINAL-ID-005`：本规格 diff 无 schema/migration/appStore/auth middleware/notification/catalog/merch 修改。
- [ ] `FINAL-ID-006`：发布/观察/回滚/交接完整，无生产数据和秘密操作。
- [ ] `FINAL-ID-007`：raw `setUser` 定义与 caller 均为零，writer-closure commit 可独立审查。

### 修订记录

| 版本 | 日期 | 状态 | 说明 |
| --- | --- | --- | --- |
| 0.1.0 | 2026-08-09 | Frozen for Implementation | Owner 批准：current-user commit ticket、mutation FIFO、真实头像投影与通知 Layout Gate |
