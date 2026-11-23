## Why

路由模块加载时，应用外壳内所有懒加载页面共用同一个"标题 + 六卡片网格"占位，商品详情、订单、后台等非网格页面在分包到达前会短暂冒充商品列表；外壳外的公共页面只有空白。商品详情页数据加载时，访客只看到一个孤立矩形，登录用户看到的粗略分栏与真实的桌面 / 平板 / 手机布局不对应，且与路由占位形态不同，产生两次布局跳变。存量规格早已要求"fallback 使用页面对应的稳定骨架"（`performance-plan.md` §2.1）和"首次加载尺寸稳定 skeleton"（`product-commerce-v2/spec.md` §10.2），现行实现未满足。

## What Changes

- 外壳内路由占位按**页面类型**选择：商品详情、店铺（商品网格）、列表、工作台（后台/商家）、表单、通用页面；未归类路由使用中性通用占位，不再默认显示商品网格。
- 外壳外公共路由的空白占位改为轻量、中性、可访问的通用占位。
- 商品详情页：路由模块加载与商品数据加载使用同一套与真实布局对应的骨架（桌面、平板、手机分别对应），访客与登录用户一致，加载期间不显示任何商品数据。
- 新增占位可访问性要求：单一加载状态、不可聚焦、遵守减少动效偏好。

## Out of scope

- 重写其他页面内部的数据加载态（订单、榜单、通知等页面内已有骨架保持不变）。
- 路由结构、`RoleGuard` / `AdminAccessGate` / `MerchantShell` 的职责、权限判断、登录重定向、错误页与空状态。
- 后端、接口鉴权、数据库；订单、库存、支付逻辑。
- 新增依赖或动画库；固定延迟或计时器维持骨架；预加载其他路由模块。
- 商品详情非 404 请求失败时的处理（与存量规格不一致，另行决定）。
- 路由模块加载失败的错误 UI（`performance-plan.md` §2.2，另行任务）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `web-route-loading`：修改外壳内 / 外壳外路由占位与商品详情加载占位的要求，新增占位可访问性要求。依赖 `baseline-route-loading-states` 先归档。

## AGENTS.md hard constraints touched

无。不涉及金额、事务、幂等、所有权 404、锁顺序、业务时间或后台任务；访问控制语义保持不变并由需求显式约束。

## Impact

- 前端：`src/components/ui/RouteFallback.tsx`、`src/App.tsx`（仅顶层 fallback 一处）、`src/pages/ProductDetailPage.tsx`（仅 `loading` 分支）、新增商品详情骨架组件与测试。
- 首屏主包增加少量占位 JSX（目标 < 2 KB gzip），以 `npm run check:bundle-budget` 验证。
- 无接口、数据或依赖变化。
