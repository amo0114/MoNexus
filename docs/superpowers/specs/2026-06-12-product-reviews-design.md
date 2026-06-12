# MoNexus 商品评分评价功能设计

日期：2026-06-12
状态：已评审通过

## 1. 背景与目标

让潜在买家在购买前看到商品的真实评分（满分 5.0）与评价，建立购买决策信任。核心约束：**只有真实购买者可评**。

现状：schema 存在早期占位的 Review 模型（productId/userName/rating/comment），无 userId/orderId 关联，无写入 API，前端未渲染，seed 假数据已清除（admin-query.test.ts 有测试禁止复活）。用户体系无昵称字段（仅邮箱）。Product 无评分聚合字段。

### 已拍板的决策

| 决策点 | 结论 |
|---|---|
| 评价粒度 | 一订单一评（orderId unique），重复购买可再评 |
| 可评状态 | delivered + closed（disputed 不可评） |
| 修改/删除 | 7 天窗口内可改一次；用户不可删；管理员可删（审计） |
| 商家回复 | 本期不做 |
| 展示名 | 本期顺带加 User.nickname；未设置回退邮箱打码 |

### 范围外

商家公开回复、评价点赞/举报、图片评价、按评分排序/筛选商品、敏感词过滤。

## 2. 数据模型

```prisma
// User 新增
nickname String? // 1-20 字，个人中心可设

// Review 改造（现表无真实数据，直接改字段，无需数据迁移）
model Review {
  id            Int       @id @default(autoincrement())
  productId     Int
  userId        Int
  orderId       Int       @unique // 一订单一评的数据库级保证
  rating        Int // 1-5 整数星，必填
  comment       String? // ≤500 字，可选，纯文本
  status        String    @default("visible") // visible | removed
  editableUntil DateTime // 创建时快照 createdAt + 7 天
  editedAt      DateTime? // 非空 = 已用掉唯一一次修改机会
  createdAt     DateTime  @default(now())

  product Product @relation(fields: [productId], references: [id])
  user    User    @relation(fields: [userId], references: [id])
  order   Order   @relation(fields: [orderId], references: [id])

  @@index([productId, status, createdAt])
}
// userName 字段删除（假数据时代遗留）

// Product 新增聚合冗余字段（与 stock 冗余计数同模式）
ratingAvg   Decimal @default(0) @db.Decimal(2, 1) // 0 + ratingCount=0 表示暂无评分
ratingCount Int     @default(0)
```

- 展示名查询时实时派生：`nickname ?? maskEmail(email)`（如 `te***@moyuan.net`）。Review 不存展示名——改昵称历史评价自动跟随，零迁移。
- 聚合重算：评价创建/修改/管理员删除的同一事务内，对该商品 `AVG(rating)`/`COUNT(*)`（仅 status=visible）重算并写回 Product。失败整体回滚，评分与明细不会不一致。

## 3. API

### 用户侧

- `POST /api/orders/:id/review`，body `{ rating: 1..5 int, comment?: ≤500 字 }`
  资格校验：订单属当前用户（404 否则）；`status ∈ {delivered, closed}`（400 否则）；未评价过（409，orderId unique 兜底并发）。事务内创建 Review + 重算聚合。
- `PUT /api/orders/:id/review`，body 同上
  仅 `now < editableUntil && editedAt == null`（400 否则）。改后写 `editedAt = now`，重算聚合。
- 用户订单详情响应透出：`review`（自己的评价：rating/comment/editableUntil/editedAt/status）+ `canReview: boolean`。
- `PATCH /api/users/me`，body `{ nickname: 1-20 字 trim }`（不要求唯一）。若现无 users/me 更新端点则新建，路径以实际用户模块为准。

### 公开侧

- `GET /api/products/:id/reviews?page=&pageSize=`：仅 visible，createdAt desc，返回 `{ id, rating, comment, displayName, editedAt, createdAt }`。**绝不返回 email 原文、userId、orderId**。
- 商品 list/detail 既有响应自然带 `ratingAvg`/`ratingCount`。
- `getProductDetail` 移除遗留 `reviews` include（消费方仅此一处且前端未渲染，改用上述分页端点）。

### 管理侧

- `GET /api/admin/reviews?productId=&page=&pageSize=`（含 removed，标注状态）
- `DELETE /api/admin/reviews/:id`：软删（status=removed）+ 同事务重算聚合 + AdminLog（项目惯例：admin 写操作同事务落审计）。removed 评价不进公开列表与聚合，行保留供审计。管理员删评后该订单不可重评（orderId unique 仍占用——删的是违规内容，不是重评机会）。

## 4. 前端

- **OrderDetailModal**：delivered/closed 且 `canReview` 显示「评价商品」按钮 → 弹层：1-5 星选择 + 可选文本框。已评显示自己的评分/内容；窗口内未改过时显示「可修改至 <日期>」与修改入口；评价被管理员移除时显示「评价已被移除」。
- **ProductDetailPage**：价格区附近显示 `★ 4.7（23 条评价）`；页面下方新增评价列表区（分页加载，显示 displayName/星级/文字/时间，editedAt 非空标注「已修改」），空态「暂无评价」。
- **StorePage 商品卡片**：星 + 均分 + 条数；`ratingCount === 0` 显示「暂无评分」（不显示 0.0）。复用 index.css 既有星级样式占位。
- **ProfilePage**：昵称设置（显示当前昵称或「未设置」，行内编辑保存）。

## 5. 边界与安全

- comment 纯文本渲染（不走 DOMPurify 富文本管线，直接文本节点输出），后端 trim + 长度校验。
- rating 严格整数 1-5（zod int min/max）。
- 公开评价列表是未登录可访问的只读端点，序列化白名单字段，杜绝 email/userId 泄漏。
- 邮箱打码规则：local part 保留前 2 字符其余 `***`，域名完整保留；local ≤2 字符时保留 1 字符。
- 7 天窗口快照进 `editableUntil`，后续把窗口做成 systemConfig 可配时不影响存量评价。

## 6. 测试

后端（vitest + TEST_DATABASE_URL）：

- 资格矩阵：非本人 404；pending/processing/disputed 400；delivered/closed 201；重复评价 409。
- 修改：窗口内首次 200；二次 400；过期 400（用 prisma 直接改 editableUntil 模拟过期）。
- 聚合：创建/修改/删除后 ratingAvg/ratingCount 正确（含多用户多订单场景、四舍五入到一位小数）。
- 泄漏防护：公开列表响应不含 email/userId/orderId/removed 评价。
- 昵称：设置成功、长度校验、评价展示名 nickname 优先、未设置回退打码。
- AdminLog：删评落审计行。

e2e（Playwright）：购买 → 订单详情评价（4 星 + 文字）→ 商品详情看到 `★ 4.0` 与评价条目（展示名为昵称/打码邮箱）→ 修改为 5 星 → 再次修改被拒。

## 7. 实施切分

单一计划即可（后端模型+API → 前端入口与展示 → e2e），无需拆分多个 spec。
