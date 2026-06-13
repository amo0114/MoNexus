# 商品评分评价功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 已购用户（订单 delivered/closed，含 legacy completed）可对订单评 1-5 星 + 文字，7 天窗口内可改一次；商品聚合评分（一位小数）展示在商店卡片与详情页；评价展示名用昵称（本期新增）回退邮箱打码；管理员可软删评价。

**Architecture:** 新建 `server/src/modules/reviews/`（service/schema/controller，无独立 router），路由挂在既有模块：orders（POST/PUT /:id/review）、products（GET /:id/reviews 公开）、admin（GET/DELETE /reviews）。聚合冗余字段 `Product.ratingAvg/ratingCount` 在评价写操作事务内**先 `SELECT ... FOR UPDATE` 锁 Product 行**再重算（防并发丢失更新）；"改一次"用条件 `updateMany` 原子保证。设计文档：`docs/superpowers/specs/2026-06-12-product-reviews-design.md`。

**Tech Stack:** Express + Prisma (PostgreSQL) + zod；React + Zustand；vitest（TEST_DATABASE_URL）；Playwright。

---

## 执行前置（必读）

1. 环境（WSL）：Node 20 每 shell 前缀 `eval "$(~/.local/share/fnm/fnm env)" && ~/.local/share/fnm/fnm use 20 >/dev/null`；server 测试 `cd server && TEST_DATABASE_URL='postgresql://monexus:monexus_dev_2026@localhost:5432/monexus_test?schema=public' npx vitest run <files>`；Postgres 不在则 `docker compose up -d postgres`；全量 `npm test` 约 8 分钟（timeout 600000）。
2. 在特性分支工作（如 `feature/product-reviews`），**绝不 `git add -A`**；`.playwright-mcp/` 未跟踪目录不要动。
3. 迁移会**重建 Review 表语义**：旧表只有假数据时代的孤儿行，迁移先 `DELETE FROM "Review"` 再加 NOT NULL 列（见 Task 1）。
4. 安全红线：公开评价端点绝不返回 email 原文/userId/orderId；comment 纯文本渲染。
5. `server/src/__tests__/setup.ts` 的 TRUNCATE 清单已含 `"Review"`，无需改。

---

### Task 1: Prisma schema 迁移

**Files:**
- Modify: `server/prisma/schema.prisma`（User L11-35、Product L115-144、Review L161-170、Order L185-203）

- [ ] **Step 1: 修改 schema.prisma**

User 模型 `inviteCode` 行后加：

```prisma
  nickname      String? // 1-20 字，个人中心可设；评价展示名回退邮箱打码
```

User 关系块加 `reviews Review[]`；Order 关系块（delivery 行附近）加 `review Review?`。

Review 模型整体替换为：

```prisma
model Review {
  id            Int       @id @default(autoincrement())
  productId     Int
  userId        Int
  orderId       Int       @unique // 一订单一评的数据库级保证
  rating        Int // 1-5 整数星
  comment       String? // ≤500 字纯文本
  status        String    @default("visible") // visible | removed
  editableUntil DateTime // 创建时快照 createdAt + 7 天
  editedAt      DateTime? // 非空 = 已用掉唯一一次修改机会
  createdAt     DateTime  @default(now())

  product Product @relation(fields: [productId], references: [id])
  user    User    @relation(fields: [userId], references: [id])
  order   Order   @relation(fields: [orderId], references: [id])

  @@index([productId, status, createdAt])
}
```

Product 模型 `sales` 行附近加：

```prisma
  ratingAvg   Decimal @default(0) @db.Decimal(2, 1) // ratingCount=0 时无意义，前端显示「暂无评分」
  ratingCount Int     @default(0)
```

- [ ] **Step 2: 生成迁移（--create-only）**

Run: `cd server && npx prisma migrate dev --create-only --name product_reviews`

- [ ] **Step 3: 编辑生成的 migration.sql**

在文件**最顶部**插入（旧 Review 行是假数据孤儿，必须先清空才能加 NOT NULL 列）：

```sql
-- 旧 Review 表仅含早期 seed 假数据（无 userId/orderId 关联），清空后重建语义
DELETE FROM "Review";
```

检查其余生成语句含：DROP COLUMN userName、ADD userId/orderId/status/editableUntil/editedAt、unique index orderId、index (productId,status,createdAt)、Product 两列、User nickname 列。

- [ ] **Step 4: 应用迁移**

Run: `cd server && npx prisma migrate dev`
Expected: 成功，client 重新生成。

- [ ] **Step 5: 全量测试无回归**

Run: `cd server && TEST_DATABASE_URL=... npm test`（timeout 600000）
Expected: 全 PASS（admin-query.test.ts 的「seed 不含 prisma.review」断言只查 seed 源码，不受影响）。

- [ ] **Step 6: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/
git commit -m "feat(reviews): rebuild Review model with order linkage, add nickname and rating aggregates"
```

---

### Task 2: reviews 模块核心 — 创建评价（含行锁聚合重算）

**Files:**
- Create: `server/src/modules/reviews/service.ts`、`server/src/modules/reviews/schema.ts`、`server/src/modules/reviews/controller.ts`
- Modify: `server/src/modules/orders/routes.ts`（L14 detail 路由前加 review 路由）
- Test: `server/src/modules/reviews/reviews.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

helpers：`createTestUser(email, pass, role, balance)` 返回 `{ user, password }`；`createTestProduct(name, price, stock, items[], merchantId?)` 返回 product；`loginAs(email, pass)` 返回 `{ accessToken }`；`authHeader(token)`；`api`。下单用 `POST /api/orders {productId}`（instant_inventory 即时 delivered）。

