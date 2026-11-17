## Context

基线：`origin/chore/agent-sdd-p0@08a8118`（前端代码与 `origin/develop@3b6f1e0` 相同）。两个加载阶段：

1. **路由模块加载**：`src/App.tsx` 有两层 `Suspense`。外壳内路由经 `SessionLayout`（位于 `Layout` 内）使用 `<RouteFallback />`（`src/components/ui/RouteFallback.tsx`：标题 + `sm:2 / lg:3` 列六卡片）；外壳外公共路由使用顶层 `<div role="status" aria-label="正在加载页面" className="min-h-screen" />`（纯空白）。`StorePage`、`LoginPage` 为直接导入，不经过占位。
2. **商品数据加载**：`ProductDetailPage` 的 `loading` 初值为 `true`，每次 `id` 变化先 `setProduct(null)`、`setLoading(true)`。`loading` 分支自带 `max-w-6xl px-4 lg:px-8` 容器：访客为单个 `h-40` 矩形，登录用户为两行标题条 + `lg:flex-row` 左图右栏。真实页面按视口渲染三种布局：`≥1024` `ProductDetailDesktop`（面包屑行 + `minmax(0,1.45fr) minmax(0,1fr)` 双栏：左画廊与详情页签，右购买面板）、`768–1023` `ProductDetailTablet`（标题区 + 纵向堆叠）、`<768` `ProductDetailMobile`（通栏大图 515/444、下方概览 / 价格 / 套餐 / 页签，固定底部购买条）。`Layout` 对 `/product/:id` 使用 `px-0 md:px-6` 与 `product-layout`。

根因：占位只有一种网格形态且由 `SessionLayout` 统一提供；商品详情两阶段各自实现、互不一致，访客分支被简化为矩形（引入于 #212，提交说明未给出理由，代码中无相关注释）。

## Route loading matrix

| 路由 | 页面实际结构 | 现 Suspense 占位 | 页面内已有骨架 | 拟用占位 | 本次 |
|---|---|---|---|---|---|
| `/` | 商品网格（直接导入） | 不经过 | 有 | — | 否 |
| `/login` | 认证卡片（直接导入） | 不经过 | — | — | 否 |
| `/product/:id` | 详情：桌面双栏 / 平板堆叠 / 手机通栏大图 | 六卡片 | 有（不一致） | `product` | 是 |
| `/shops/:merchantId` | 店铺头 + 商品网格 | 六卡片 | `GridSkeleton` | `storefront` | 是 |
| `/orders` | 标题 + 筛选 + 行列表 | 六卡片 | `TableSkeleton` | `list` | 是 |
| `/notifications` | 标题 + 行列表 | 六卡片 | 行骨架 | `list` | 是 |
| `/leaderboard` | 领奖台 + 排名列表 | 六卡片 | `LeaderboardSkeleton` | `list` | 是 |
| `/profile` | 头像信息头 + 多个面板 | 六卡片 | 无 | `page` | 是 |
| `/recharge` | `max-w-3xl` 单列 | 六卡片 | 无（子组件有） | `form` | 是 |
| `/admin` | 侧栏页签 + 面板（`xl:flex-row`） | 六卡片 | 各面板有 | `workspace` | 是 |
| `/admin/products/new`、`/admin/products/:id/edit` | `max-w-3xl` 表单 | 六卡片 | 编辑页有文字加载 | `form` | 是 |
| `/merchant/apply` | `max-w-3xl` 表单 / 状态 | 六卡片 | 无 | `form` | 是 |
| `/merchant/products/new`、`/merchant/products/:id/edit` | 向导 / 表单 | 六卡片 | 文字加载 | `form` | 是 |
| `/merchant/dashboard`、`/merchant/workbench`、`/merchant/promotions` | `MerchantShell` + 面板 | 六卡片（外壳一起被替换） | 部分 | `workspace` | 是 |
| `/merchant/*` 其他 | `MerchantDashboardPage`：侧栏 + 面板 | 六卡片 | 有 | `workspace` | 是 |
| 未来未归类路由 | — | 六卡片 | — | `page` | 是 |
| `/forgot-password`、`/reset-password/:token`、`/verify-email`、`/restore-setup`、`/i/:code`、`/terms` 等法律页 | 外壳外独立页 | 纯空白 | — | 独立通用占位 | 是 |

说明：`RoleGuard` 与 `requireAuth` 在子页面渲染前完成判断，未通过时不会挂起，因此不会对无权限用户显示工作台占位，也不会请求页面模块。

## Goals / Non-Goals

