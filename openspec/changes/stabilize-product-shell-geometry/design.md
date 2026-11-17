## Context

基线：`origin/develop@80a9e3b`。

- `src/components/Layout.tsx` 在路径匹配 `/^\/product\/[^/]+\/?$/` 时给根元素加 `product-layout`，并给 `main` 设 `max-w-7xl px-0 md:px-6 pt-0 md:pt-4`。页头 `.navbar-shell`（`Layout`）、提示横幅（`AnnouncementBanner`、`EmailVerificationBanner`）与页脚内层（`Layout`）都带 `.chrome-bound` 和自身的 `max-w-7xl` / 内边距。页头另有 `transition-[max-width,…] duration-200`。这些都在主包中，首帧即生效。
- 详情页分包 CSS（`ProductDetailPage-*.css`，由 `ProductDetailDesktop.css` 引入）中的外壳规则，按当前层叠顺序：

  | 原位置 | 媒体查询 | 选择器 | 声明 |
  |---|---|---|---|
  | `desktop-layout.css` | ≥1024 | `.product-layout > main` | `max-width:2064px; padding:0 32px 48px` |
  | `desktop-layout.css` | ≥1024 | `.product-layout .chrome-bound` | `max-width:2064px; padding-inline:32px` |
  | `desktop-layout.css` | ≥1024 | `.product-layout .navbar-shell.chrome-bound` | `max-width:2016px; padding-inline:8px` |
  | `desktop-layout.css` | ≥1024 | `.product-layout.bg-grid-pattern` | `background-color:var(--color-background)` |
  | `desktop-content.css` | ≥1024 | `.dark .product-layout.bg-grid-pattern`、`[data-theme='dark'] .product-layout.bg-grid-pattern` | `background-image:none` |
  | `desktop-bp-mid.css` | 1024–1279 | `.product-layout > main`、`.product-layout .chrome-bound` | `padding-inline:24px` |
  | `desktop-bp-mid.css` | 1024–1279 | `.product-layout .navbar-shell.chrome-bound` | `padding-inline:0` |

  两条背景规则当前不会命中：`Layout` 根元素的类是 `md:bg-grid-pattern`，不是 `bg-grid-pattern`。它们不是本问题的成因，本次只原样迁移、不修正。
- Vite 6.4.2 预加载辅助对 CSS 依赖等待 `load` 事件后才执行动态导入的模块（`node_modules/vite/dist/node/chunks/dep-*.js` 中 `vite:preloadError` 附近的 `isCss` 分支）；路由占位在此之前已绘制。因此若占位帧在详情 CSS 到达前绘制——冷缓存下可以发生，但加载机制不保证每次都发生——CSS 到达时外壳在占位阶段移动，此后页面渲染与数据到达不再移动。
- 构建产物核对：`80a9e3b` 的 CSS 分包中，只有 `ProductDetailPage-*.css` 含 `.product-layout` / `.chrome-bound` / `> main` 等外壳选择器（其中两处 `body{` 实为 `.pd-detail-body`）。未对其他页面做浏览器排查。

实测（`evidence/shell-check.mjs`，结果 `evidence/results-80a9e3b-before.json`；t0 = 占位首帧且详情 CSS 未生效，t1 = CSS 已生效、JS 被拦截，t2 = 页面模块已渲染、商品接口被拦截，t3 = 商品渲染后；访客与"邮箱未验证的登录用户"两种固定状态）：

| 视口 | t0 → t3 外壳变化 |
|---|---|
| 390、767、768、1023 | 不变 |
| 1024、1279 | 页头左右内边距 24 → 0；内容区顶部上移 16px（访客 85 → 69，登录 161 → 145），内边距 `16/24/32/24 → 0/24/48/24` |
| 1280 | 页头内边距 24 → 8；内容区 x 24 → 32、宽 1232 → 1216、顶部上移 16px；页脚内边距 24 → 32；横幅内边距 24 → 32 |
| 1920×1000 | 页头 x 320 → 24、宽 1280 → 1872；内容区 x 344 → 32、宽 1232 → 1856；页脚与横幅 x 320 → 0、宽 1280 → 1920；内边距同 1280 |