```typescript
import { describe, it, expect } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { api, createTestUser, createTestProduct, loginAs, authHeader } from '../../__tests__/helpers.js'

async function buyerWithDeliveredOrder(email: string, productOverrides: { name?: string } = {}) {
  await createTestUser(email, 'pass123', 'user', 5000)
  const product = await createTestProduct(productOverrides.name ?? `评价商品-${email}`, 100, 5, ['K1', 'K2', 'K3', 'K4', 'K5'])
  const login = await loginAs(email, 'pass123')
  const order = await api.post('/api/orders').set(authHeader(login.accessToken))
    .send({ productId: product.id }).expect(201)
  return { token: login.accessToken, productId: product.id, orderId: order.body.orderId as number }
}

describe('POST /api/orders/:id/review', () => {
  it('creates a review for a delivered order and recalcs product aggregates', async () => {
    const { token, productId, orderId } = await buyerWithDeliveredOrder('rv-create@test.local')
    const res = await api.post(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 4, comment: '不错的商品' }).expect(201)
    expect(res.body.rating).toBe(4)

    const product = await prisma.product.findUnique({ where: { id: productId } })
    expect(Number(product?.ratingAvg)).toBe(4)
    expect(product?.ratingCount).toBe(1)

    const review = await prisma.review.findUnique({ where: { orderId } })
    expect(review?.status).toBe('visible')
    expect(review?.editedAt).toBeNull()
    expect(review?.editableUntil.getTime()).toBeGreaterThan(Date.now())
  })

  it('allows reviewing a legacy completed order', async () => {
    const { token, orderId } = await buyerWithDeliveredOrder('rv-legacy@test.local')
    await prisma.order.update({ where: { id: orderId }, data: { status: 'completed' } })
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 5 }).expect(201)
  })

  it('rejects non-reviewable statuses and duplicates and foreign orders', async () => {
    const { token, orderId } = await buyerWithDeliveredOrder('rv-matrix@test.local')

    await prisma.order.update({ where: { id: orderId }, data: { status: 'disputed' } })
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 3 }).expect(400)

    await prisma.order.update({ where: { id: orderId }, data: { status: 'closed' } })
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 3 }).expect(201)
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 5 }).expect(409)

    await createTestUser('rv-other@test.local', 'pass123', 'user', 5000)
    const other = await loginAs('rv-other@test.local', 'pass123')
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(other.accessToken))
      .send({ rating: 1 }).expect(404)
  })

  it('validates rating and comment', async () => {
    const { token, orderId } = await buyerWithDeliveredOrder('rv-valid@test.local')
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token)).send({ rating: 0 }).expect(400)
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token)).send({ rating: 6 }).expect(400)
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token)).send({ rating: 4.5 }).expect(400)
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 5, comment: 'x'.repeat(501) }).expect(400)
  })

  it('keeps aggregates correct under concurrent reviews on the same product', async () => {
    const product = await createTestProduct('并发评价商品', 100, 6, ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'])
    const ratings = [5, 4, 3, 2, 1]
    const buyers = await Promise.all(ratings.map(async (rating, i) => {
      const email = `rv-conc-${i}@test.local`
      await createTestUser(email, 'pass123', 'user', 5000)
      const login = await loginAs(email, 'pass123')
      const order = await api.post('/api/orders').set(authHeader(login.accessToken))
        .send({ productId: product.id }).expect(201)
      return { token: login.accessToken, orderId: order.body.orderId as number, rating }
    }))

    const results = await Promise.all(buyers.map(b =>
      api.post(`/api/orders/${b.orderId}/review`).set(authHeader(b.token)).send({ rating: b.rating })
    ))
    for (const r of results) expect(r.status).toBe(201)

    const after = await prisma.product.findUnique({ where: { id: product.id } })
    expect(after?.ratingCount).toBe(5)
    expect(Number(after?.ratingAvg)).toBe(3) // (5+4+3+2+1)/5
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd server && TEST_DATABASE_URL=... npx vitest run src/modules/reviews/reviews.test.ts`
Expected: FAIL（路由 404）。

- [ ] **Step 3: 实现 reviews 模块**

`server/src/modules/reviews/schema.ts`：

```typescript
import { z } from 'zod'

export const reviewBodySchema = z.object({
  rating: z.number().int('评分必须是整数').min(1, '评分最低 1 星').max(5, '评分最高 5 星'),
  comment: z.string().trim().max(500, '评价最多 500 字').optional(),
}).strict()

export const productReviewsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(10),
})

export const adminReviewsQuerySchema = z.object({
  productId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
```

`server/src/modules/reviews/service.ts`：

```typescript
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound, conflict } from '../../lib/httpError.js'
import { normalizeOrderStatus } from '../orders/fulfillment.js'

const EDIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export function maskEmail(email: string) {
  const [local, domain] = email.split('@')
  const keep = local.length <= 2 ? 1 : 2
  return `${local.slice(0, keep)}***@${domain}`
}

function displayNameFor(user: { nickname: string | null; email: string }) {
  return user.nickname?.trim() || maskEmail(user.email)
}

// 必须先锁 Product 行再重算：同事务隔离级别（Read Committed）下，
// 不锁行的并发评价会各自读旧明细互相覆盖聚合
async function recalcProductRating(tx: Prisma.TransactionClient, productId: number) {
  await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR UPDATE`
  const agg = await tx.review.aggregate({
    where: { productId, status: 'visible' },
    _avg: { rating: true },
    _count: { _all: true },
  })
  const count = agg._count._all
  const avg = count > 0 ? Math.round((agg._avg.rating ?? 0) * 10) / 10 : 0
  await tx.product.update({
    where: { id: productId },
    data: { ratingAvg: avg, ratingCount: count },
  })
}

const REVIEWABLE_STATUSES = new Set(['delivered', 'closed'])

