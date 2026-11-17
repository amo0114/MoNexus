## Context

基线：`origin/develop@80a9e3b`。

- `src/components/Layout.tsx` 在路径匹配 `/^\/product\/[^/]+\/?$/` 时给根元素加 `product-layout`，并给 `main` 设 `max-w-7xl px-0 md:px-6 pt-0 md:pt-4`；页头 `.navbar-shell`、提示横幅、页脚内层均带 `.chrome-bound` 且自带 `max-w-7xl`。这些都在主包中，首帧即生效。
- 详情页分包 CSS（`ProductDetailPage-*.css`，由 `ProductDetailDesktop.css` 引入）中有以下**外壳**规则：
  - `desktop-layout.css`（`@media (min-width:1024px)`）：`.product-layout > main { max-width:2064px; padding:0 32px 48px }`、`.product-layout .chrome-bound { max-width:2064px; padding-inline:32px }`、`.product-layout .navbar-shell.chrome-bound { max-width:2016px; padding-inline:8px }`、`.product-layout.bg-grid-pattern { background-color: var(--color-background) }`
  - `desktop-bp-mid.css`（1024–1279px）：`.product-layout > main, .product-layout .chrome-bound { padding-inline:24px }`、`.product-layout .navbar-shell.chrome-bound { padding-inline:0 }`
  - `desktop-content.css`（≥1024px，深色主题）：`.dark .product-layout.bg-grid-pattern, [data-theme='dark'] .product-layout.bg-grid-pattern { background-image:none }`
- Vite 6.4.2 预加载辅助对 CSS 依赖等待 `load` 事件后才执行动态导入的模块（`node_modules/vite/dist/node/chunks/dep-*.js` 中 `vite:preloadError` 附近的 `isCss` 分支）。因此冷启动时占位首帧必然缺少上述规则，CSS 到达时外壳移动，之后页面渲染不再移动。

实测（`evidence/shell-check.mjs`，结果 `evidence/results-80a9e3b-before.json`；t0 = 占位首帧，t1 = CSS 已生效但模块仍被拦截，t2 = 页面渲染后）：

| 视口 | 页头 x / 宽 | main 内容框 x, y / 宽 | 页脚 x / 宽 |
|---|---|---|---|
| 390、768 | 不变 | 不变 | 不变 |
| 1024、1279 | 不变 | y 85 → 69 | 不变 |
| 1280 | 不变 | x 24 → 32，y 85 → 69，宽 1232 → 1216 | 不变 |
| 1920×1000 | x 320 → 24，宽 1280 → 1872 | x 344 → 32，y 85 → 69，宽 1232 → 1856 | x 320 → 0，宽 1280 → 1920 |

所有视口 t1 = t2：移动只发生在 CSS 到达时。

构建产物核对：`origin/develop@80a9e3b` 的 CSS 分包中，只有 `ProductDetailPage-*.css` 含 `.product-layout` / `.chrome-bound` / `> main` 等外壳选择器（其中两处 `body{` 实为 `.pd-detail-body`），其他页面分包未修改外壳。

## Goals / Non-Goals

**Goals：** 外壳几何在商品详情路由的加载各阶段一致，最终尺寸不变。

**Non-Goals：** 见 proposal "Out of scope"。

## Decisions

1. **把外壳规则原样移入主包样式。** 新增 `src/styles/85-product-shell.css`，在 `src/index.css` 中按现有编号顺序引入（放在 `80-themes.css` 之后），内容为上述 7 组规则，媒体查询与选择器逐字保留；从三个详情页 CSS 文件中删除这些规则。
   - 层叠安全：这些选择器的优先级（`.product-layout > main` 为 0,1,1；`.product-layout .chrome-bound` 为 0,2,0；带 `.navbar-shell` 的为 0,3,0）都高于 `Layout` 上的单类 Tailwind 工具类（0,1,0），因此与样式表先后顺序无关，移动位置不改变计算结果；1024–1279 的覆盖规则与 ≥1024 规则一起移动，二者相对顺序保持。深色背景规则（0,3,0）同理。
   - 备选 A：把外壳尺寸改写为 `Layout` 等组件上按 `isProductDetailPage` 切换的 Tailwind 类——要改 3 个组件中的 4 处外壳元素（`Layout` 的页头与页脚、`AnnouncementBanner`、`EmailVerificationBanner`），且重复表达同一套断点，否决。
   - 备选 B：保留在分包中，通过 `<link rel="preload">` 或内联关键 CSS 提前加载——仍有竞态，且需要改构建或 HTML，否决。
2. **不改 `.product-layout` 的添加条件。** 区分大小写的问题只记录，不修。
3. **验证沿用 `evidence/shell-check.mjs`**：同一脚本在变更前后各跑一次；变更后要求所有视口 t0 = t1 = t2，且 t2 与变更前的 t2 相同（最终尺寸不变）。

## Risks / Trade-offs

- [主包 CSS 变大] → 约 20 行规则，gzip 后几百字节；用构建产物记录 `index-*.css` 大小变化。
- [其他页面误受影响] → 所有规则都以 `.product-layout` 为前缀，只有 `Layout` 在商品详情路由上加该类；验证包含从详情页导航到 `/orders` 的场景。
- [日后有人在详情页 CSS 里再写外壳规则] → 在新文件头部注释说明原因；本次不加自动检查。
- [证据只覆盖访客、单图 fixture] → 外壳几何与商品内容无关，足以覆盖本变更。

## Verification plan

- 前后对比：`node openspec/changes/stabilize-product-shell-geometry/evidence/shell-check.mjs`（变更前结果已入库）。
- 回归：`openspec/changes/archive/2026-11-17-align-route-loading-skeletons/evidence/loading-check.mjs`，确认骨架两阶段及与真实页面的对齐不变。
- `npm test`、`npm run build`；记录主包 CSS gzip 变化。
- 无新增单元测试：行为只能在真实浏览器中按资源到达顺序复现；按 `docs/testing-policy.md` 不新增 E2E，证据脚本作为 change 附件保存。
