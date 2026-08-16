# Implement Protocol: 当前用户资料同步与头像一致性

| 字段 | 值 |
| --- | --- |
| 文档 ID | IMPL-IDENTITY-SYNC-001 |
| 版本 | 0.1.0 |
| 日期 | 2026-08-09 |
| 状态 | **Frozen for Implementation — all cards Pending** |
| 输入 | [spec.md](./spec.md) · [plan.md](./plan.md) · [task.md](./task.md) |

本文件是已批准的实施 Agent 操作协议。各卡只有在 `S` 与自身 Entry Gate 满足后才可开始；所有 `<SHA>`、Owner、测试结果必须在执行时填真实值，不得预填“通过”。

---

## 1. 入口 Gate

实施前全部满足：

- [ ] Owner 明确批准 SPEC-IDENTITY-SYNC-001 v0.1.0 的 O-ID-01～12。
- [ ] Identity 六件套内部版本/状态/审查基线一致，PAR-CMI-001 已记录其批准版本与基线；两者状态均为 `Frozen for Implementation`。
- [ ] 已 fetch `origin`；Freeze 时最新 `origin/develop` 记为 `D`，docs-only Frozen spec commit 记为 `S`，且 `git rev-parse <S>^` 精确等于 `D`。
- [ ] `S` 只包含三套六件套与 PAR-CMI-001；无业务、依赖、配置或生成物 diff。
- [ ] implementation baseline 由协调者记录，不从当前 WIP 分支猜测；Backend/Core 从 `S` 分叉，Frontend 起始 Core contract tip 以 `S` 为祖先。
- [ ] 通知 Worktree/branch/status 已只读审计；Identity Core 明确不碰 Layout。
- [ ] Backend/Core/Integration Worktree、DB、端口互不重叠。
- [ ] 所有 Agent 已阅读自己任务的 Spec/Plan/Task/Implement/Checklist 与 PAR-CMI。
- [ ] 每张卡的 Owned/Must Not Touch、前置 SHA、Red 命令已写入交接消息。

任一缺失，卡保持 Pending。

---

## 2. Git、Worktree 与 Runtime 隔离

本文件沿用 PAR-CMI-001 的冻结符号：`D` 为 Freeze 时 develop，`S` 为直接父提交是 `D` 的 docs-only Frozen spec commit，`N` 为通知 Layout release，`C_ID` 为包含 `S` 的 Identity Core/FE handoff tip，`M_ID` 为同时以 `N` 与 `C_ID` 为祖先的 Identity Layout merge baseline。

建议按文件边界分为三条线：

| Lane | 分支 | Worktree | 测试 DB | 必含祖先/起始基线 | Backend | Frontend |
| --- | --- | --- | --- | --- | ---: | ---: |
| Identity Backend | `fix/identity-profile-cache-contract` | `/root/projects/worktrees/monexus-identity-profile-backend` | `monexus_test_identity_backend` | 从 `S` 分叉 | 3125 | 不启动 |
| Identity Core/FE | `fix/identity-profile-sync` | `/root/projects/worktrees/monexus-identity-profile-sync` | `monexus_test_identity_sync` | Core 从 `S`；FE 从包含 `S` 的 Core contract tip | 3127 | 5195 |
| Identity Layout Integration | `fix/identity-profile-layout-integration` | `/root/projects/worktrees/monexus-identity-profile-layout` | `monexus_test_identity_layout` | 从 `M_ID` 开始 | 3128 | 5198 |

上述端口不得占用 PAR-CMI 的 3120～3124、3126、5192、5194、5196，也不得占用通知的 3112/3113/5182。

创建纪律：

1. Backend 与 Core 都从 `S` 分叉，可并行；Frontend 只能消费已提交且以 `S` 为祖先的 Core contract tip。禁止绕过 `S` 从较新 develop 重建平行实施链。
2. Core/FE 完成后记录 `C_ID`；通知释放后记录 `N`。协调者建立 `M_ID`，并保存以下两条命令的 exit 0；Layout Integration 只能从 `M_ID` 开始，不能从 `N`、`C_ID` 或旧 develop 单边分叉：

   ```bash
   git merge-base --is-ancestor <N> <M_ID>
   git merge-base --is-ancestor <C_ID> <M_ID>
   ```

