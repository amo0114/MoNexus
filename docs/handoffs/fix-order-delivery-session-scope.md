# Handoff: fix-order-delivery-session-scope

- Spec / 契约: `docs/handoffs/fix-order-delivery-session-scope.contract.md`
- 审查记录: R1（`e5ecd041795dfb4d7cb451781ff34ddaa0f92514..1426522dc8547a82d9709b5fc268b0ca4c30bc76`）结论 `REQUEST_CHANGES`（2 × P0 基线残留 + 1 × P1 本次引入）；R1 全部三项修复已提交于 `50ca71d`，待独立 Reviewer 执行 R2 复审。
- 写入负责人: **无**（Antigravity 于 2026-11-23 完成 R1 全部三项修复、验证与本地提交并释放写入权）
- 分支 / worktree: `fix/order-delivery-session-scope`（无上游跟踪，未 push）/ `/root/projects/worktrees/monexus-order-delivery-session-scope`
- Base: `origin/develop@e5ecd041795dfb4d7cb451781ff34ddaa0f92514`（注：主仓库本地 `develop` 指针停留在祖先提交 `3b6f1e09cebecc9a59b5d4013bbaef0ffeb9fcae`，不含 `AGENTS.md` 与 `docs/agent-workflow.md`；按 `docs/agent-workflow.md` §3 从 `origin/develop@e5ecd04` 切出，主仓库未改动）
- 已验证代码 revision: `50ca71ddc8c28f57a8d68bd5c4c647d72a61ab55`（本提交仅更新契约允许路径列表与本交接文档，未改动任何业务代码或测试；工作区干净）
- 隔离资源: 无（纯前端单元/组件测试与构建，未使用数据库、Redis、端口或容器）

## 提交
| 提交 | 内容 |
|---|---|
| `fc591b4` | 首轮修复：商品详情页订单交付状态/弹窗、异步轮询、移动端订单提示与最近订单入口会话隔离及回归测试 |
| `1426522` | 首轮任务契约与 Handoff 记录（R1 审查快照） |
| `50ca71d` | R1 修复：订单详情及数据源（`OrderDetailModal`/`OrdersPage`/`ProfilePage`）会话隔离、`FileDeliveryCard` 授权消费前复核、`SuccessModal` 退款余额刷新解耦及回归测试 |
| 本提交 | 更新契约范围与 R1 修复验证记录，释放写入权 |

## 已完成（附证据）

1. **首轮 Base RED 复现与修复（`fc591b4`）**
   - 在 `origin/develop@e5ecd04` 上用合成数据复现公开商品详情页成功弹窗/交付数据跨会话残留、重载重挂载、迟到响应与移动端订单提示/最近订单入口问题（13 项初版用例 11 失败 / 2 通过；Reviewer 在 Base 上验证 16 项终版用例为 14 失败 / 2 通过）。
   - 完成 `sessionContext.ts`、`ProductDetailPage.tsx`、`SuccessModal.tsx`、`appStore.ts`、`OrderSuccessIsland.tsx`、`useOrderRenewal.ts`、`OrderDetailModal.tsx` 首轮修复。