export async function createOrderReview(
  userId: number,
  orderId: number,
  input: { rating: number; comment?: string }
) {
  return prisma.$transaction(async tx => {
    const order = await tx.order.findFirst({
      where: { id: orderId, userId },
      select: { id: true, productId: true, status: true },
    })
    if (!order) throw notFound('订单不存在')
    if (!REVIEWABLE_STATUSES.has(normalizeOrderStatus(order.status))) {
      throw badRequest('订单当前状态不可评价')
    }

    let review
    try {
      review = await tx.review.create({
        data: {
          productId: order.productId,
          userId,
          orderId,
          rating: input.rating,
          comment: input.comment?.trim() || null,
          editableUntil: new Date(Date.now() + EDIT_WINDOW_MS),
        },
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict('该订单已评价')
      }
      throw err
    }

    await recalcProductRating(tx, order.productId)
    return review
  })
}
```

`server/src/modules/reviews/controller.ts`：

```typescript
import type { Request, Response, NextFunction } from 'express'
import * as reviewService from './service.js'

export async function createForOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const orderId = req.params.id as unknown as number
    const review = await reviewService.createOrderReview(req.user!.userId, orderId, req.body)
    res.status(201).json(review)
  } catch (err) {
    next(err)
  }
}
```

`server/src/modules/orders/routes.ts`：import reviews controller 与 schema，在 `router.get('/:id', ...)` 之前加：

```typescript
router.post('/:id/review', validate({ params: idParamSchema, body: reviewBodySchema }), reviewsController.createForOrder)
```

（import 形如 `import * as reviewsController from '../reviews/controller.js'`、`import { reviewBodySchema } from '../reviews/schema.js'`。）

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && TEST_DATABASE_URL=... npx vitest run src/modules/reviews/reviews.test.ts src/__tests__/orders.test.ts`
Expected: 全 PASS。`npx tsc --noEmit` 通过。

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/reviews/ server/src/modules/orders/routes.ts
git commit -m "feat(reviews): order-gated review creation with row-locked rating aggregates"
```

---

### Task 3: 修改评价（7 天窗口、原子改一次）

**Files:**
- Modify: `server/src/modules/reviews/service.ts`、`server/src/modules/reviews/controller.ts`、`server/src/modules/orders/routes.ts`
- Test: `server/src/modules/reviews/reviews.test.ts`（追加 describe）

- [ ] **Step 1: 追加失败测试**

```typescript
describe('PUT /api/orders/:id/review', () => {
  it('allows exactly one edit inside the window and recalcs aggregates', async () => {
    const { token, productId, orderId } = await buyerWithDeliveredOrder('rv-edit@test.local')
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 2 }).expect(201)

    const res = await api.put(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 5, comment: '复购后改观' }).expect(200)
    expect(res.body.rating).toBe(5)
    expect(res.body.editedAt).toBeTruthy()

    const product = await prisma.product.findUnique({ where: { id: productId } })
    expect(Number(product?.ratingAvg)).toBe(5)

    await api.put(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 1 }).expect(400) // 第二次修改被拒
  })

  it('rejects edits after the window expires', async () => {
    const { token, orderId } = await buyerWithDeliveredOrder('rv-expire@test.local')
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 3 }).expect(201)
    await prisma.review.update({
      where: { orderId },
      data: { editableUntil: new Date(Date.now() - 1000) },
    })
    await api.put(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 5 }).expect(400)
  })

  it('lets only one of two concurrent edits win', async () => {
    const { token, orderId } = await buyerWithDeliveredOrder('rv-race@test.local')
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 3 }).expect(201)

    const [a, b] = await Promise.all([
      api.put(`/api/orders/${orderId}/review`).set(authHeader(token)).send({ rating: 5 }),
      api.put(`/api/orders/${orderId}/review`).set(authHeader(token)).send({ rating: 1 }),
    ])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 400])
  })

  it('404s for foreign or missing reviews', async () => {
    const { orderId } = await buyerWithDeliveredOrder('rv-edit-owner@test.local')
    await createTestUser('rv-edit-other@test.local', 'pass123', 'user', 5000)
    const other = await loginAs('rv-edit-other@test.local', 'pass123')
    await api.put(`/api/orders/${orderId}/review`).set(authHeader(other.accessToken))
      .send({ rating: 5 }).expect(404)
  })
})
```

- [ ] **Step 2: 运行确认失败**（PUT 路由 404）

- [ ] **Step 3: 实现**

service.ts 追加（**禁止 read-then-update：条件 updateMany + 断言行数**）：

```typescript
export async function updateOrderReview(
  userId: number,
  orderId: number,
  input: { rating: number; comment?: string }
) {
  return prisma.$transaction(async tx => {
    const review = await tx.review.findUnique({
      where: { orderId },
      select: { id: true, userId: true, productId: true, status: true },
    })
    if (!review || review.userId !== userId) throw notFound('评价不存在')
    if (review.status !== 'visible') throw badRequest('评价已被移除，不可修改')

    const updated = await tx.review.updateMany({
      where: {
        orderId,
        userId,
        status: 'visible',
        editedAt: null,
        editableUntil: { gt: new Date() },
      },
      data: {
        rating: input.rating,
        comment: input.comment?.trim() || null,
        editedAt: new Date(),
      },
    })
    if (updated.count !== 1) throw badRequest('评价修改窗口已过或已修改过')

    await recalcProductRating(tx, review.productId)
    return tx.review.findUnique({ where: { orderId } })
  })
}
```

controller.ts 追加 `updateForOrder`（同 createForOrder 形态，`res.json` 200）。orders/routes.ts 加：

```typescript
router.put('/:id/review', validate({ params: idParamSchema, body: reviewBodySchema }), reviewsController.updateForOrder)
```

- [ ] **Step 4: 运行测试确认通过 + tsc**

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/reviews/ server/src/modules/orders/routes.ts
git commit -m "feat(reviews): atomic single-edit within 7-day window"
```

---

### Task 4: 公开评价列表 + 商品聚合透出（含泄漏防护）

**Files:**
- Modify: `server/src/modules/reviews/service.ts`、`controller.ts`
- Modify: `server/src/modules/products/routes.ts`、`server/src/modules/products/service.ts`（productListSelect L20-37、listProducts L90-128、getProductDetail L130-143）
- Test: `server/src/modules/reviews/reviews.test.ts`（追加）

- [ ] **Step 1: 追加失败测试**

