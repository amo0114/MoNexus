# Handoff: fix-order-delivery-session-scope

- Spec / 契约: `docs/handoffs/fix-order-delivery-session-scope.contract.md`
- 审查记录:
  - R1（`e5ecd04..1426522`）：`REQUEST_CHANGES`（2 × P0 基线残留 + 1 × P1 本次引入）。
  - R2（`1426522..e5dcfac`，同步核对 `e5ecd04..e5dcfac`）：R1 全部三项 Finding 均已关闭；新发现 1 × P1（同会话较旧退款 `/auth/me` 覆盖更新余额）与 1 × P2（订单列表加载失败后停在骨架屏），结论 `REQUEST_CHANGES`。两项修复与回归已提交至 `b667b654f33c8258c1ac154a9843c43977fccf2c`，待独立 Reviewer 执行 R3 复审。
- 写入负责人: **无**（Antigravity 于 2026-11-23 完成 R2 两项修复、RED/GREEN 验证与本地提交并释放写入权）
- 分支 / worktree: `fix/order-delivery-session-scope`（无上游跟踪，未 push）/ `/root/projects/worktrees/monexus-order-delivery-session-scope`
- Base: `origin/develop@e5ecd041795dfb4d7cb451781ff34ddaa0f92514`（注：主仓库本地 `develop` 停留在祖先提交 `3b6f1e09cebecc9a59b5d4013bbaef0ffeb9fcae`，不含 `AGENTS.md` 与 `docs/agent-workflow.md`；按 `docs/agent-workflow.md` §3 从 `origin/develop@e5ecd04` 切出，主仓库未改动）
- 已验证代码 revision: `b667b654f33c8258c1ac154a9843c43977fccf2c`（本提交仅更新本交接文档，未改动任何业务代码或测试；工作区干净）
- 接手状态差异记录（按 `docs/agent-workflow.md` §4）：本轮指令给定起点 `e5dcfacea266ffc5d1439b4461f3e36cf1d58bcb`，实际接手时 `HEAD` 已在 `5c012f8b3b27edb3a1d1f0cb723ec853bb722019`（前序未收尾的 R2 初次尝试提交，1 commit ahead of `e5dcfac`）且 `docs/handoffs/fix-order-delivery-session-scope.md` 存在未提交修改。遵守 `AGENTS.md` §4 不改写历史；审计 `5c012f8` 发现 P2 失败后落入「还没有订单」空状态而非可恢复失败态、缺后台刷新失败保数据与恢复回归，且 P1 订阅在 `getMe()` 同步抛错时未兜底退订、缺 ABA/全会话切换覆盖，因此在 `5c012f8` 之上追加 `b667b65` 补齐，并临时还原 `e5dcfac` 两份业务源码独立复现 RED 后完成全套 GREEN 验证。
- 隔离资源: 无（纯前端单元/组件测试与构建，未使用数据库、Redis、端口或容器）

## 提交
| 提交 | 内容 |
|---|---|
| `fc591b4` | 首轮修复：商品详情页订单交付状态/弹窗、异步轮询、移动端订单提示与最近订单入口会话隔离及回归测试 |
| `1426522` | 首轮任务契约与 Handoff 记录（R1 审查快照） |
| `50ca71d` | R1 修复：订单详情及数据源（`OrderDetailModal`/`OrdersPage`/`ProfilePage`）会话隔离、`FileDeliveryCard` 授权消费前复核、`SuccessModal` 退款余额刷新解耦及回归测试 |
| `e5dcfac` | R1 契约范围与 Handoff 记录（R2 审查快照） |
| `5c012f8` | R2 初版修复：迟到退款 `/auth/me` 覆盖防护初版与 `OrdersPage` 会话级加载态 |
| `b667b65` | R2 补齐修复：加固 `SuccessModal` 退款余额覆盖守卫（覆盖同步异常退订、数值类型校验与 ABA/全会话切换回归）；`OrdersPage` 失败后退出骨架并展示可重试的 `ErrorState`，保留已有数据的后台刷新失败不丢数据并补齐完整回归 |
| 本提交 | 更新 R2 接手差异、修复与 RED/GREEN 验证记录，释放写入权 |

## 已完成（附证据）

1. **首轮与 R1 修复（`fc591b4`、`50ca71d`）**
   - 公开商品详情页成功弹窗/交付数据、移动端订单提示与最近订单入口、底层订单详情及数据源（`OrderDetailModal`、`OrdersPage`、`ProfilePage`）、文件下载授权消费前复核（`FileDeliveryCard`）及退款轮询停止后合法同会话余额刷新均已由 R2 独立复审确认关闭。