3. 每个 Worktree 开工前 `git status --short --branch` 必须 clean。
4. 禁止多个 Agent 进入同一 Worktree 写文件；禁止 stash/reset --hard/clean -fd/force push。
5. destructive DB 命令前显式解析 `DATABASE_URL`，断言数据库名精确等于表中值；本规格原则上无需 reset/migrate。
6. Playwright `reuseExistingServer=false`、Vite `strictPort=true`；只停止自己记录的 PID。

不得进入或修改：

`/root/projects/worktrees/monexus-order-notification-realtime`

---

## 3. 文件锁与 Owner

### 3.1 Identity Backend Owner

可写：

- `server/src/modules/auth/controller.ts` 的 `me/updateMe` header；
- auth profile contract tests。

不可写：auth middleware、token/session service、uploads storage、schema/migrations、通知。

### 3.2 Identity Core Owner

可写：

- `src/stores/authStore.ts`；
- `src/auth/profileSync*`；
- `src/api/auth.ts`、`src/api/authRefresh.ts` 的本规格边界；
- Core/race tests。

同一 Owner 串行完成 CORE-001～003。不得把共享的 `profileSync.ts` 分给两个 Agent 并发编辑。

### 3.3 Identity Frontend Owner

可写：

- `src/components/identity/**`；
- `src/components/profile/ProfileIdentityCard.tsx`；
- `src/components/MobileNavDrawer.tsx`；
- `src/App.tsx`；
- MerchantApply/VerifyEmail 的最小 profile sync 接线；
- 对应测试。

可在 Core Owner 先提交 public contract fixture 后并行；不得修改 coordinator internals 或 Layout。

### 3.4 Identity Integration Owner

通知释放后唯一可写：

- `src/components/Layout.tsx`；
- identity Layout E2E/integration test。
- Layout 及所有其他 caller 迁移后，`src/stores/authStore.ts` 中仅删除 deprecated raw `setUser` 的 closure 小区域。

接线期间其他所有 lane 释放 Layout 写锁；执行 writer closure 时 Core Owner 同时释放 authStore 写锁。该 Owner 不重写 Core/notification algorithms，Layout 与 writer closure 分成两个 commit。

### 3.5 永不由本规格修改

- `src/stores/appStore.ts`；
- `server/src/middlewares/auth.ts`；
- `server/src/modules/notifications/**`；
- notification realtime frontend modules；
- `server/prisma/schema.prisma`、migrations；
- products/orders/points service、StorePage、Admin/Merchant merchandising；
- production env/provider secrets。

发现确需修改时，停止并走 Ask First/增量规格；不得越锁。

---

## 4. 三色权限

### Green — 可直接执行

- 在 Owned files 内写 Red/Green/refactor；
- 使用专用 fixture/DB/ports 运行测试；
- 新增纯 identity coordinator/avatar 文件与测试；
- 只读检查通知 release/status/diff；
- 修改 `/me` success Cache-Control；
- 记录脱敏 evidence、截图、trace；
- 一个原子 Task 一个 commit。

### Yellow — Ask First

- 修改冻结 Owner Decision、60s 阈值、完整 AuthUser fields；
- 新增 npm runtime/test dependency；
- 修改 refresh cookie rotation、interceptor、storage algorithm；
- 修改 Profile 之外的 current-user业务写入语义；
- 通知 release 后发现 Layout 接线必须改 appStore/realtime hook；
- 扩展成跨 Tab BroadcastChannel；
- 修改 auth service/schema/routes，而不只是已批准 controller contract；
- 引入 feature flag 或 telemetry vendor。

### Red — 禁止

- 修改通知 Worktree、生产 DB/用户/对象；
- 输出/提交 token、cookie、auth.json、provider key；
- 使用 WS/SSE/reload/page refresh 掩盖 stale state；
- 对 immutable avatar URL 添加随机版本参数作为主要修复；
- 覆盖同 hash object key；
- 通过关闭通知、跳过 race、固定 sleep 重试让测试假绿；
- 同时写 Layout 或同一 coordinator 文件；
- destructive git 命令或改写他人 commits/migrations。