```typescript
describe('GET /api/products/:id/reviews (public)', () => {
  it('lists visible reviews with displayName and never leaks email/userId/orderId', async () => {
    const { token, productId, orderId } = await buyerWithDeliveredOrder('rv-public@test.local')
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 4, comment: '公开可见的评价' }).expect(201)

    const res = await api.get(`/api/products/${productId}/reviews`).expect(200) // 无需登录
    expect(res.body.total).toBe(1)
    const item = res.body.items[0]
    expect(item.rating).toBe(4)
    expect(item.comment).toBe('公开可见的评价')
    expect(item.displayName).toBe('rv***@test.local') // 无昵称时邮箱打码

    const raw = JSON.stringify(res.body)
    expect(raw).not.toContain('rv-public@test.local')
    expect(raw).not.toContain('userId')
    expect(raw).not.toContain('orderId')
  })

  it('exposes ratingAvg/ratingCount as numbers in product list and detail, without legacy reviews include', async () => {
    const { token, productId, orderId } = await buyerWithDeliveredOrder('rv-agg@test.local')
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 5 }).expect(201)

    const detail = await api.get(`/api/products/${productId}`).expect(200)
    expect(detail.body.ratingAvg).toBe(5)
    expect(detail.body.ratingCount).toBe(1)
    expect(detail.body.reviews).toBeUndefined() // 遗留 include 已移除

    const list = await api.get('/api/products').expect(200)
    const found = list.body.items.find((p: { id: number }) => p.id === productId)
    expect(found.ratingAvg).toBe(5)
    expect(found.ratingCount).toBe(1)
  })
})
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

service.ts 追加：

```typescript
export async function listProductReviews(productId: number, page = 1, pageSize = 10) {
  const where = { productId, status: 'visible' }
  const [total, rows] = await prisma.$transaction([
    prisma.review.count({ where }),
    prisma.review.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        rating: true,
        comment: true,
        editedAt: true,
        createdAt: true,
        user: { select: { nickname: true, email: true } },
      },
    }),
  ])

  return {
    items: rows.map(row => ({
      id: row.id,
      rating: row.rating,
      comment: row.comment,
      editedAt: row.editedAt,
      createdAt: row.createdAt,
      displayName: displayNameFor(row.user),
    })),
    total,
    page,
    pageSize,
  }
}
```

controller.ts 追加 `listForProduct`（`req.params.id`、`req.query` 的 page/pageSize 传 service，`res.json`）。

products/routes.ts（公开，无 authenticate）在 `router.get('/:id', ...)` **之前**加（避免 `/:id` 吞掉 `/:id/reviews`——Express 按注册顺序匹配，`/:id` 不含子路径其实不冲突，但放前面更直观）：

```typescript
router.get('/:id/reviews', validate({ params: idParamSchema, query: productReviewsQuerySchema }), reviewsController.listForProduct)
```

products/service.ts：
- `productListSelect` 加 `ratingAvg: true, ratingCount: true`；
- `listProducts` 返回前把 items map 一次：`items.map(p => ({ ...p, ratingAvg: Number(p.ratingAvg) }))`（Prisma Decimal JSON 序列化为字符串，统一转 number）；
- `getProductDetail`：删除 `reviews: { orderBy: ..., take: 10 }` include；返回前在剔除 fixedContent 的同时转换 `ratingAvg: Number(product.ratingAvg)`。

- [ ] **Step 4: 运行测试确认通过 + tsc**

另跑 `npx vitest run src/modules/products/public-fields.test.ts` 防回归。

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/reviews/ server/src/modules/products/
git commit -m "feat(reviews): public paginated review list, rating aggregates on product endpoints"
```

---

### Task 5: 订单详情透出 review + canReview

**Files:**
- Modify: `server/src/modules/orders/service.ts`（getOrderDetail L192-215）
- Test: `server/src/modules/reviews/reviews.test.ts`（追加）

- [ ] **Step 1: 追加失败测试**

```typescript
describe('order detail review/canReview', () => {
  it('reports canReview=true for delivered unreviewed order, then embeds own review', async () => {
    const { token, orderId } = await buyerWithDeliveredOrder('rv-detail@test.local')

    const before = await api.get(`/api/orders/${orderId}`).set(authHeader(token)).expect(200)
    expect(before.body.canReview).toBe(true)
    expect(before.body.review).toBeNull()

    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 4, comment: '详情可见' }).expect(201)

    const after = await api.get(`/api/orders/${orderId}`).set(authHeader(token)).expect(200)
    expect(after.body.canReview).toBe(false)
    expect(after.body.review.rating).toBe(4)
    expect(after.body.review.editableUntil).toBeTruthy()
  })

  it('reports canReview=false for pending manual_service order', async () => {
    await createTestUser('rv-pending@test.local', 'pass123', 'user', 5000)
    const product = await createTestProduct('人工服务评测', 100, 0, [])
    await prisma.product.update({
      where: { id: product.id },
      data: { deliveryMode: 'manual_service', stockMode: 'unlimited' },
    })
    const login = await loginAs('rv-pending@test.local', 'pass123')
    const order = await api.post('/api/orders').set(authHeader(login.accessToken))
      .send({ productId: product.id }).expect(201)

    const detail = await api.get(`/api/orders/${order.body.orderId}`).set(authHeader(login.accessToken)).expect(200)
    expect(detail.body.canReview).toBe(false)
  })
})
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

orders/service.ts `getOrderDetail` 的 include 加：

```typescript
      review: {
        select: { rating: true, comment: true, status: true, editableUntil: true, editedAt: true, createdAt: true },
      },
```

返回处改为（import `normalizeOrderStatus` 已有）：

```typescript
  if (!order) throw notFound('订单不存在')
  const normalized = normalizeOrderStatus(order.status)
  return {
    ...serializeUserOrderDetail(order),
    review: order.review ?? null,
    canReview: !order.review && (normalized === 'delivered' || normalized === 'closed'),
  }
```

- [ ] **Step 4: 运行测试确认通过 + tsc**（连跑 orders.test.ts 防回归）

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/orders/service.ts server/src/modules/reviews/reviews.test.ts
git commit -m "feat(orders): expose own review and canReview in order detail"
```

---

