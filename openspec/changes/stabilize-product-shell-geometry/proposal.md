## Why

商品详情页在桌面宽度（≥1024px）会改变应用外壳：`main` 去掉上内边距、≥1280px 时加宽内边距，≥1920px 时页头、内容区与页脚放宽到约 2064px，并改用纯色背景。这些规则写在详情页分包的 CSS 里（`src/components/catalog/product-detail/desktop-layout.css`、`desktop-bp-mid.css`、`desktop-content.css`），而 `.product-layout` 类由主包中的 `Layout` 在首帧就加上。Vite 的动态导入要等该 CSS 加载完成才执行页面模块，所以冷启动时路由占位的首帧一定没有这些规则，CSS 一到外壳就整体移动。#360 的 R1 复审（场景 B）首先发现这一问题，本提案对 `origin/develop@80a9e3b` 实测确认：跳变发生在 CSS 到达的时刻、页面仍处于占位阶段，与 JS 何时到达无关（`evidence/results-80a9e3b-before.json`）。

## What Changes

- 把只作用于 `.product-layout` 外壳的样式规则（main 宽度与内边距、`.chrome-bound` 页头/横幅/页脚宽度、页头内边距、桌面背景及其深色主题覆盖）从详情页分包 CSS 移到主包样式中，选择器与取值不变。
- 详情页分包 CSS 只保留页面内部（`.pd-*`）规则。
- 在 `web-route-loading` 能力中新增"商品详情外壳几何从首帧起即为最终值"的要求。

## Out of scope

- 不改变外壳在任何宽度下的最终尺寸、颜色或断点；不改 `Layout` 组件逻辑或 `.product-layout` 的添加条件。
- `Layout` 判断商品详情页使用区分大小写的正则（`/PRODUCT/42` 能渲染详情却不加 `.product-layout`）——既有问题，另行记录，不在本次修改。
- 不改骨架组件、路由占位选择、页面内部样式、懒加载分包或 Vite 配置；不引入关键 CSS 内联、预加载提示或新依赖。
- 不处理其他页面是否存在同类问题（本次调查只发现商品详情页在分包 CSS 中修改外壳）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `web-route-loading`：新增商品详情外壳几何稳定的要求（ADDED）。

## AGENTS.md hard constraints touched

无。仅前端样式位置调整；不涉及金额、事务、幂等、所有权、锁、业务时间或后台任务。

## Impact

- 前端样式：新增或扩展一个主包样式文件（由 `src/index.css` 引入），从三个详情页 CSS 文件中删去对应规则。主包 CSS 预计增加不到 1 KB（gzip 前）。
- 无 TypeScript 逻辑、接口、数据或依赖变化。