**Goals：** 占位类型与页面类型对应；商品详情两阶段共用同一骨架并按视口对应真实布局；访客与登录一致；可访问；主包增量极小。

**Non-Goals：** 见 proposal "Out of scope"。不复用各页面 chunk 内的骨架（会把页面模块拉进主包或提前下载）。

## Decisions

1. **按路径选择占位类型，集中在一个纯函数中。** `routeFallbackKind(pathname)` 返回 `product | storefront | list | workspace | form | page`，`RouteFallback` 通过 `useLocation()` 取当前路径（`SessionLayout` 在 `BrowserRouter` 内，嵌套 `/*` 路由也能取到真实路径）。备选：每个 `<Route>` 各包一层 `Suspense` 并传 fallback——会改动全部路由声明且重复 JSX，否决。默认值为 `page`，新路由不归类也不会冒充网格。
2. **一个文件提供类型骨架。** `RouteFallback.tsx` 内为每种类型写一个小组件（只用现有 `Skeleton` 原语），对外只有一个 `role="status"`。不嵌套 `TableSkeleton` / `StatCardSkeleton`，因为它们各自带 `role="status"`，会重复播报。
3. **商品详情骨架独立成组件** `src/components/catalog/ProductDetailSkeleton.tsx`，由 `RouteFallback`（`product` 类型）与 `ProductDetailPage` 的 `loading` 分支共同使用，保证两阶段结构相同。只用 Tailwind 断点（`md` / `lg`），不依赖 `useMediaQuery`，也不依赖只在详情页 chunk 中加载的 `ProductDetail*.css`，因此可放进主包且首帧即为正确布局。桌面列宽对齐 `minmax(0,1.45fr) minmax(0,1fr)`；桌面与手机画廊沿用真实页面的 `515/444`（手机通栏），平板沿用真实画廊卡片高度（内框上限 400px，含边框约 434px）；底部购买条在骨架中以文档流内的价格 / 按钮块表示，不使用 `fixed`（避免与路由切换时的外壳元素叠放）。
4. **`ProductDetailPage` 只改 `loading` 分支**：去掉访客 / 登录二分与自带 `max-w-6xl` 容器，直接返回 `<ProductDetailSkeleton />`，保留 `data-testid="product-detail-loading"`。`loginRequired`、错误处理、请求与鉴权逻辑不动。
5. **外壳外公共路由**：顶层 `Suspense` 改用同文件导出的 `StandaloneRouteFallback`（`min-h-screen` 内居中的几条中性线条），不做页面专属形态。
6. **可访问性与动效**：骨架原语已是 `aria-hidden`；容器仅一个 `role="status"` + `aria-label`；不含可聚焦元素；减少动效由 `src/styles/50-island-reveal.css` 的全局 `prefers-reduced-motion` 规则（动画时长 0.01ms、仅 1 次）覆盖，不新增 CSS。
7. **不引入计时器、不预加载模块、不新增依赖。**

## Risks / Trade-offs

- [访客骨架看起来像商品，随后可能变为"登录后查看商品"] → 骨架不含任何数据，对所有商品 ID 相同，不泄露存在性；规格要求访客与登录一致。若 Owner 认为访客应保持非商品形态，需在批准时说明。
- [`MerchantShell` 在模块加载期间仍会被整体替换（现状如此）] → 用 `workspace` 骨架近似外壳形态；把 `Suspense` 下移到外壳内会改变路由组织，不在本次范围。
- [按路径匹配与路由声明分离，可能漂移] → 默认 `page` 兜底；单测覆盖矩阵中全部路由。
- [主包体积增加] → 目标 < 2 KB gzip，以 `check:bundle-budget` 及构建产物对比确认。
- [移动端底部固定购买条在骨架中不固定，数据到达时出现购买条] → 属于真实页面挂载行为，非骨架跳变；骨架为其保留底部空间。

## Verification plan

- 单测：`routeFallbackKind` 覆盖矩阵全部路由及未知路径；`RouteFallback` 在 `/product/1`、`/orders` 下不出现网格、只有一个 `status`、无可聚焦元素；`ProductDetailPage` 在请求挂起时访客与登录均渲染同一骨架且无商品名称。
- 浏览器（Playwright，一次性脚本，不新增提交的 E2E 套件）：stub API，分别延迟商品详情 JS 分包与 `GET /api/products/:id`，在 390 / 768 / 1280 宽度截图并断言 `scrollWidth <= innerWidth`。
- 命令：`npm test`（根目录前端单测）、`npm run build`、`npm run check:bundle-budget`；`openspec validate --strict`。