- 所有视口 t2 = t3（数据阶段不移动）；1024–1280 的 t1 = t3。1920 的 t1 ≠ t3：页头宽度在过渡动画中途（x 68、宽 1785），说明宽屏下的跳变以 200ms 动画呈现。
- 登录用户从商品详情应用内导航到 `/orders` 后，外壳与直接打开 `/orders` 一致（8 个视口）。

## Goals / Non-Goals

**Goals：** 外部状态不变时，商品详情路由加载各阶段的外壳水平几何与内容起始顶部一致，最终几何不变。

**Non-Goals：** 见 proposal "Out of scope"。不约束随内容高度变化的纵向位置。

## Decisions

1. **把上表 7 组规则原样移入主包样式。** 新增 `src/styles/85-product-shell.css`，在 `src/index.css` 中 `80-themes.css` 之后引入。
   - 保持当前相对顺序 `desktop-layout` → `desktop-content` → `desktop-bp-mid`：1024–1279 的内边距覆盖必须排在 ≥1024 基础规则之后。
   - 使用普通 CSS 规则，不放进 `@layer`，媒体查询、选择器与声明逐字保留。
   - 只删除这些规则；原文件中同一媒体查询里的其他 `.pd-*` 等规则保留。共享的 `.chrome-bound` 仍服务页头、横幅和页脚，不迁移 `.pd-*`、全局网格或移动端导航样式。
   - 层叠核查（针对本组规则，不作普遍结论）：迁移后与它们竞争同一属性的，只有 `Layout`、横幅组件上的单类 Tailwind 工具类（如 `max-w-7xl`、`md:px-6`、`md:pt-4`，优先级 0,1,0）；本组规则优先级为 0,1,1（`> main`）、0,2,0（`.chrome-bound`）、0,3,0（页头与背景），不论样式表先后都胜出，因此在主包中的位置不改变计算值。实施时以计算样式对比验证（见 Verification plan）。
   - 备选 A：在 3 个组件的 4 处外壳元素上按 `isProductDetailPage` 切换 Tailwind 类——分散断点规则，无明显收益，否决。
   - 备选 B：`<link rel="preload">` 不能保证应用时机；内联关键 CSS 可以消除竞态，但需要处理组织、去重或构建，成本更高，否决。
2. **不改 `.product-layout` 的添加条件**（大小写问题）与背景选择器，均另行记录。
3. **验收以 `evidence/shell-check.mjs` 为准**（见下）。

## Risks / Trade-offs

- [主包 CSS 变大] → 约 20 行规则；记录 `index-*.css` 的 gzip 变化。
- [其他页面误受影响] → 规则都以 `.product-layout` 为前缀，只有商品详情路由带该类；脚本检查离开详情页后的 `/orders` 外壳。
- [日后有人在详情页 CSS 里再写外壳规则] → 新文件头部注释说明原因；本次不加自动检查。
- [证据为 stub 数据、单图商品] → 外壳几何与商品内容无关；纵向随内容的变化已明确排除。

## Verification plan

`evidence/shell-check.mjs` 的硬检查（任一失败即 exit 1）：
- 每个被拦截资源（详情 CSS、详情 JS、商品接口）恰好请求一次；详情 CSS 确认已生效；页头、`main`、页脚节点存在；登录状态在 ≥768px 时横幅存在。
- 每个视口、两种状态下 t0 = t1 = t2 = t3（页头 / 横幅 / 页脚的 x、宽、四向内边距；内容区 x、顶部、宽、四向内边距）。
- `--baseline evidence/results-80a9e3b-before.json`：t3 与基线 t3 逐项相同（最终几何不变）。
- 登录状态：应用内导航到 `/orders` 后的外壳与直接打开 `/orders` 相同。

实施后要求 exit 0。基线运行预期 exit 1，失败项即上表中的移动（≥1024 的 t0 ≠ t3、1920 的 t1 ≠ t3）。

其他验证：复跑 `openspec/changes/archive/2026-11-17-align-route-loading-skeletons/evidence/loading-check.mjs`；在深色与浅色主题下比对 ≥1024 时 `main`、页头、横幅、页脚的计算样式与基线相同；`npm test`、`npm run build`；记录主包 CSS gzip 变化。不新增单元测试或 E2E：该行为只能按真实浏览器中的资源到达顺序复现，证据脚本作为 change 附件保存。
