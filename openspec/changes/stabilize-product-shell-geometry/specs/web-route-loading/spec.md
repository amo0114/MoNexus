## ADDED Requirements

### Requirement: Product route shell geometry is final from the first loading frame

在商品详情路由上，应用外壳（页头、提示横幅、内容区容器、页脚）的位置、宽度与内边距 SHALL 从路由占位的第一帧起就等于页面加载完成后的值；页面模块、页面样式或商品数据的到达 SHALL NOT 使外壳移动或改变宽度。离开商品详情路由后，外壳 SHALL 恢复其他页面的尺寸。

#### Scenario: Cold load on a wide desktop
- **WHEN** 用户在 1920px 宽的视口首次打开 `/product/42`，详情页样式与模块尚未到达
- **THEN** 占位阶段的页头、内容区与页脚左右边缘与页面加载完成后一致

#### Scenario: Detail styles arrive before the page module
- **WHEN** 在 1024px、1279px 或 1280px 宽度，详情页样式先于页面模块到达
- **THEN** 内容区起点（左边距与上边距）在样式到达前后不变

#### Scenario: Mobile and tablet unchanged
- **WHEN** 在 390px 或 768px 宽度冷启动打开商品详情
- **THEN** 外壳尺寸与本变更前相同，且在加载各阶段保持不变

#### Scenario: Leaving the product route
- **WHEN** 用户从商品详情页导航到 `/orders`
- **THEN** 外壳使用订单页等普通页面的宽度与内边距