2. **R1 三项 Finding 复现与修复（`50ca71ddc8c28f57a8d68bd5c4c647d72a61ab55`）**
   - **R1 RED 复现**（在 `1426522` 业务代码 + 新增 R1 回归测试上运行 `SuccessModal.session.test.tsx` 与 `OrdersPage.session.test.tsx`）：exit 1，17 用例中 **9 失败 / 8 通过**，精准复现全部三项 Finding：
     1. `[P0]` `OrderDetailModal` 续费切号后首帧仍含原订单 `SYNTH-ORIG-ORDER-SECRET`（1 失败）及 `OrdersPage` 切号（A→访客 / A→B / 同账号换 `sessionId`）首帧与迟到 `getOrderDetail` 仍显示旧订单交付内容（4 失败）；
     2. `[P0]` `FileDeliveryCard` 下载授权在会话切换（A→访客 / A→B / 同账号换 `sessionId`）并卸载弹窗后仍触发 `location.assign`（3 失败）；
     3. `[P1]` `SuccessModal` 同会话收到 `refunded` 后停止轮询触发清理，导致迟到 `/auth/me` 被 `cancelled` 拦下，积分停留 400 而未恢复 500（1 失败）。
   - **R1 修复内容**：
     - **`[P0]` 订单详情及其数据源会话隔离**：
       - `src/components/OrderDetailModal.tsx`：新增 `ownerSessionKey`（缺省捕获挂载时会话）、永久吊销锁 `sessionRevokedRef` 与渲染期门禁 `if (!sessionAuthorized) return null`，确保 A→访客、A→B、同账号换 `sessionId` 首次 DOM 提交同时隐藏原订单交付与续费弹窗；复制与订单操作同样复核原会话，并向 `DeliveryContent` 透传 `ownerSessionKey`；移除跨会话被动调用 `onClose`，保持 `OrderDetailModal.test.tsx` 既有契约。
       - `src/pages/OrdersPage.tsx` 与 `src/pages/ProfilePage.tsx`：将 `orders`、`selectedOrder`、`loadingOrderId` 绑定到 `sessionKey`，渲染期即按 `currentSessionKey` 门禁并在会话变化时清空状态、作废在途请求并按新会话重载；迟到的 `getOrdersPage`/`getOrders`/`getOrderDetail`/`reloadBuyerState` 响应跨会话一律丢弃；挂载 `<OrderDetailModal>` 时传 `key` 与 `ownerSessionKey`。
     - **`[P0]` 文件下载授权消费前复核**：
       - `src/components/DeliveryContent.tsx` 与 `src/components/FileDeliveryCard.tsx`：透传 `ownerSessionKey`；`FileDeliveryCard.handleDownload` 在发起前与 `await issueOrderFileDownloadUrl(orderId)` 返回后、`window.location.assign(grant.url)` 执行前均重新核对 `getAuthSessionScopeKey(useAuthStore.getState()) === downloadSessionKey`，跨会话/失配时放弃导航且不弹错误 toast；同会话 Token 轮换期间正常触发下载；同步更新 `src/components/FileDeliveryCard.test.tsx` 登录买家夹具。
     - **`[P1]` 退款后同会话余额刷新解耦**：
       - `src/components/SuccessModal.tsx`：拆分 `isSameSession()`（仅校验会话归属）与 `isPollingActive()`（`!cancelled && isSameSession()`）；`detail.status === 'refunded'` 触发 `setAwaitingProvision(false)` 后，`getMe()` 回调改用 `isSameSession()` 校验，合法同会话（含正常 Token 轮换）余额刷新可顺利完成，跨会话切换仍严格拦下。
   - **R1 GREEN 验证**：Node `v22.23.1` / npm `10.9.8` 下，4 个定向回归文件 32/32、12 个相关详情与交付测试文件 119/119、全量 `npm test` 236 文件 / 1935/1935、`npm run build`、`git diff --check` 全部 exit 0。

## 待完成
- 独立 Reviewer 对固定快照 `1426522dc8547a82d9709b5fc268b0ca4c30bc76..HEAD`（及整体 `e5ecd041795dfb4d7cb451781ff34ddaa0f92514..HEAD`）执行 R2 只读复审，确认两项 P0 与一项 P1 关闭。
- Owner 另行授权 push、创建 PR（建议按 `docs/testing-policy.md` §5 携带 `run-e2e` 标签）、GitHub CI 门禁验证与合并。

## 已批准的设计决策
- 按 `docs/handoffs/fix-order-delivery-session-scope.contract.md`：
  - 仅在前端实施最小根因修复，不改动后端订单创建、扣款、幂等与 404 所有权校验逻辑。
  - 不顺手合入 `product-detail-request-retry` 的商品详情重试面板改动，保持与 `origin/develop@e5ecd04` 最小 diff。
  - 对所有买家交付展示与动作入口（`ProductDetailPage`、`SuccessModal`、`OrderDetailModal`、`OrdersPage`、`ProfilePage`、`DeliveryContent`、`FileDeliveryCard`、`OrderSuccessIsland`、`useOrderRenewal`）统一采用 `getAuthSessionScopeKey` 做渲染期归属门禁 + 副作用清理 + 异步消费前复核。