### Task 6: 管理员评价列表与软删（AdminLog 审计）

**Files:**
- Modify: `server/src/modules/reviews/service.ts`
- Modify: `server/src/modules/admin/routes.ts`、`server/src/modules/admin/controller.ts`
- Test: `server/src/modules/reviews/reviews.test.ts`（追加）

- [ ] **Step 1: 追加失败测试**

```typescript
describe('admin review moderation', () => {
  it('soft-removes a review, recalcs aggregates, writes AdminLog, blocks re-review and edit', async () => {
    const { token, productId, orderId } = await buyerWithDeliveredOrder('rv-admin@test.local')
    const created = await api.post(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 1, comment: '违规内容' }).expect(201)

    await createTestUser('rv-admin-op@test.local', 'pass123', 'admin', 0)
    const admin = await loginAs('rv-admin-op@test.local', 'pass123')

    const listed = await api.get(`/api/admin/reviews?productId=${productId}`)
      .set(authHeader(admin.accessToken)).expect(200)
    expect(listed.body.items[0].id).toBe(created.body.id)

    await api.delete(`/api/admin/reviews/${created.body.id}`)
      .set(authHeader(admin.accessToken)).expect(200)

    const product = await prisma.product.findUnique({ where: { id: productId } })
    expect(product?.ratingCount).toBe(0)
    expect(Number(product?.ratingAvg)).toBe(0)

    const publicList = await api.get(`/api/products/${productId}/reviews`).expect(200)
    expect(publicList.body.total).toBe(0)

    const log = await prisma.adminLog.findFirst({
      where: { targetType: 'review', targetId: created.body.id },
    })
    expect(log?.action).toBe('移除评价')

    // 不可重评（orderId unique 仍占用）、不可修改
    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 5 }).expect(409)
    await api.put(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 5 }).expect(400)

    // 重复删除 400；普通用户 403
    await api.delete(`/api/admin/reviews/${created.body.id}`)
      .set(authHeader(admin.accessToken)).expect(400)
    await api.delete(`/api/admin/reviews/${created.body.id}`)
      .set(authHeader(token)).expect(403)
  })
})
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

reviews/service.ts 追加：

```typescript
export async function listReviewsForAdmin(filters: { productId?: number; page: number; pageSize: number }) {
  const where = filters.productId ? { productId: filters.productId } : {}
  const [total, items] = await prisma.$transaction([
    prisma.review.count({ where }),
    prisma.review.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
      select: {
        id: true,
        productId: true,
        orderId: true,
        rating: true,
        comment: true,
        status: true,
        createdAt: true,
        user: { select: { id: true, email: true } },
      },
    }),
  ])
  return { items, total, page: filters.page, pageSize: filters.pageSize }
}

export async function removeReviewByAdmin(adminUserId: number, reviewId: number) {
  return prisma.$transaction(async tx => {
    const review = await tx.review.findUnique({
      where: { id: reviewId },
      select: { id: true, productId: true, status: true },
    })
    if (!review) throw notFound('评价不存在')
    if (review.status === 'removed') throw badRequest('评价已被移除')

    await tx.review.update({ where: { id: reviewId }, data: { status: 'removed' } })
    await recalcProductRating(tx, review.productId)
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '移除评价',
        targetType: 'review',
        targetId: review.id,
        detail: `评价 #${review.id}（商品 #${review.productId}）已移除`,
      },
    })
    return { id: review.id, status: 'removed' }
  })
}
```

admin/controller.ts 追加 `listReviews`/`removeReview`（按既有 controller 形态，调上述 service，分别 `res.json`）。admin/routes.ts（守卫链 L16 已全局生效）追加：

```typescript
router.get('/reviews', validate({ query: adminReviewsQuerySchema }), controller.listReviews)
router.delete('/reviews/:id', validate({ params: idParamSchema }), controller.removeReview)
```

（`adminReviewsQuerySchema` 从 `../reviews/schema.js` import。这是全仓第一条 DELETE 路由，无既有先例，按上写即可。）

- [ ] **Step 4: 运行测试确认通过 + tsc**（连跑 admin.test.ts、admin-query.test.ts 防回归）

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/reviews/ server/src/modules/admin/
git commit -m "feat(admin): review moderation with soft delete, aggregates recalc and audit log"
```

---

### Task 7: 昵称后端（PATCH /api/auth/me + 两处序列化 + 展示名优先级）

**Files:**
- Modify: `server/src/modules/auth/schema.ts`、`server/src/modules/auth/service.ts`（getUserProfile L205-230、buildAuthUser L24-33）、`server/src/modules/auth/controller.ts`、`server/src/modules/auth/routes.ts`（L56 附近）
- Test: `server/src/modules/reviews/reviews.test.ts`（追加）

- [ ] **Step 1: 追加失败测试**

```typescript
describe('nickname', () => {
  it('PATCH /api/auth/me sets nickname, GET /me returns it, review displayName prefers it', async () => {
    const { token, productId, orderId } = await buyerWithDeliveredOrder('rv-nick@test.local')

    await api.patch('/api/auth/me').set(authHeader(token))
      .send({ nickname: '匿名小熊' }).expect(200)

    const me = await api.get('/api/auth/me').set(authHeader(token)).expect(200)
    expect(me.body.nickname).toBe('匿名小熊')

    await api.post(`/api/orders/${orderId}/review`).set(authHeader(token))
      .send({ rating: 5 }).expect(201)
    const list = await api.get(`/api/products/${productId}/reviews`).expect(200)
    expect(list.body.items[0].displayName).toBe('匿名小熊')
  })

  it('validates nickname length', async () => {
    const { token } = await buyerWithDeliveredOrder('rv-nick2@test.local')
    await api.patch('/api/auth/me').set(authHeader(token)).send({ nickname: '' }).expect(400)
    await api.patch('/api/auth/me').set(authHeader(token)).send({ nickname: 'x'.repeat(21) }).expect(400)
  })
})
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

auth/schema.ts 追加：

```typescript
export const updateMeSchema = z.object({
  nickname: z.string().trim().min(1, '昵称不能为空').max(20, '昵称最多 20 字'),
}).strict()
```

auth/service.ts：`getUserProfile` 与 `buildAuthUser` 的返回对象都加 `nickname`（前者 select/查询对象里补字段，后者入参 user 上直接取）；追加：

```typescript
export async function updateUserProfile(userId: number, data: { nickname: string }) {
  await prisma.user.update({ where: { id: userId }, data: { nickname: data.nickname } })
  return getUserProfile(userId)
}
```

auth/controller.ts 追加 `updateMe`（调 `updateUserProfile(req.user!.userId, req.body)`，`res.json`）。auth/routes.ts L56 旁追加：

```typescript
router.patch('/me', authenticate, requireActiveUser, validate(updateMeSchema), controller.updateMe)
```

- [ ] **Step 4: 运行测试确认通过 + tsc**（连跑 auth.test.ts 防回归）

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/auth/ server/src/modules/reviews/reviews.test.ts
git commit -m "feat(auth): user nickname with profile patch endpoint"
```