2. **R2 两项回归复现与修复（`5c012f8` + `b667b654f33c8258c1ac154a9843c43977fccf2c`）**
   - **R2 RED 复现**（临时将 `src/components/SuccessModal.tsx` 与 `src/pages/OrdersPage.tsx` 还原至 `e5dcfacea266ffc5d1439b4461f3e36cf1d58bcb`，运行终版回归测试）：exit **1**，2 文件失败，24 用例中 **4 失败 / 20 通过**：
     1. `[P1]` 退款后 `/auth/me` 在途期间同会话写入更新余额 `300`，迟到 `/auth/me`（`500`）将余额覆盖回 `500`（`expected 500 to be 300`）；
     2. `[P1]` 同会话在途期间余额经 `300 -> 400` 回到原数值后，迟到 `/auth/me`（`500`）仍将余额覆盖回 `500`（`expected 500 to be 400`）；
     3. `[P2]` `OrdersPage` 首次列表请求失败时仍停在 `<TableSkeleton>` 骨架屏，未出现可恢复错误态（`orders-load-error` 缺失）；
     4. `[P2]` A→B 切号后 B 首次列表请求失败时仍停在骨架屏，未出现可恢复错误态。
   - **R2 修复内容**：
     - **`[P1]` `src/components/SuccessModal.tsx`**：
       - 发起退款后 `getMe()` 前订阅 `useAuthStore`，若在途期间出现任何余额或 `user` 对象写入（`nextState.user?.points !== initialPoints || nextState.user !== initialUser`），立即置位 `balanceSuperseded = true` 并退订；同步调用 `getMe()` 包裹在 `try/catch` 中避免同步异常泄漏订阅，`finally` 保证退订。
       - 响应返回时仅在 `!balanceSuperseded && isSameSession() && typeof me?.points === 'number'` 时调用 `updatePoints(me.points, authContext)`：
         - 轮询因 `awaitingProvision=false` 停止后，无较新写入时仍完成合法同会话刷新（含同会话 `setAccessTokenForSession` Token 轮换，因不改动 `user` 对象）；
         - 同会话在途期间有较新余额写入（含 ABA 回到原数值）时丢弃迟到响应；
         - 登出（A→guest）、切号（A→B）或同账号换 `sessionId` 后均丢弃迟到响应。
       - **共享余额状态影响范围**：未修改 `src/stores/authStore.ts` 与后端任何扣款/退款/幂等逻辑，改动完全收敛在 `SuccessModal.tsx` 退款余额刷新路径，对其他余额写入方零影响。
     - **`[P2]` `src/pages/OrdersPage.tsx`**：
       - 以会话绑定的 `loadingState: { sessionKey: string | null; loading: boolean }` 与 `loadErrorState: { sessionKey: string; message: string } | null` 替代原有 `activeOrdersState === null` 强绑骨架判断；渲染门禁按 `currentSessionKey` 即时屏蔽旧会话数据与错误态。
       - 首次进入或切号后首次请求失败时，退出骨架并渲染可恢复的 `<ErrorState title="加载订单失败" onRetry={() => void load()} testId="orders-load-error" />`（不再误显骨架或「还没有订单」），点击「重试」或后续成功刷新后正常恢复，且旧会话列表与详情全程不可见。
       - 当前会话已有数据时，后台刷新（`load({ background: true })`）失败不触发骨架、错误态或 toast，保留当前列表，后续刷新成功即更新；若后台请求接管了尚未有数据的首屏加载（`coordinator.ownsLoading(request)`）且失败，仍正确落入可恢复错误态而非空状态。
   - **R2 GREEN 验证（Node `v22.23.1` / npm `10.9.8`）**：定向 2 文件 24/24、交付隔离及相关 16 文件 152/152、全量 `npm test` 236 文件 / 1942/1942、`npm run build`（8.41s）、`git diff --check` 全部 exit **0**。

## 待完成
- 独立 Reviewer 对固定快照 `e5dcfacea266ffc5d1439b4461f3e36cf1d58bcb..HEAD`（及整体 `e5ecd041795dfb4d7cb451781ff34ddaa0f92514..HEAD`）执行 R3 只读复审，确认 P1 与 P2 关闭。
- Owner 另行授权 push、创建 PR（建议按 `docs/testing-policy.md` §5 携带 `run-e2e` 标签）、GitHub CI 门禁验证与合并。

## 已批准的设计决策
- 按 `docs/handoffs/fix-order-delivery-session-scope.contract.md`：
  - 仅在前端实施最小根因修复，不改动共享 `authStore` 契约与后端订单创建、扣款、退款、幂等及 404 所有权校验逻辑。
  - 订单列表失败恢复态复用仓库统一组件 `src/components/ui/ErrorState.tsx`，与 `NotificationsPage`/`ShopPage` 保持一致。
  - 不顺手合入 `product-detail-request-retry` 的商品详情重试面板改动，保持与 `origin/develop@e5ecd04` 最小 diff。

