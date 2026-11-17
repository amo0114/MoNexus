## Why

`align-route-loading-skeletons` 需要修改路由加载与商品详情加载的行为，但 `openspec/specs/` 中尚无对应能力。按 `docs/agent-workflow.md` §2，先以基线 change 记录经代码核实的**现行行为**，再由功能 change 表达变化。

## What Changes

- 新建能力 `web-route-loading`，只用 ADDED 记录现行、经核实的行为；不引入新行为。
- 刻意**不**写入：路由占位的具体视觉形态（现为标题 + 六卡片网格，属待修复缺陷，不作为需保留的需求）；商品详情页对访客/登录用户不同的占位形态（视觉细节）；商品详情非 404 请求失败时的处理（现行代码为提示后返回商城，与 `docs/specs/product-commerce-v2/spec.md` §10.2"原地重试"不一致，按规程交 Owner 决定，不写入基线）。

## Capabilities

### New Capabilities

- `web-route-loading`：前端路由模块按需加载、加载期间的占位与可访问状态，以及商品详情页数据加载期间的状态与访问控制语义。

### Modified Capabilities

（无）

## Impact

仅文档。来源：
- `src/App.tsx`（`lazy` 声明、`SessionLayout` 与顶层 `Suspense`、`requireAuth` 重定向）、`src/components/RoleGuard.tsx`、`src/components/ui/RouteFallback.tsx`
- `src/pages/ProductDetailPage.tsx`（加载 effect、`loading` / `loginRequired` 分支）
- 存量规格：`docs/specs/2026-10-25-performance-and-qq-xboard/performance-plan.md` §2.1；`docs/specs/product-commerce-v2/spec.md` §10.2（"需要登录"一行）

基线 revision：`origin/chore/agent-sdd-p0@08a8118`（业务代码与 `origin/develop@3b6f1e0` 相同）。
