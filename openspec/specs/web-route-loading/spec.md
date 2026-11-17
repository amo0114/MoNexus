# web-route-loading Specification

## Purpose
规定 MoNexus 前端在路由模块按需加载、以及商品详情数据加载期间，用户看到的占位、可访问状态和访问控制语义。

## Requirements

### Requirement: Route modules load on demand

除商城首页与登录页外，页面模块 SHALL 按路由按需加载；进入某路由前不得为它预先下载其他路由的页面模块。

#### Scenario: First visit to a split route
- **WHEN** 用户首次导航到 `/orders` 等按需加载的路由
- **THEN** 浏览器在此时才请求该路由的页面模块，模块到达后渲染页面

#### Scenario: Storefront is part of the initial bundle
- **WHEN** 用户打开 `/` 或 `/login`
- **THEN** 页面无需额外的路由模块请求即可渲染

### Requirement: In-shell placeholder while a route module loads

对渲染在应用外壳内的路由，页面模块加载期间，页头、导航与页脚 SHALL 保持挂载，内容区 SHALL 显示一个可访问名称为"正在加载页面"的加载状态。该占位的结构 SHALL 与目标路由的页面类型相符（商品详情、商品网格、列表、工作台、表单、通用页面）；只有以商品网格为主体的页面可以显示卡片网格占位，未归类的路由 SHALL 使用不冒充任何具体页面的中性占位。占位 SHALL 在模块到达后立即被页面替换，不得人为延长。

#### Scenario: Navigating to an unloaded in-shell route
- **WHEN** 已登录用户首次进入 `/notifications`，模块尚未到达
- **THEN** 页头与导航保持可见，内容区存在一个 `role="status"`、名称为"正在加载页面"的元素，模块到达后被页面替换

#### Scenario: Product detail route does not look like a product grid
- **WHEN** 用户首次进入 `/product/42`，商品详情模块尚未到达
- **THEN** 内容区显示与商品详情布局对应的占位，不出现商品卡片网格

#### Scenario: Non-grid routes match their page type
- **WHEN** 用户首次进入 `/orders`、`/leaderboard`、`/notifications`、`/profile`、`/recharge`、`/admin`、`/merchant/dashboard` 或 `/merchant/products/new` 之一，模块尚未到达
- **THEN** 占位分别呈现列表、通用页面、工作台或表单结构，均不出现商品卡片网格

#### Scenario: Shop page keeps a grid placeholder
- **WHEN** 用户首次进入 `/shops/7`，模块尚未到达
- **THEN** 占位呈现店铺头部与商品网格结构

#### Scenario: Unclassified route
- **WHEN** 外壳内出现未归类的新路由，其模块尚未到达
- **THEN** 显示中性通用占位，不出现商品卡片网格

#### Scenario: Module already loaded
- **WHEN** 用户再次进入已加载过模块的路由
- **THEN** 页面直接渲染，不出现路由占位

### Requirement: Standalone route placeholder while a route module loads

对渲染在应用外壳之外的公共路由（找回/重置密码、邮箱验证、邀请跳转、恢复设置、法律页面），模块加载期间 SHALL 显示一个可访问名称为"正在加载页面"、至少占满视口高度的加载状态。该状态 SHALL 含有轻量、中性的可见占位，而不是纯空白，且不得冒充商品列表或任何具体页面的数据。

#### Scenario: Opening a legal page cold
- **WHEN** 访客直接打开 `/terms`，模块尚未到达
- **THEN** 页面上存在 `role="status"`、名称为"正在加载页面"的元素，内含可见的中性占位，模块到达后被页面替换

### Requirement: Access checks precede protected route loading

需要登录的路由 SHALL 在加载页面模块之前完成登录与角色判断；未通过判断时不得请求该页面模块，也不得显示该页面的加载占位。

#### Scenario: Guest opens a protected route
- **WHEN** 未登录访客打开 `/orders`
- **THEN** 被重定向到 `/login`，不请求订单页模块

#### Scenario: Non-admin opens the admin console
- **WHEN** 普通用户打开 `/admin`
- **THEN** 显示"访问被拒绝"，不请求后台页面模块

### Requirement: Product detail shows no product data while loading

商品详情页在商品数据请求完成之前 SHALL 显示加载状态，且不得展示任何商品名称、价格、图片、徽标或套餐信息。该加载状态 SHALL 与商品详情路由占位呈现相同结构，并对应当前视口下真实页面的布局；访客与登录用户 SHALL 看到相同的加载结构。

#### Scenario: Product request in flight
- **WHEN** 用户打开 `/product/42`，`GET /products/42` 尚未返回
- **THEN** 页面显示加载状态，不存在任何商品内容

#### Scenario: Navigating between products
- **WHEN** 用户在商品 A 的详情页点击相关商品 B
- **THEN** B 的数据返回前，页面显示加载状态而不是 A 的内容

#### Scenario: Guest and signed-in users see the same loading structure
- **WHEN** 访客与登录用户分别打开同一公开商品，接口尚未返回
- **THEN** 两者看到相同的加载结构，访客看到的不是单个孤立矩形

#### Scenario: Desktop loading layout
- **WHEN** 视口宽度不小于 1024px，商品数据加载中
- **THEN** 加载状态呈现面包屑与标题区、左侧图片画廊与详情区、右侧商品摘要 / 价格 / 套餐与购买操作区

#### Scenario: Mobile loading layout
- **WHEN** 视口宽度小于 768px，商品数据加载中
- **THEN** 加载状态呈现顶部通栏大图，下方依次为商品信息、价格、套餐与操作区

#### Scenario: Route and data loading are continuous
- **WHEN** 用户冷启动打开 `/product/42`，先等待模块、再等待商品数据
- **THEN** 两个阶段之间加载结构不发生明显的布局跳变

#### Scenario: Loading ends in a login prompt
- **WHEN** 访客的加载状态结束于 404
- **THEN** 按"Guest not-found becomes a login prompt"显示登录提示页，加载期间与之后都不显示商品片段

### Requirement: Guest not-found becomes a login prompt

访客请求商品详情得到"不存在"响应时，加载结束后 SHALL 显示通用的"登录后查看商品"页，提供保留回跳地址的登录入口，且不显示任何商品片段（"仅限登录可见"与"不存在"对访客不可区分）。

#### Scenario: Guest opens a members-only product
- **WHEN** 访客打开会员可见商品的详情页，接口返回 404
- **THEN** 显示"登录后查看商品"与"去登录"按钮，点击后跳转 `/login?returnTo=<当前商品路径>`

### Requirement: Loading placeholders are accessible and inert

每个加载占位 SHALL 只暴露一个加载状态（`role="status"` 加可访问名称），其中的骨架形状对辅助技术隐藏、不可交互、不可获得焦点；占位不得因内部更新而重复播报；当用户偏好减少动效时，占位 SHALL 不持续播放动画。

#### Scenario: Screen reader during route loading
- **WHEN** 读屏用户进入一个尚未加载的路由
- **THEN** 只读出一次"正在加载页面"，骨架形状不被逐个读出

#### Scenario: Keyboard focus during loading
- **WHEN** 键盘用户在占位显示期间按 Tab
- **THEN** 焦点不会落在任何骨架元素上

#### Scenario: Reduced motion
- **WHEN** 系统设置为减少动效，占位显示中
- **THEN** 骨架不持续闪烁或扫光

#### Scenario: No horizontal overflow
- **WHEN** 在 390px、768px、1280px 宽度显示任一占位
- **THEN** 页面不出现横向滚动