---

### Task 8: 前端 API 层、类型与星级组件

**Files:**
- Create: `src/api/reviews.ts`、`src/components/ui/StarRating.tsx`
- Modify: `src/api/auth.ts`、`src/types/merchant.ts`（AuthUser L28-43）、`src/types/order.ts`

- [ ] **Step 1: src/api/reviews.ts**

```typescript
import api from './client'

export interface ReviewItem {
  id: number
  rating: number
  comment: string | null
  displayName: string
  editedAt: string | null
  createdAt: string
}

export interface ReviewPage {
  items: ReviewItem[]
  total: number
  page: number
  pageSize: number
}

export interface OwnReview {
  rating: number
  comment: string | null
  status: string
  editableUntil: string
  editedAt: string | null
  createdAt: string
}

export async function getProductReviews(productId: number, page = 1): Promise<ReviewPage> {
  const { data } = await api.get(`/products/${productId}/reviews`, { params: { page } })
  return data
}

export async function createOrderReview(orderId: number, body: { rating: number; comment?: string }): Promise<OwnReview> {
  const { data } = await api.post(`/orders/${orderId}/review`, body)
  return data
}

export async function updateOrderReview(orderId: number, body: { rating: number; comment?: string }): Promise<OwnReview> {
  const { data } = await api.put(`/orders/${orderId}/review`, body)
  return data
}
```

- [ ] **Step 2: src/components/ui/StarRating.tsx**（展示与可交互两用，复用 index.css L315 的 `.star-filled`/`.star-empty`）

```tsx
import { Star } from 'lucide-react'

interface Props {
  value: number // 展示值（可小数）或当前选中星数
  onChange?: (value: number) => void // 提供则进入可交互模式（整数 1-5）
  size?: 'sm' | 'md'
}

export default function StarRating({ value, onChange, size = 'sm' }: Props) {
  const cls = size === 'sm' ? 'w-3.5 h-3.5' : 'w-6 h-6'
  return (
    <div className="flex items-center gap-0.5" role={onChange ? 'radiogroup' : undefined} aria-label={`评分 ${value} / 5`}>
      {[1, 2, 3, 4, 5].map(star => (
        <Star
          key={star}
          className={`${cls} ${star <= Math.round(value) ? 'star-filled' : 'star-empty'} ${onChange ? 'cursor-pointer' : ''}`}
          onClick={onChange ? () => onChange(star) : undefined}
          data-testid={onChange ? `star-input-${star}` : undefined}
        />
      ))}
    </div>
  )
}
```

- [ ] **Step 3: 类型与 auth API**

`src/types/merchant.ts` AuthUser 加 `nickname?: string | null`。
`src/types/order.ts` UserOrderDetail 追加：

```typescript
  review?: null | {
    rating: number
    comment: string | null
    status: string
    editableUntil: string
    editedAt: string | null
    createdAt: string
  }
  canReview?: boolean
```

`src/api/auth.ts` 追加：

```typescript
export async function updateMe(body: { nickname: string }): Promise<AuthUser> {
  const { data } = await api.patch<AuthUser>('/auth/me', body)
  return data
}
```

- [ ] **Step 4: 验证 + Commit**

`npx tsc --noEmit` 通过。

```bash
git add src/api/reviews.ts src/api/auth.ts src/components/ui/StarRating.tsx src/types/merchant.ts src/types/order.ts
git commit -m "feat(ui): reviews api client, star rating component, contract types"
```

---

### Task 9: OrderDetailModal 评价入口与弹层

**Files:**
- Create: `src/components/ReviewDialog.tsx`
- Modify: `src/components/OrderDetailModal.tsx`（底部按钮区 L172-204、发货内容区之后加自评区块）

- [ ] **Step 1: ReviewDialog.tsx**