## 风险与阻断
- 与进行中的 `feat/product-detail-request-retry` 分支均修改了 `src/pages/ProductDetailPage.tsx`（本次未触碰详情加载 `useEffect` 与重试逻辑），合入 `develop` 时需留意合并冲突并复跑双方测试。
- 回归测试通过 mock API 模块与 `useAuthStore` 状态切换执行，未经过真实 Axios 拦截器网络栈、真实后端或真实浏览器。

## 验证记录

环境：Node `v22.23.1`、npm `10.9.8`（通过 `/root/.nvm/versions/node/v22.23.1/bin` 切换；宿主机默认 shell 为 Node `v24.22.1` / npm `11.19.1`）。

| 阶段 / 命令 | 结果（exit code） | revision |
|---|---|---|
| **首轮 RED（Base）**：`npx vitest run src/pages/ProductDetailPage.order-delivery-session.test.tsx src/components/SuccessModal.session.test.tsx` | **1**：13 项初版用例 11 失败 / 2 通过（Reviewer 实测 16 项终版用例在 Base 为 14 失败 / 2 通过） | `e5ecd04` + 新增测试 |
| **首轮 GREEN**：定向 16/16、相关 12 文件 123/123、`npm test` 235 文件 1925/1925、`npm run build`、`git diff --check` | **0** | `fc591b4` |
| **R1 RED（复现 3 项 Finding）**：`npx vitest run src/components/SuccessModal.session.test.tsx src/pages/OrdersPage.session.test.tsx` | **1**：2 文件失败，17 用例中 9 失败 / 8 通过（覆盖全部 2 × P0 + 1 × P1） | `1426522` + 新增 R1 回归测试 |
| **R1 GREEN 定向回归**：`npx vitest run src/pages/ProductDetailPage.order-delivery-session.test.tsx src/components/SuccessModal.session.test.tsx src/pages/OrdersPage.session.test.tsx src/components/FileDeliveryCard.test.tsx` | **0**：4 文件，32 / 32 通过 | `50ca71ddc8c28f57a8d68bd5c4c647d72a61ab55`（工作区等值快照） |
| **R1 GREEN 相关详情与交付测试**：`npx vitest run src/pages/ProductDetailPage src/components/SuccessModal.test.tsx src/components/OrderSuccessIsland.test.tsx src/components/OrderDetailModal.test.tsx src/components/DeliveryContent.test.tsx src/components/StructuredDeliveryView.test.tsx src/components/profile/ProfileOrdersPanel.test.tsx src/stores/appStore.test.ts` | **0**：12 文件，119 / 119 通过（含 `OrderDetailModal.test.tsx` 28/28） | 同上 |
| **R1 GREEN 全量前端单测**：`npm test` | 首轮并发下 `OrderDetailModal.test.tsx:166` 单例超时（exit 1，1934/1935，既有 `PurchaseModal` 并发 `armed` 时序）；紧接全量重跑 **exit 0**：236 文件，1935 / 1935 通过 | 同上 |
| **R1 GREEN 前端构建与类型检查**：`npm run build` | **0**：`tsc -b && vite build` 通过（built in 10.39s） | 同上 |
| **格式检查**：`git diff --check` | **0**：无空白/格式问题 | 同上 |

## 未运行 / 无法验证
- 后端集成测试（`server` 下 `npm test`）与 `npm --prefix server run build`：本次未修改任何 `server/**` 文件，未连接测试数据库。
- 真实 Axios 拦截器 / `authRefresh` 网络栈与真实浏览器切号/附件下载：单测直接 mock API 模块并通过 `useAuthStore` 切换/轮换模拟会话变更。
- Playwright E2E（`npm run e2e` / `npm run e2e:mobile-island`）：按 `docs/testing-policy.md` §1–§2 未新增 E2E，亦未在本地启动前后端服务跑浏览器套件。
- 架构/迁移检查与 GitHub Actions `CI OK`：未改架构边界或迁移，且未获 push / PR 授权，最终门禁待 CI 执行。

## 下一步
- 由独立 Reviewer 在只读模式下复审 `1426522..HEAD` 与 `e5ecd04..HEAD`，确认 R1 的两项 P0 与一项 P1 修复及回归证据。