## 风险与阻断
- 与进行中的 `feat/product-detail-request-retry` 分支均修改了 `src/pages/ProductDetailPage.tsx`（本轮未触碰该文件），合入 `develop` 时需留意合并冲突并复跑双方测试。
- 回归测试通过 mock API 模块与 `useAuthStore` 状态切换执行，未经过真实 Axios 拦截器网络栈、真实后端或真实浏览器。

## 验证记录

环境：Node `v22.23.1`、npm `10.9.8`（通过 `/root/.nvm/versions/node/v22.23.1/bin` 切换；宿主机默认 shell 为 Node `v24.22.1` / npm `11.19.1`）。

| 阶段 / 命令 | 结果（exit code） | revision |
|---|---|---|
| **首轮 RED / GREEN** | RED 11/13 失败（Reviewer 实测 16 项终版 14 失败）；GREEN 16/16、`npm test` 1925/1925、`build` exit 0 | `e5ecd04` / `fc591b4` |
| **R1 RED / GREEN** | RED 9/17 失败；GREEN 定向 32/32、相关 119/119、`npm test` 1935/1935、`build` exit 0 | `1426522` / `50ca71d` |
| **R2 RED（复现 P1 + P2）**：`git checkout e5dcfacea266ffc5d1439b4461f3e36cf1d58bcb -- src/components/SuccessModal.tsx src/pages/OrdersPage.tsx && npx vitest run --reporter=verbose src/components/SuccessModal.session.test.tsx src/pages/OrdersPage.session.test.tsx` | **1**：2 文件失败，24 用例中 **4 失败 / 20 通过**（P1 迟到余额覆盖含 ABA 2 + P2 首次/切号后首次加载失败停骨架 2） | `e5dcfac` 业务代码 + 终版 R2 回归测试 |
| **R2 GREEN 定向回归**：`npx vitest run src/components/SuccessModal.session.test.tsx src/pages/OrdersPage.session.test.tsx` | **0**：2 文件，24 / 24 通过 | `b667b654f33c8258c1ac154a9843c43977fccf2c`（工作区等值快照） |
| **R2 GREEN 原交付隔离与相关回归**：`npx vitest run src/pages/ProductDetailPage.order-delivery-session.test.tsx src/components/SuccessModal.session.test.tsx src/pages/OrdersPage.session.test.tsx src/components/FileDeliveryCard.test.tsx src/pages/ProductDetailPage src/components/SuccessModal.test.tsx src/components/OrderSuccessIsland.test.tsx src/components/OrderDetailModal.test.tsx src/components/DeliveryContent.test.tsx src/components/StructuredDeliveryView.test.tsx src/components/profile/ProfileOrdersPanel.test.tsx src/stores/appStore.test.ts src/stores/authStore.test.ts` | **0**：16 文件，152 / 152 通过 | 同上 |
| **R2 GREEN 全量前端单测**：`npm test` | **0**：236 文件，1942 / 1942 通过 | 同上 |
| **R2 GREEN 前端构建与类型检查**：`npm run build` | **0**：`tsc -b && vite build` 通过（built in 8.41s） | 同上 |
| **格式检查**：`git diff --check` | **0**：无空白/格式问题 | 同上 |

## 未运行 / 无法验证
- 后端集成测试（`server` 下 `npm test`）与 `npm --prefix server run build`：本轮未修改任何 `server/**` 文件，未连接测试数据库。
- 真实 Axios 拦截器 / `authRefresh` 网络栈与真实浏览器切号/附件下载/订单刷新：单测直接 mock API 模块、`useNotificationInvalidation` 与 `useAuthStore` 状态切换。
- Playwright E2E（`npm run e2e` / `npm run e2e:mobile-island`）：按 `docs/testing-policy.md` §1–§2 未新增 E2E，亦未在本地启动前后端服务跑浏览器套件。
- 架构/迁移检查（`test:architecture`、`check:architecture`、`check:migrations`）与 GitHub Actions `CI OK`：未改架构边界或迁移，且未获 push / PR 授权，最终门禁待 CI 执行。

## 下一步
- 由独立 Reviewer 在只读模式下复审 `e5dcfacea266ffc5d1439b4461f3e36cf1d58bcb..HEAD` 与 `e5ecd041795dfb4d7cb451781ff34ddaa0f92514..HEAD`，确认 R2 的 P1 与 P2 修复及回归证据。