```tsx
import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { createOrderReview, updateOrderReview, OwnReview } from '../api/reviews'
import StarRating from './ui/StarRating'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/Dialog'

interface Props {
  open: boolean
  orderId: number
  mode: 'create' | 'edit'
  initial?: { rating: number; comment: string | null }
  onClose: () => void
  onSaved: (review: OwnReview) => void
}

export default function ReviewDialog({ open, orderId, mode, initial, onClose, onSaved }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [rating, setRating] = useState(initial?.rating ?? 5)
  const [comment, setComment] = useState(initial?.comment ?? '')
  const [saving, setSaving] = useState(false)

  async function handleSubmit() {
    setSaving(true)
    try {
      const body = { rating, comment: comment.trim() || undefined }
      const saved = mode === 'create'
        ? await createOrderReview(orderId, body)
        : await updateOrderReview(orderId, body)
      showToast(mode === 'create' ? '评价已提交' : '评价已修改')
      onSaved(saved)
    } catch (e: any) {
      showToast(e.response?.data?.error?.message || '操作失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="!z-[120]" data-testid="review-dialog">
        <DialogTitle>{mode === 'create' ? '评价商品' : '修改评价'}</DialogTitle>
        <DialogDescription>
          {mode === 'edit' ? '修改机会仅一次，提交后不可再改。' : '评分必填，评价内容可选（500 字内）。'}
        </DialogDescription>
        <div className="mt-4 space-y-4">
          <StarRating value={rating} onChange={setRating} size="md" />
          <textarea
            className="input min-h-[80px] resize-y text-sm w-full"
            placeholder="说说你的使用体验（可选）..."
            maxLength={500}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            data-testid="review-comment-input"
          />
        </div>
        <div className="mt-5 flex justify-end gap-3">
          <button type="button" onClick={onClose} className="btn-secondary !px-5 !py-2 !text-sm">取消</button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving}
            className="btn-primary !px-5 !py-2 !text-sm"
            data-testid="review-submit"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : '提交'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: OrderDetailModal 集成**

- state：`const [reviewOpen, setReviewOpen] = useState(false)`、`const [review, setReview] = useState(initialOrder.review ?? null)`、`const canReview = order.canReview && !review`。
- 发货内容区块之后新增「我的评价」区块（仅 review 存在时）：

```tsx
          {review && (
            <div className="bg-[var(--color-background)] rounded-lg p-5 border border-[var(--color-border)]" data-testid="own-review">
              <h3 className="font-heading text-sm font-bold text-[var(--color-text)] mb-3">我的评价</h3>
              {review.status === 'removed' ? (
                <p className="text-xs text-[var(--color-text-muted)]">评价已被移除</p>
              ) : (
                <>
                  <StarRating value={review.rating} />
                  {review.comment && <p className="mt-2 text-xs text-[var(--color-text)] whitespace-pre-wrap">{review.comment}</p>}
                  {!review.editedAt && new Date(review.editableUntil) > new Date() && (
                    <button
                      type="button"
                      onClick={() => setReviewOpen(true)}
                      className="mt-3 text-xs text-[var(--color-primary)] underline cursor-pointer"
                      data-testid="review-edit-button"
                    >
                      修改评价（可修改至 {new Date(review.editableUntil).toLocaleDateString()}）
                    </button>
                  )}
                </>
              )}
            </div>
          )}
```

- 底部按钮区（L172-204 的 flex 容器内）追加：

```tsx
          {canReview && (
            <button
              onClick={() => setReviewOpen(true)}
              data-testid="review-create-button"
              className="btn-secondary !px-4 !border-[var(--color-primary)] !text-[var(--color-primary)]"
            >
              评价商品
            </button>
          )}
```

- 组件末尾（既有 Dialog 旁）挂 ReviewDialog：

```tsx
      {reviewOpen && (
        <ReviewDialog
          open={reviewOpen}
          orderId={order.id}
          mode={review ? 'edit' : 'create'}
          initial={review ? { rating: review.rating, comment: review.comment } : undefined}
          onClose={() => setReviewOpen(false)}
          onSaved={(saved) => { setReview(saved); setReviewOpen(false) }}
        />
      )}
```

import StarRating/ReviewDialog/OwnReview 类型。

- [ ] **Step 3: 验证 + Commit**

`npx tsc --noEmit` 通过。

```bash
git add src/components/ReviewDialog.tsx src/components/OrderDetailModal.tsx
git commit -m "feat(ui): review entry and dialog in order detail"
```

---

### Task 10: 商品详情评分摘要 + 评价列表 + 商店卡片星级

**Files:**
- Modify: `src/pages/ProductDetailPage.tsx`（Product 接口 L12-27、已售/库存区 L207-212、左栏 L248-258 之后）
- Modify: `src/pages/StorePage.tsx`（Product 接口 L12-27、卡片右列 L136-139）

- [ ] **Step 1: ProductDetailPage**

- Product 接口加 `ratingAvg?: number`、`ratingCount?: number`。
- 已售/库存 span 行（L207-212）加一项：

```tsx
                  {product.ratingCount && product.ratingCount > 0 ? (
                    <span className="flex items-center gap-1" data-testid="rating-summary">
                      <StarRating value={product.ratingAvg ?? 0} />
                      <span className="font-bold text-[var(--color-text)]">{(product.ratingAvg ?? 0).toFixed(1)}</span>
                      （{product.ratingCount} 条评价）
                    </span>
                  ) : (
                    <span data-testid="rating-summary">暂无评分</span>
                  )}
```

- 左栏图文介绍之后（L258 后）新增评价区块（组件内新增 state + effect）：

```tsx
  const [reviews, setReviews] = useState<ReviewItem[]>([])
  const [reviewTotal, setReviewTotal] = useState(0)
  const [reviewPage, setReviewPage] = useState(1)

  useEffect(() => {
    if (!id) return
    getProductReviews(Number(id), reviewPage)
      .then((data) => {
        setReviewTotal(data.total)
        setReviews((prev) => reviewPage === 1 ? data.items : [...prev, ...data.items])
      })
      .catch(() => {})
  }, [id, reviewPage])
```

```tsx
              <div className="mt-8" data-testid="review-list">
                <h2 className="font-heading text-lg font-bold text-[var(--color-text)] mb-4">用户评价（{reviewTotal}）</h2>
                {reviews.length === 0 ? (
                  <p className="text-sm text-[var(--color-text-muted)]">暂无评价</p>
                ) : (
                  <div className="space-y-4">
                    {reviews.map((r) => (
                      <div key={r.id} className="bg-[var(--color-background)] rounded-lg p-4 border border-[var(--color-border)]">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-[var(--color-text)]">{r.displayName}</span>
                          <StarRating value={r.rating} />
                        </div>
                        {r.comment && <p className="mt-2 text-xs text-[var(--color-text)] whitespace-pre-wrap">{r.comment}</p>}
                        <div className="mt-2 text-[10px] text-[var(--color-text-muted)]">
                          {new Date(r.createdAt).toLocaleDateString()}{r.editedAt ? '（已修改）' : ''}
                        </div>
                      </div>
                    ))}
                    {reviews.length < reviewTotal && (
                      <button type="button" onClick={() => setReviewPage((p) => p + 1)} className="btn-secondary w-full !py-2 !text-sm">
                        加载更多
                      </button>
                    )}
                  </div>
                )}
              </div>
