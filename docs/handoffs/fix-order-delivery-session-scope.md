# Handoff: fix-order-delivery-session-scope

- Spec / 契约: `docs/handoffs/fix-order-delivery-session-scope.contract.md`
- 审查记录: 无（待独立 Reviewer 复审）
- 写入负责人: **无**（Antigravity 于 2026-11-23 完成本地修改、验证与提交并释放写入权）
- 分支 / worktree: `fix/order-delivery-session-scope`（无上游跟踪，未 push）/ `/root/projects/worktrees/monexus-order-delivery-session-scope`
- Base: `origin/develop@e5ecd041795dfb4d7cb451781ff34ddaa0f92514`（注：主仓库本地 `develop` 指针停留在祖先提交 `3b6f1e09cebecc9a59b5d4013bbaef0ffeb9fcae`，不含 `AGENTS.md` 与 `docs/agent-workflow.md`；按 `docs/agent-workflow.md` §3 从 `origin/develop@e5ecd04` 切出，主仓库未改动）
- 已验证代码 revision: `fc591b44601f99f1244c91fc062c4894e144aaef`（本提交仅追加契约与本交接文档，未改动任何业务代码或测试；工作区干净）
- 隔离资源: 无（纯前端单元/组件测试与构建，未使用数据库、Redis、端口或容器）

## 提交
| 提交 | 内容 |
|---|---|
| `fc591b4` | 修复订单交付状态、弹窗、轮询、移动端订单提示与最近订单入口的会话隔离，并新增回归测试 |
| 本提交 | 补充仓库内任务契约与 Handoff 记录，释放写入权 |

## 已完成（附证据）

1. **Base RED 复现（合成数据）**
   - 在未修改业务代码的 `origin/develop@e5ecd04` 上运行新增合成数据回归测试，结果 exit 1（13 用例中 11 失败 / 2 通过，仅两项同会话正常 Token 轮换正例通过）：
     - `ProductDetailPage.order-delivery-session.test.tsx`：A→访客首帧 DOM 提交泄漏交付文本/结构化/文件数据并在公开商品重载后重挂载旧弹窗；A→B、同账号换 `sessionId` 首帧 DOM 提交仍含旧弹窗与交付数据；迟到 `createOrder` 响应为新会话打开旧弹窗；移动端 `OrderSuccessIsland` 与最近订单入口「查看本次订单」跨会话残留（6 失败 / 1 通过）。
     - `SuccessModal.session.test.tsx`：访客直接挂载仍渲染交付内容并启动轮询；A→访客 / A→B / 同账号换 `sessionId` 后首帧未隐藏且迟到轮询未隔离；`OrderDetailModal` 续费成功弹窗在 A→B 首帧未隐藏（5 失败 / 1 通过）。
2. **根因修复（提交 `fc591b44601f99f1244c91fc062c4894e144aaef`）**
   - `src/auth/sessionContext.ts`：新增 `getAuthSessionScopeKey`，将登录态绑定到 `isLoggedIn + authEpoch + userId + JWT sid + sessionId`（对非 JWT 存量测试夹具保持兼容），同一会话正常 Token 轮换保持键不变；A→访客、A→B、同账号换 `sessionId` 或 `userId` 与 Token 不一致时立即变化或归 `null`。
   - `src/pages/ProductDetailPage.tsx`：将 `orderSuccess`（弹窗显隐、`orderId`、文本/结构化/文件交付、商家名、异步开通态）、`purchaseModalScope`、`purchasingAttempt` 统一绑定到 `sessionKey + productRouteId`；渲染期即校验归属，确保首次 React DOM 提交不含旧交付内容、旧弹窗与移动端「查看本次订单」入口；`useEffect([id, currentOrderSessionKey])` 彻底清空旧状态，公开商品重载后不会重挂载旧弹窗；`handlePurchase` 在请求前、`createOrder` 返回后、异常分支、移动端岛通知、点击回调及购买后详情刷新中全程核对 `isSameSession()`，丢弃迟到响应。
   - `src/components/SuccessModal.tsx`：支持 `ownerSessionKey`（省略时默认捕获挂载时的登录会话键），未授权或会话失配时在渲染期即返回 `null` 并以 `sessionRevokedRef` 永久锁定该实例不可复活；同步在副作用中清空内部交付状态、停掉轮询定时器并通知 `onClose`；异步交付轮询（含 `delivered`/`completed`/`closed`/`refunded`、`getMe()` 与错误重试）及复制操作均绑定原会话。
   - `src/stores/appStore.ts` 与 `src/components/OrderSuccessIsland.tsx`：`IslandNotice` 增加可选 `sessionKey`，`triggerIslandActivity` 拒绝跨会话写入，`useAuthStore.subscribe` 将 `getAuthSessionScopeKey` 纳入身份比对；`OrderSuccessIsland` 在渲染期按 `sessionKey` 门禁 `notice` 与滞留的 `content`（跨会话切换时首帧立即清除，不等待 350ms 退出动画；同会话关闭仍保留正常退场动效）。
   - `src/hooks/useOrderRenewal.ts` 与 `src/components/OrderDetailModal.tsx`：续费结算态 `renewInfo`、续费成功态 `renewSuccess`、移动端续费提示及续费 `<SuccessModal>` 统一绑定 `sessionKey` 与 `ownerSessionKey`。
   - `src/components/SuccessModal.test.tsx`：在 `beforeEach` 中补齐登录买家会话初始化，以匹配 `SuccessModal` 强制仅对登录发起会话可见的安全契约；未改动后端与现有订单创建/扣款/幂等语义。