---

## 5. Implement 卡顺序与交接

| Card | Task | Owner | 前置提交 | 可并行 | 结束输出 |
| --- | --- | --- | --- | --- | --- |
| I-ID-001 | T-ID-DOC-001 | Spec Coordinator | Owner approval | 无 | Frozen `D/S` + baseline ledger |
| I-ID-002 | T-ID-BE-001 | Identity Backend | `S` | I-ID-003 | header/contract commit（`S` 为祖先） |
| I-ID-003 | T-ID-CORE-001 | Identity Core | `S` | I-ID-002 | store state-machine commit（`S` 为祖先） |
| I-ID-004 | T-ID-CORE-002 | Identity Core | I-ID-003 | I-ID-002 | sync/refresh commit |
| I-ID-005 | T-ID-CORE-003 | Identity Core | I-ID-004 | I-ID-002 | FIFO/upload/race commit |
| I-ID-006 | T-ID-FE-001 | Identity Frontend | 以 `S` 为祖先的 Core public contract | I-ID-002；与 Core 后半仅在文件零重叠时 | UserAvatar/Profile commit |
| I-ID-007 | T-ID-FE-002 | Identity Frontend | I-ID-004 + UserAvatar | I-ID-002 | App/Mobile/workflow commit |
| I-ID-008 | T-ID-QA-001 | Identity QA | I-ID-002～005 | FE 可继续 | race/API/static evidence |
| I-ID-009 | T-ID-INT-001 | Identity Integration | `M_ID`（`N + C_ID`；含 I-ID-005～007） | CMI lanes | Layout-only commit |
| I-ID-010 | T-ID-INT-002 | Identity Integration | I-ID-006～009 | 无 | raw-writer closure commit |
| I-ID-011 | T-ID-QA-002 | Identity QA | I-ID-008～010 | 无 | Browser/regression/final evidence |

如果只有一个 Identity Agent，可按表顺序执行；如果多个 Agent，Backend/Core/Frontend 使用独立 Worktree，只有已提交的 contract 在分支间传递，禁止共享未提交文件。

### 5.1 每张卡的交接消息必须包含

```text
Card/Task:
Frozen develop/spec SHA (D/S):
Baseline SHA / required ancestors:
Required parent commits:
Integration SHA (N/C_ID/M_ID, when applicable):
Owned files:
Must Not Touch:
Red command + expected failure:
Acceptance IDs:
Dedicated DB/ports:
Expected commit scope:
Stop conditions:
```

### 5.2 Commit 建议

```text
test(identity): lock current-user session revision contract
fix(identity): guard profile sync and token adoption by session ticket
fix(identity): serialize profile mutations and reconcile user deltas
fix(identity): render authoritative avatar across profile and mobile identity
fix(auth): mark current profile responses private no-store
fix(identity): wire profile coordinator into notification-complete layout
refactor(identity): remove deprecated raw profile writer
test(identity): cover stale profile races and avatar propagation
```

Commit subject 可调整，但不得把 backend/core/frontend/Layout/evidence 全塞进一个 commit。

---

## 6. 实施纪律

### 6.1 Red → Green → Refactor

每卡顺序固定：

1. 添加会在当前基线稳定失败的最小测试；
2. 记录失败原因与命令，确认失败指向本 AC；
3. 做最小实现；
4. 目标测试 Green；
5. 运行直接回归；
6. 再抽取 validator/coordinator/avatar，不能先大重构；
7. `git diff --check`、Owned-files audit、commit；
8. 回填 Evidence Ledger。

测试框架边界：优先复用 backend Vitest 与现有 Playwright Test runner。纯前端状态逻辑可用不启动 webServer 的 Playwright logic config；浏览器/UI 用独立 identity Playwright config。新增 Vitest/Jest 等 root dependency 属 Yellow，必须先批准。

### 6.2 Deterministic deferred harness

禁止：

```ts
await new Promise(r => setTimeout(r, 500))
```

用于“猜测旧响应最后返回”。正确做法是创建可显式 `resolve/reject` 的 deferred transport，测试精确推进：dispatch A → dispatch mutation → resolve mutation → resolve A。

