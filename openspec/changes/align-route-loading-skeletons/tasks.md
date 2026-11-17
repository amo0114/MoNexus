## 0. Gate

- [x] 0.1 Owner 批准 `baseline-route-loading-states` 与本 change 的规格和设计（2026-11-17；含：访客与登录用户加载态一致，浏览器检查用一次性脚本、不提交 E2E）
- [x] 0.2 `openspec archive baseline-route-loading-states`（生成主规格后本 change 的 MODIFIED 才能归档）

## 1. Route fallback selection

- [x] 1.1 新增 `routeFallbackKind(pathname)`，按 design 矩阵映射，默认 `page`
- [x] 1.2 `RouteFallback` 读取当前路径并渲染对应类型骨架（`storefront` / `list` / `workspace` / `form` / `page`），保持单一 `role="status"`
- [x] 1.3 `App.tsx` 顶层 `Suspense` 改用 `StandaloneRouteFallback`

## 2. Product detail skeleton

- [x] 2.1 新增 `ProductDetailSkeleton`：桌面（面包屑行 + 双栏：画廊 / 详情 | 摘要 / 价格 / 套餐 / 操作）
- [x] 2.2 平板与手机结构（手机通栏大图 + 下方信息、价格、套餐、操作区）
- [x] 2.3 `RouteFallback` 的 `product` 类型与 `ProductDetailPage` 的 `loading` 分支共用该组件；去掉访客 / 登录二分，保留 `data-testid="product-detail-loading"`

## 3. Tests

- [x] 3.1 `routeFallbackKind` 与 `RouteFallback` 单测（矩阵、无网格、单一 status、无可聚焦元素）
- [x] 3.2 `ProductDetailPage` 加载态单测（访客 / 登录一致、无商品数据）

## 4. Verification

- [x] 4.1 `npm test`
- [x] 4.2 `npm run build` 与 `npm run check:bundle-budget`，记录主包增量
- [x] 4.3 Playwright 一次性检查：慢分包、慢商品 API；390 / 768 / 1280 截图与横向溢出断言；减少动效
- [x] 4.4 `openspec validate align-route-loading-skeletons --strict`
- [ ] 4.5 更新 `handoff.md`，提交固定快照，交独立审查
