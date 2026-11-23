## Purpose

规定 MoNexus 前端在路由模块按需加载、以及商品详情数据加载期间，用户看到的占位、可访问状态和访问控制语义。

## ADDED Requirements

### Requirement: Route modules load on demand

除商城首页与登录页外，页面模块 SHALL 按路由按需加载；进入某路由前不得为它预先下载其他路由的页面模块。

#### Scenario: First visit to a split route
- **WHEN** 用户首次导航到 `/orders` 等按需加载的路由
- **THEN** 浏览器在此时才请求该路由的页面模块，模块到达后渲染页面

#### Scenario: Storefront is part of the initial bundle
- **WHEN** 用户打开 `/` 或 `/login`
- **THEN** 页面无需额外的路由模块请求即可渲染

### Requirement: In-shell placeholder while a route module loads

对渲染在应用外壳内的路由（`/`、`/product/:id`、`/shops/:merchantId` 及需要登录的路由），页面模块加载期间，页头、导航与页脚 SHALL 保持挂载，内容区 SHALL 显示一个可访问名称为"正在加载页面"的加载状态。

#### Scenario: Navigating to an unloaded in-shell route
- **WHEN** 已登录用户首次进入 `/notifications`，模块尚未到达
- **THEN** 页头与导航保持可见，内容区存在一个 `role="status"`、名称为"正在加载页面"的元素，模块到达后被页面替换

### Requirement: Standalone route placeholder while a route module loads

对渲染在应用外壳之外的公共路由（找回/重置密码、邮箱验证、邀请跳转、恢复设置、法律页面），模块加载期间 SHALL 显示一个可访问名称为"正在加载页面"、至少占满视口高度的加载状态。

#### Scenario: Opening a legal page cold
- **WHEN** 访客直接打开 `/terms`，模块尚未到达
- **THEN** 页面上存在 `role="status"`、名称为"正在加载页面"的元素，模块到达后被页面替换

### Requirement: Access checks precede protected route loading

需要登录的路由 SHALL 在加载页面模块之前完成登录与角色判断；未通过判断时不得请求该页面模块，也不得显示该页面的加载占位。

#### Scenario: Guest opens a protected route
- **WHEN** 未登录访客打开 `/orders`
- **THEN** 被重定向到 `/login`，不请求订单页模块

#### Scenario: Non-admin opens the admin console
- **WHEN** 普通用户打开 `/admin`
- **THEN** 显示"访问被拒绝"，不请求后台页面模块

### Requirement: Product detail shows no product data while loading

商品详情页在商品数据请求完成之前 SHALL 显示加载状态，且不得展示任何商品名称、价格、图片、徽标或套餐信息。

#### Scenario: Product request in flight
- **WHEN** 用户打开 `/product/42`，`GET /products/42` 尚未返回
- **THEN** 页面显示加载状态，不存在任何商品内容

#### Scenario: Navigating between products
- **WHEN** 用户在商品 A 的详情页点击相关商品 B
- **THEN** B 的数据返回前，页面显示加载状态而不是 A 的内容

### Requirement: Guest not-found becomes a login prompt

访客请求商品详情得到"不存在"响应时，加载结束后 SHALL 显示通用的"登录后查看商品"页，提供保留回跳地址的登录入口，且不显示任何商品片段（"仅限登录可见"与"不存在"对访客不可区分）。

#### Scenario: Guest opens a members-only product
- **WHEN** 访客打开会员可见商品的详情页，接口返回 404
- **THEN** 显示"登录后查看商品"与"去登录"按钮，点击后跳转 `/login?returnTo=<当前商品路径>`