浏览器层使用 `page.route` 暂存 request，并由测试步骤显式 fulfill；只在 UI 动画稳定性处允许短暂 expect polling，不用固定 sleep 决定业务顺序。

### 6.3 人工复核

- Store 的 persist slice 是否只含 user/token/login；
- 每个 commit validator 分支是否集中；
- barriered force 是否只能由调用后 dispatch 的请求满足，userRevision reconcile 是否只有一个 trailing slot；
- logout 是否让旧 error/success/token 全失效；
- Profile 是否仍有闭包 merge/直接 updateMe；
- UserAvatar error state 是否在 URL change 后复位；
- Layout diff 是否只触及 profile/visibility/avatar，是否保留通知 cleanup；
- API header 是否只作用于 `/me` JSON，没有破坏 avatar immutable；
- trace/log 是否含 Authorization/email/profile body。

### 6.4 邻近 bug

发现 BottomTabBar、leaderboard avatar、多 Tab profile、头像裁剪等邻近需求，不在本卡顺手实现。登记 issue/Follow-up；只有阻断 P0 AC 才按停止条件升级。

---

## 7. 建议验证入口

确切文件/命令由实施时新增并记录；以下是最低层级，不得只跑 build：

```bash
# Backend profile contract（真实 Express/测试 DB）
cd server
npx vitest run src/__tests__/auth.test.ts
npm run build

# Frontend pure logic（复用 Playwright Test runner，不启动 webServer）
npx playwright test --config playwright.identity-sync.logic.config.ts

# Desktop/mobile + delayed route E2E
npx playwright test --config playwright.identity-sync.config.ts

# Static contract
rg -n "\.then\(setUser\)|getState\(\)\.setUser|setUser\(\{[[:space:]]*\.\.\.user" src
rg -n "fetchMeWithRoleHealing" src
rg -n "WebSocket|EventSource|BroadcastChannel" src/auth src/stores/authStore.ts

# Build/regression
npm run build
npm run verify:local:no-e2e
```

说明：

- `fetchMeWithRoleHealing` 若作为 coordinator 私有 helper 可存在定义/内部引用，但页面/组件引用必须为零。
- 静态 `rg` 命中必须人工分类并记录，不得以命令 exit code 单独宣称通过。
- `verify:local:no-e2e` 是否会使用默认 DB 必须在运行前审计脚本/env；若无法保证专库则不运行，改用等价安全命令并记录。
- Final Gate 还须运行通知规格指定的前端回归命令，以其 Frozen 文档为准，不在此猜造命令。

---

## 8. Evidence Ledger

执行时在 PR/交接文档填表；Frozen 也不预填尚未产生的实施结果。

| Evidence ID | Card | Commit | Command/Scenario | Result | Artifact | Reviewer |
| --- | --- | --- | --- | --- | --- | --- |
| E-ID-001 | I-ID-001 | TBD | `D/S`、`S^=D`、docs-only Spec/parallel consistency | Pending | TBD | TBD |
| E-ID-002 | I-ID-002 | TBD | real GET/PATCH header/projection | Pending | TBD | TBD |
| E-ID-003 | I-ID-003 | TBD | epoch/revision/persist + three updatePoints callers | Pending | TBD | TBD |
| E-ID-004 | I-ID-004 | TBD | GET/role/refresh stale matrix | Pending | TBD | TBD |
| E-ID-005 | I-ID-005 | TBD | FIFO/reconcile/upload 1,000 races | Pending | TBD | TBD |
| E-ID-006 | I-ID-006 | TBD | Avatar/Profile component/browser | Pending | TBD | TBD |
| E-ID-007 | I-ID-007 | TBD | Protected/Mobile/workflow | Pending | TBD | TBD |
| E-ID-008 | I-ID-009 | TBD | Layout diff + `N/C_ID/M_ID` + 两条 ancestor exit 0 | Pending | TBD | TBD |
| E-ID-009 | I-ID-010 | TBD | raw setter definition/caller closure | Pending | TBD | TBD |
| E-ID-010 | I-ID-011 | TBD | desktop/mobile/stale E2E | Pending | TBD | TBD |
| E-ID-011 | Final Gate | TBD | full build/regression/rollback + AC map | Pending | TBD | TBD |

