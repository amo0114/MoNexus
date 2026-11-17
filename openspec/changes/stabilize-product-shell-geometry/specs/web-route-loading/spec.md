## ADDED Requirements

### Requirement: Product route shell geometry is final from the first loading frame

在商品详情路由上，外部状态（视口、登录状态、横幅显示状态）不变时，应用外壳的水平几何 SHALL 从路由占位的第一帧起等于页面加载完成后的值：页头、提示横幅与页脚的左右边缘、宽度和内边距，以及内容区容器的左右边缘、宽度、内边距和内容起始顶部。页面样式、页面模块或商品数据的到达 SHALL NOT 改变这些值。页脚等随内容高度移动的纵向位置不在此约束内。离开商品详情路由后，外壳 SHALL 使用目标页面的几何。

#### Scenario: Cold load on a wide desktop
- **WHEN** 访客在 1920px 宽的视口首次打开 `/product/42`，详情页样式与模块尚未到达
- **THEN** 占位阶段页头、内容区与页脚的左右边缘、宽度和内边距与页面加载完成后一致，且不出现宽度过渡动画

#### Scenario: Detail styles arrive while the route placeholder is shown
- **WHEN** 在 1024px、1279px 或 1280px 宽度，详情页样式在占位显示期间到达
- **THEN** 内容区的左边距、宽度与内容起始顶部在样式到达前后不变

#### Scenario: Banner shown during loading
- **WHEN** 邮箱未验证的登录用户在桌面宽度冷启动打开商品详情，验证横幅从第一帧起显示
- **THEN** 横幅的左右边缘、宽度与内边距在加载各阶段保持不变

#### Scenario: Data-loading phase
- **WHEN** 页面模块已渲染、商品数据仍在请求中
- **THEN** 外壳水平几何与路由占位阶段和加载完成后相同

#### Scenario: Mobile and tablet unchanged
- **WHEN** 在 390px、767px、768px 或 1023px 宽度冷启动打开商品详情
- **THEN** 外壳几何与本变更前相同，且在加载各阶段保持不变

#### Scenario: Footer follows content height
- **WHEN** 商品加载后页面内容比占位更高
- **THEN** 页脚可以随内容向下移动，其左右边缘、宽度与内边距不变

#### Scenario: Leaving the product route
- **WHEN** 登录用户从商品详情页在应用内导航到 `/orders`
- **THEN** 外壳几何与直接打开 `/orders` 时相同
