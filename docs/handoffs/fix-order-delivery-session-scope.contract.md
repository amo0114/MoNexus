# Task Contract: fix-order-delivery-session-scope

- 来源：仓库 Owner 于 2026-11-23 下达的指令《MoNexus — P0 订单交付数据会话隔离》。
- 批准与授权边界：本次授权仅包含独立分支 `fix/order-delivery-session-scope` 与独立 worktree 上的本地修改、测试和提交；push、创建 PR、合并与部署未授权，由 Owner 另行授权。
- 参考材料：`AGENTS.md`、`docs/agent-workflow.md`、`docs/testing-policy.md`；参考 `product-detail-request-retry` Handoff（按当前 Base 代码重新核对）。

## 目标

修复 P0 安全缺陷：用户 A 在公开商品详情页兑换成功且成功弹窗仍打开时，该标签页会话失效或切换后，访客/其他用户/同账号新会话重新加载同一商品或首次渲染时仍可见或重新挂载用户 A 的订单交付弹窗、交付内容、移动端订单提示或最近订单入口。

## 范围

- 允许修改：
  - `src/auth/sessionContext.ts`（会话归属键工具）
  - `src/pages/ProductDetailPage.tsx`（购买流程、订单交付状态、成功弹窗、结算弹窗、移动端最近订单入口与岛提示的会话绑定）
  - `src/components/SuccessModal.tsx`（弹窗渲染门禁、异步交付轮询隔离与退款后同会话余额刷新解耦）
  - `src/components/DeliveryContent.tsx` 与 `src/components/FileDeliveryCard.tsx`（交付复制与文件下载授权消费前的会话复核）
  - `src/stores/appStore.ts` 与 `src/components/OrderSuccessIsland.tsx`（移动端订单提示的会话绑定与跨会话立即清除）
  - `src/hooks/useOrderRenewal.ts`、`src/components/OrderDetailModal.tsx`、`src/pages/OrdersPage.tsx` 与 `src/pages/ProfilePage.tsx`（订单详情、订单列表数据源与续费成功弹窗的会话隔离）
  - 相关前端单元测试与新增回归测试（`src/pages/ProductDetailPage.order-delivery-session.test.tsx`、`src/components/SuccessModal.session.test.tsx`、`src/pages/OrdersPage.session.test.tsx`、`src/components/SuccessModal.test.tsx`、`src/components/FileDeliveryCard.test.tsx`）
  - 本契约与交接文档（`docs/handoffs/fix-order-delivery-session-scope.contract.md`、`docs/handoffs/fix-order-delivery-session-scope.md`）
- 禁止修改：
  - 后端订单创建、扣款、幂等、库存、结算及所有权校验逻辑（`server/**`）
  - CI 工作流、部署配置、数据库迁移与无关业务模块
  - 其他 worktree 或主工作区中不属于本任务的未提交改动

## 非目标

- 不顺手合入或实现 `product-detail-request-retry` 的商品详情请求重试面板功能。
- 不改变订单创建、扣款、幂等键轮换、价格/条款保护及后端 404 所有权校验语义。
- 不新增 Playwright E2E（按 `docs/testing-policy.md` §1–§2，本缺陷在前端组件测试层即可确定性复现与验证）。

## 验收条件

1. 订单交付结果和相关弹窗只对发起兑换的登录会话可见。
2. A→访客、A→B、同账号换 `sessionId` 后，第一次 React DOM 提交就不含旧交付内容；公开商品详情重新加载成功后，旧弹窗也不会重新出现。
3. 原会话的订单响应或交付轮询迟到时，不能把旧数据写回当前界面或重新打开弹窗；桌面弹窗、移动端订单提示（`OrderSuccessIsland` / `appStore.islandNotice`）和最近订单入口（`onViewRecentOrder` /「查看本次订单」）均受会话约束。
4. 同一会话正常 Token 轮换（`setAccessTokenForSession`，同 `userId` / `sessionId` / `authEpoch`）时，合法的成功提示、交付查看和轮询继续正常工作。
5. 保持订单创建、扣款、幂等和后端所有权校验的现有语义。

## 验证要求

- 使用 Node 22 / npm 10（`v22.23.1` / `10.9.8`）。
- 先在未改动业务代码的实际 Base 上用合成数据复现并记录 RED。
- 修复后执行：定向回归测试、相关详情及交付测试、`npm test`、`npm run build`、`git diff --check`。
- 交接记录 Base、Head、命令、退出码与未验证项；完成本地提交后释放写入权，交独立 Reviewer 复审。