Artifact 必须位于专用临时/测试输出，提交前检查无 token/cookie/PII。截图账户使用 fixture nickname/email，不使用真实数据。

---

## 9. PR Gate

### 9.1 Backend PR

- [ ] branch/PR tip 以 Frozen spec `S` 为祖先；
- [ ] diff 只含 auth controller/test；
- [ ] GET/PATCH `private,no-store` 与完整 projection真实测试；
- [ ] uploads immutable 回归；
- [ ] 无 middleware/service/schema 扩大变更。

### 9.2 Core PR

- [ ] Core/FE branch tip 以 Frozen spec `S` 为祖先；
- [ ] session/revision/persist/FIFO/refresh contracts；
- [ ] 1,000 deterministic race；
- [ ] Core 新代码不调用 raw profile setter；临时 deprecated adapter 及待迁移 caller 清单与 Spec §11.4 精确一致；
- [ ] no new runtime dependency/realtime transport；
- [ ] no Layout/appStore/notification diff。

### 9.3 Frontend PR

- [ ] Frontend 从包含 `S` 的 Core contract tip 开始；
- [ ] UserAvatar/Profile/Mobile/App/workflow 接线；
- [ ] no closed-over merge；
- [ ] applied-only Toast；
- [ ] a11y/source-change/error fallback；
- [ ] no Layout diff。

### 9.4 Layout PR

- [ ] branch 从已记录的 `M_ID` 开始，`N` 与 `C_ID` 均为 `M_ID` 祖先，两条 `git merge-base --is-ancestor` 为 exit 0；
- [ ] 通知 owner/协调者确认文件锁释放；
- [ ] diff 是 pathname fetch removal + visibility + desktop avatar 最小接线；
- [ ] appStore/realtime zero diff；
- [ ] identity + notification suites Green。

### 9.5 Writer-closure PR

- [ ] parent 已含所有 FE/Layout caller 迁移；
- [ ] diff 仅删除 deprecated raw `setUser`/死类型；
- [ ] raw writer 定义与 caller 静态命中均为零；
- [ ] 没有同义 unsafe replacement；
- [ ] build Green。

### 9.6 Final/Release Gate

- [ ] final candidate 以 `S` 为祖先；Layout/writer-closure/final candidate 还以 `M_ID` 为祖先；
- [ ] AC-ID-001～024 全有证据；
- [ ] backend/race/browser/static/build/regression Green；
- [ ] stale response 对新 session 零副作用；
- [ ] desktop/mobile/clear/404 实机浏览器 Green；
- [ ] `/me` 请求率无 pathname 放大；
- [ ] rollback rehearsal 不覆盖通知 commits、不回滚用户已提交 profile；
- [ ] PAR-CMI Gates 通过。

---

## 10. Blocked 模板

```text
Card/Task:
Current SHA / Worktree:
Blocking condition:
First observed:
Repeated evidence / attempts:
What remains safe and completed:
Exact file lock or Owner decision needed:
Options with trade-off:
Recommended next action:
Artifacts (sanitized):
```

“通知还在改 Layout”是正常依赖，不阻塞 Identity Core；只把 I-ID-009、I-ID-010、I-ID-011 保持 Pending。不得因等待 Layout 而停止 Backend/Core/Profile/Mobile 的安全工作。

---

## 11. 完成交接

最终交接必须包含：

- Spec/Plan/Task/Implement/Checklist/PAR-CMI 版本与 Frozen SHA；
- `D/S/N/C_ID/M_ID`、implementation baseline、`S^=D` 与两条 `N/C_ID→M_ID` ancestor 命令证据、Foundation/CMI 是否无关的确认；
- Backend/Core/Frontend/Layout/writer-closure commits 按顺序列表；
- Worktree/branch/DB/ports 及 clean status；
- 24 AC → Evidence 映射；
- static raw-writer/forbidden-file audit；
- 测试命令与实际结果、已知 skipped 原因（P0 不允许无理由 skip）；
- 指标/日志/trace 脱敏确认；
- 发布、观察、回滚说明；
- P1 多 Tab事项，不混入 P0 完成声明。