```

- [ ] **Step 2: StorePage 卡片**

Product 接口加 `ratingAvg?: number`、`ratingCount?: number`。右列（L136 `已售` span 之前）加：

```tsx
    {product.ratingCount && product.ratingCount > 0 ? (
      <span className="flex items-center gap-1">
        <Star className="w-3 h-3 star-filled" />
        {(product.ratingAvg ?? 0).toFixed(1)}（{product.ratingCount}）
      </span>
    ) : (
      <span>暂无评分</span>
    )}
```

（import lucide `Star`；注意卡片固定高 `h-[356px]`，该列为 `text-[10px]` 纵排，加一行不溢出，若溢出微调 gap。）

- [ ] **Step 3: 验证 + Commit**

`npx tsc --noEmit` 通过；起前后端浏览器抽查详情页与商店卡片。

```bash
git add src/pages/ProductDetailPage.tsx src/pages/StorePage.tsx
git commit -m "feat(ui): rating summary, review list and store card stars"
```

---

### Task 11: ProfilePage 昵称卡片

**Files:**
- Modify: `src/pages/ProfilePage.tsx`（仿 PasswordChangeCard L19-118 模式，在 L394 `<PasswordChangeCard/>` 之前插入）

- [ ] **Step 1: 新增 NicknameCard 组件（同文件内，与 PasswordChangeCard 并列）**

```tsx
function NicknameCard() {
  const user = useAuthStore((s) => s.user)
  const setUser = useAuthStore((s) => s.setUser)
  const showToast = useAppStore((s) => s.showToast)
  const [editing, setEditing] = useState(false)
  const [nickname, setNickname] = useState(user?.nickname ?? '')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    const value = nickname.trim()
    if (!value || value.length > 20) {
      showToast('昵称需为 1-20 个字符', 'error')
      return
    }
    setSaving(true)
    try {
      const me = await updateMe({ nickname: value })
      setUser(me)
      showToast('昵称已更新')
      setEditing(false)
    } catch (e: any) {
      showToast(e.response?.data?.error?.message || '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-[var(--color-surface)] rounded-xl p-6 border border-[var(--color-border)]" data-testid="nickname-card">
      <h3 className="font-heading text-sm font-bold text-[var(--color-text)] mb-3">昵称（用于评价展示）</h3>
      {editing ? (
        <div className="flex gap-2">
          <input
            className="input flex-1 !py-2 text-sm"
            maxLength={20}
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            data-testid="nickname-input"
          />
          <button type="button" onClick={handleSave} disabled={saving} className="btn-primary !px-4 !py-2 !text-sm" data-testid="nickname-save">
            {saving ? '保存中...' : '保存'}
          </button>
          <button type="button" onClick={() => setEditing(false)} className="btn-secondary !px-4 !py-2 !text-sm">取消</button>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <span className="text-sm text-[var(--color-text)]">{user?.nickname || '未设置（评价将显示打码邮箱）'}</span>
          <button type="button" onClick={() => { setNickname(user?.nickname ?? ''); setEditing(true) }} className="btn-secondary !px-4 !py-1.5 !text-xs" data-testid="nickname-edit">
            编辑
          </button>
        </div>
      )}
    </div>
  )
}
```

（import `updateMe` from '../api/auth'；其余 imports 文件内已有。）主组件 L394 `<PasswordChangeCard/>` 前插 `<NicknameCard />`。

- [ ] **Step 2: 验证 + Commit**

`npx tsc --noEmit` 通过；浏览器验证设置昵称后刷新仍在（authStore persist + /me 返回）。

```bash
git add src/pages/ProfilePage.tsx
git commit -m "feat(ui): nickname settings card in profile"
```

---

### Task 12: e2e 全链路

**Files:**
- Create: `e2e/product-reviews.spec.ts`

- [ ] **Step 1: 先读 `e2e/instant-fixed.spec.ts` 与 `e2e/helpers.ts`**，对齐导航/购买/订单详情的既有选择器写法（loginAs、SEED_ACCOUNTS、订单卡定位方式）。

- [ ] **Step 2: 编写 spec（serial，商品名带时间戳）**

覆盖：

1. user 登录 → ProfilePage 设置昵称（`nickname-edit` → `nickname-input` 填 `E2E评价员` → `nickname-save`）。
2. merchant 登录发布一个 instant_inventory 商品（或复用既有发布流程）→ user 购买 → 订单详情 `review-create-button` → `star-input-4` + `review-comment-input` 填「e2e 评价内容」→ `review-submit` → `own-review` 区块出现 4 星。
3. 商品详情页：`rating-summary` 含 `4.0`；`review-list` 出现「E2E评价员」与评价内容。
4. 回订单详情 `review-edit-button` → 改 5 星提交 → `own-review` 显示 5 星且不再出现修改按钮（editedAt 已置）。
5. 商品详情 `rating-summary` 变 `5.0`。

选择器以 Step 1 读到的实际写法为准修正；断言用 testid + 文本，不用样式类。

- [ ] **Step 3: 运行**

`npx playwright test e2e/product-reviews.spec.ts` 通过；再 `npx playwright test` 全量通过（注意 /api 限流 300 次/15 分钟，多轮运行遇 429 重启 server）。

- [ ] **Step 4: Commit**

```bash
git add e2e/product-reviews.spec.ts
git commit -m "test(e2e): review create, display, single edit flow"
```

---

## 完成定义（DoD）

- `cd server && npm test` 全绿；`npx tsc --noEmit` 无错；`npx playwright test` 全绿。
- 公开评价端点响应不含 email 原文/userId/orderId（Task 4 测试守护）。
- 并发安全有测试背书：同商品并发评价聚合正确（Task 2）、并发双 PUT 仅一成功（Task 3）。
- 既有功能零回归（orders/products/admin/auth 套件）。
- 范围外未做：商家回复、点赞/举报、评分排序筛选、敏感词。