3. **验证通过**：在 Node `v22.23.1` / npm `10.9.8` 下，定向回归（16/16）、相关详情与交付测试（12 文件 123/123）、全量 `npm test`（235 文件 1925/1925）、`npm run build` 与 `git diff --check` 全部 exit 0。

## 待完成
- 独立 Reviewer 对固定快照 `e5ecd041795dfb4d7cb451781ff34ddaa0f92514..HEAD` 进行只读复审。
- Owner 另行授权 push、创建 PR（触及认证/会话与下单交付关键路径，按 `docs/testing-policy.md` §5 建议建 PR 时带 `run-e2e` 标签）、CI 门禁验证与合并。

## 已批准的设计决策
- 按 `docs/handoffs/fix-order-delivery-session-scope.contract.md`：
  - 仅在前端实施最小根因修复，不改动后端订单创建、扣款、幂等与 404 所有权校验逻辑。
  - 不顺手合入 `product-detail-request-retry` 的商品详情重试面板改动，保持与 `origin/develop@e5ecd04` 最小 diff。
  - 采用渲染期归属门禁 + 副作用状态清理 + 异步响应/轮询会话校验三层防护，同时确保同一会话正常 Token 轮换（`setAccessTokenForSession`）不中断弹窗、交付查看、移动端提示与轮询。

## 风险与阻断
- 与进行中的 `feat/product-detail-request-retry` 分支均修改了 `src/pages/ProductDetailPage.tsx`（但本次未触碰详情加载 `useEffect` 与重试逻辑），合入 `develop` 时需留意两分支的合并冲突并复跑双方测试。
- 回归测试通过 mock `api.get` / `createOrder` / `getOrderDetail` 与 `useAuthStore` 状态切换执行，未经过真实 Axios 拦截器、后端接口或真实浏览器。

## 验证记录

环境：Node `v22.23.1`、npm `10.9.8`（通过 `/root/.nvm/versions/node/v22.23.1/bin` 切换；宿主机默认 shell 为 Node `v24.22.1` / npm `11.19.1`）。

| 阶段 / 命令 | 结果（exit code） | revision |
|---|---|---|
| **RED**：`npx vitest run src/pages/ProductDetailPage.order-delivery-session.test.tsx src/components/SuccessModal.session.test.tsx` | **1**：2 文件失败，13 用例中 11 失败 / 2 通过（仅同会话 Token 轮换正例通过） | `e5ecd04`（未改业务代码）+ 新增合成回归测试 |
| **GREEN 定向回归**：`npx vitest run src/pages/ProductDetailPage.order-delivery-session.test.tsx src/components/SuccessModal.session.test.tsx` | **0**：2 文件，16 / 16 通过 | `fc591b44601f99f1244c91fc062c4894e144aaef`（工作区等值快照） |
| **GREEN 相关详情与交付测试**：`npx vitest run src/pages/ProductDetailPage src/components/SuccessModal.test.tsx src/components/OrderSuccessIsland.test.tsx src/components/OrderDetailModal.test.tsx src/components/DeliveryContent.test.tsx src/components/FileDeliveryCard.test.tsx src/components/StructuredDeliveryView.test.tsx src/stores/appStore.test.ts` | **0**：12 文件，123 / 123 通过 | 同上 |
| **GREEN 全量前端单测**：`npm test` | **0**：235 文件，1925 / 1925 通过 | 同上 |
| **GREEN 前端构建与类型检查**：`npm run build` | **0**：`tsc -b && vite build` 通过（built in 8.09s） | 同上 |
| **格式检查**：`git diff --check` | **0**：无空白/格式问题 | 同上 |

## 未运行 / 无法验证
- 后端集成测试（`server` 下 `npm test`）与 `npm --prefix server run build`：本次未修改任何 `server/**` 文件，未连接测试数据库。
- 真实 Axios 拦截器 / `authRefresh` Token 轮换链路：前端单测直接 mock API 模块并通过 `useAuthStore.getState().setAccessTokenForSession` 模拟同会话 Token 轮换，未在浏览器中跑真实网络刷新。
- Playwright E2E（`npm run e2e` / `npm run e2e:mobile-island`）：按 `docs/testing-policy.md` §1–§2 未新增 E2E，亦未在本地启动前后端服务跑浏览器套件。
- 架构/迁移检查（`npm run test:architecture` / `check:architecture` / `check:migrations`）与 GitHub Actions `CI OK`：未改架构边界或迁移，且未获 push / PR 授权，最终门禁待 CI 执行。

## 下一步
- 由独立 Reviewer 在只读模式下检查 `git log --oneline e5ecd04..HEAD` 与 `git diff e5ecd04..HEAD`，按 `docs/agent-workflow.md` §5 复核本修复及回归证据。
