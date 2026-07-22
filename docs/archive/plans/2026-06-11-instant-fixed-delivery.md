# instant_fixed 交付模式（Phase 1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `instant_fixed`（固定内容/链接即时交付）模式：商家配置固定交付内容（文本或 URL），买家下单即收同一份内容；同时引入 `stockMode: limited | unlimited` 库存语义与 `DeliveryRecord.contentType` 类型化渲染。

**Architecture:** 在现有 `deliveryMode` 双模式骨架上做最小演进——`FULFILLMENT_MODES` 扩为三值，新增 `isInstantMode()` 替换散落的 `=== 'instant_inventory'` 硬编码；`instant_fixed` 不消耗 InventoryItem，内容来自 `Product.fixedContent`，购买时快照进 DeliveryRecord。设计文档：`docs/superpowers/specs/2026-06-11-delivery-methods-design.md`。

**Tech Stack:** Express + Prisma (PostgreSQL) + zod（后端 server/）；React + Zustand + Tailwind（前端 src/）；vitest（server 集成测试，需 TEST_DATABASE_URL）；Playwright（e2e/）。

---

## 执行前置检查（必读）

1. **工作区有未提交改动**（M9 遗留：`server/prisma/schema.prisma`、products 模块、StorePage 等）。执行前先和用户确认这些改动的处置（提交或 stash）。**绝不使用 `git add -A`**，每个任务只 add 本任务涉及的文件。
2. server 测试需要数据库：环境变量 `TEST_DATABASE_URL` 已配置（见项目内存 project_monexus_env.md）。运行 `cd server && npm test` 前确认 PostgreSQL 可达。
3. Prisma 迁移在 dev 数据库执行：`cd server && npx prisma migrate dev --name instant_fixed_delivery`。
4. **安全红线**：`Product.fixedContent` 是付费内容，绝不能出现在公开商品 list/detail 响应中（Task 7 专门处理）。
5. `server/src/__tests__/config-registry.test.ts` 可能断言 registry 的 deliveryModes 列表，Task 2 改 registry 后若该测试失败，按新列表更新断言（这是预期失败，不是回归）。

---

### Task 1: Prisma schema 迁移（Product 三字段 + DeliveryRecord.contentType + 数据回填）

**Files:**
- Modify: `server/prisma/schema.prisma`（Product L115-141、DeliveryRecord L202-214）
- Create: 迁移目录由 `prisma migrate dev` 自动生成，需手工追加回填 SQL

- [ ] **Step 1: 修改 schema.prisma**

Product 模型中，将 `deliveryMode` 行替换并在其后新增三字段：

```prisma
  deliveryMode     String   @default("instant_inventory") // instant_inventory | instant_fixed | manual_service
  stockMode        String   @default("limited") // limited | unlimited（instant_inventory 强制 limited）
  fixedContent     String? // instant_fixed 专用：固定交付内容（付费内容，禁止公开序列化）
  fixedContentType String   @default("text") // text | url
```

DeliveryRecord 模型中，在 `content   String?` 之后新增：

```prisma
  contentType String  @default("text") // text | url | file
```

- [ ] **Step 2: 生成迁移（先 --create-only，便于追加回填 SQL）**

Run: `cd server && npx prisma migrate dev --create-only --name instant_fixed_delivery`
Expected: 生成 `server/prisma/migrations/<timestamp>_instant_fixed_delivery/migration.sql`

- [ ] **Step 3: 在生成的 migration.sql 末尾追加回填**

```sql
-- 存量人工服务商品不参与库存扣减，回填为不限接单，避免 stock=0 阻断下单
UPDATE "Product" SET "stockMode" = 'unlimited' WHERE "deliveryMode" = 'manual_service';
```

- [ ] **Step 4: 应用迁移并生成 client**

Run: `cd server && npx prisma migrate dev`
Expected: 迁移应用成功，Prisma Client 重新生成

- [ ] **Step 5: 跑既有测试确认无回归**

Run: `cd server && npm test`
Expected: 全部 PASS（schema 新字段均有默认值，不破坏现有行为）

- [ ] **Step 6: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations/
git commit -m "feat(delivery): add stockMode/fixedContent to Product, contentType to DeliveryRecord"
```

---

### Task 2: 模式常量与 Registry（isInstantMode + instant_fixed 注册）

**Files:**
- Modify: `server/src/modules/orders/fulfillment.ts:5-26`
- Modify: `server/src/lib/businessRegistry.ts`
- Test: `server/src/__tests__/instant-fixed-mode.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect } from 'vitest'
import { FULFILLMENT_MODES, isInstantMode } from '../modules/orders/fulfillment.js'
import { businessRegistry } from '../lib/businessRegistry.js'

describe('instant_fixed fulfillment mode', () => {
  it('registers instant_fixed as a fulfillment mode', () => {
    expect(FULFILLMENT_MODES).toContain('instant_fixed')
  })

  it('classifies instant modes correctly', () => {
    expect(isInstantMode('instant_inventory')).toBe(true)
    expect(isInstantMode('instant_fixed')).toBe(true)
    expect(isInstantMode('manual_service')).toBe(false)
    expect(isInstantMode('unknown')).toBe(false)
  })

  it('exposes instant_fixed in businessRegistry for every product type', () => {
    expect(businessRegistry.deliveryModes.map(m => m.value)).toContain('instant_fixed')
    for (const type of businessRegistry.productTypes) {
      expect(type.deliveryModes).toContain('instant_fixed')
    }
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd server && npx vitest run src/__tests__/instant-fixed-mode.test.ts`
Expected: FAIL（`isInstantMode` 未导出、registry 不含 instant_fixed）

- [ ] **Step 3: 修改 fulfillment.ts**

L5 替换为：

```typescript
export const FULFILLMENT_MODES = ['instant_inventory', 'instant_fixed', 'manual_service'] as const
export type FulfillmentMode = (typeof FULFILLMENT_MODES)[number]

export const INSTANT_FULFILLMENT_MODES = ['instant_inventory', 'instant_fixed'] as const
const instantModeSet = new Set<string>(INSTANT_FULFILLMENT_MODES)

export function isInstantMode(mode: string): boolean {
  return instantModeSet.has(mode)
}
```

L22-23 注释更新为：

```typescript
  // disputed → delivered：即时模式（instant_*）货已交付，商家驳回争议时直接恢复为已交付，
  // 否则会卡死在 processing（即时单没有商家 deliver 出口）
```

- [ ] **Step 4: 修改 businessRegistry.ts**

四个 productTypes 的 `deliveryModes` 数组统一改为：

```typescript
      deliveryModes: ['instant_inventory', 'instant_fixed', 'manual_service'],
```

`deliveryModes` 注册表在 instant_inventory 与 manual_service 之间插入：

```typescript
    {
      value: 'instant_fixed',
      label: '固定内容直发',
      tone: 'success',
    },
```

- [ ] **Step 5: 运行测试确认通过 + 检查 config-registry 测试**

Run: `cd server && npx vitest run src/__tests__/instant-fixed-mode.test.ts src/__tests__/config-registry.test.ts`
Expected: instant-fixed-mode PASS；config-registry 若因 deliveryModes 列表断言失败，按新列表更新其断言后重跑至 PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/orders/fulfillment.ts server/src/lib/businessRegistry.ts server/src/__tests__/instant-fixed-mode.test.ts server/src/__tests__/config-registry.test.ts
git commit -m "feat(delivery): register instant_fixed mode and isInstantMode helper"
```

---

### Task 3: createOrder 支持 instant_fixed（含 stockMode 库存语义）

**Files:**
- Modify: `server/src/modules/orders/service.ts:12-151`
- Test: `server/src/__tests__/orders-instant-fixed.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

测试 helper 约定（见 `server/src/__tests__/helpers.js` 既有用法）：`createTestUser(email, pass, role, points)`、`createTestMerchant(email, pass, opts)`、`loginAs(email, pass)`、`authHeader(token)`、`api`。

```typescript
import { describe, it, expect } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { api, createTestUser, createTestMerchant, loginAs, authHeader } from './helpers.js'

async function createFixedProduct(merchantId: number, overrides: Record<string, unknown> = {}) {
  return prisma.product.create({
    data: {
      name: '固定内容商品',
      type: '邀请码',
      price: 100,
      stock: 0,
      status: 'active',
      deliveryMode: 'instant_fixed',
      stockMode: 'unlimited',
      fixedContent: 'https://example.com/invite',
      fixedContentType: 'url',
      merchantId,
      ...overrides,
    },
  })
}

describe('createOrder for instant_fixed products', () => {
  it('delivers fixed content immediately without consuming InventoryItem', async () => {
    const { merchant } = await createTestMerchant('fixed-m1@test.local', 'pass123', {
      role: 'merchant', status: 'active', name: '固定内容商家',
    })
    await createTestUser('fixed-b1@test.local', 'buyer123', 'user', 5000)
    const product = await createFixedProduct(merchant.id)

    const buyer = await loginAs('fixed-b1@test.local', 'buyer123')
    const res = await api.post('/api/orders').set(authHeader(buyer.accessToken))
      .send({ productId: product.id }).expect(201)

    expect(res.body.status).toBe('delivered')
    expect(res.body.deliveryContent).toBe('https://example.com/invite')
    expect(res.body.deliveryContentType).toBe('url')

    const delivery = await prisma.deliveryRecord.findUnique({ where: { orderId: res.body.orderId } })
    expect(delivery?.content).toBe('https://example.com/invite')
    expect(delivery?.contentType).toBe('url')

    const after = await prisma.product.findUnique({ where: { id: product.id } })
    expect(after?.stock).toBe(0) // unlimited 不扣减
    expect(after?.sales).toBe(1)
    expect(await prisma.inventoryItem.count({ where: { productId: product.id } })).toBe(0)
  })

  it('decrements stock for limited instant_fixed and rejects when sold out', async () => {
    const { merchant } = await createTestMerchant('fixed-m2@test.local', 'pass123', {
      role: 'merchant', status: 'active', name: '限量固定商家',
    })
    await createTestUser('fixed-b2@test.local', 'buyer123', 'user', 5000)
    const product = await createFixedProduct(merchant.id, { stockMode: 'limited', stock: 1, fixedContentType: 'text', fixedContent: '固定文本内容' })

    const buyer = await loginAs('fixed-b2@test.local', 'buyer123')
    await api.post('/api/orders').set(authHeader(buyer.accessToken))
      .send({ productId: product.id }).expect(201)

    const after = await prisma.product.findUnique({ where: { id: product.id } })
    expect(after?.stock).toBe(0)

    const second = await api.post('/api/orders').set(authHeader(buyer.accessToken))
      .send({ productId: product.id }).expect(400)
    expect(second.body.error.message).toContain('库存不足')
  })

  it('rejects ordering an instant_fixed product without fixedContent', async () => {
    const { merchant } = await createTestMerchant('fixed-m3@test.local', 'pass123', {
      role: 'merchant', status: 'active', name: '缺内容商家',
    })
    await createTestUser('fixed-b3@test.local', 'buyer123', 'user', 5000)
    const product = await createFixedProduct(merchant.id, { fixedContent: null })

    const buyer = await loginAs('fixed-b3@test.local', 'buyer123')
    await api.post('/api/orders').set(authHeader(buyer.accessToken))
      .send({ productId: product.id }).expect(400)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd server && npx vitest run src/__tests__/orders-instant-fixed.test.ts`
Expected: FAIL（`getProductFulfillmentMode` 已认识 instant_fixed（Task 2），但订单 status 为 'pending'、无 deliveryContent）

- [ ] **Step 3: 修改 createOrder**

`server/src/modules/orders/service.ts` 顶部 import 增加 `isInstantMode`：

```typescript
import {
  createOrderStatusEvent,
  getProductFulfillmentMode,
  isInstantMode,
  normalizeOrderStatus,
  transitionOrderStatus,
} from './fulfillment.js'
```

L20 `getProductFulfillmentMode` 之后插入前置校验：

```typescript
    if (deliveryMode === 'instant_fixed' && !product.fixedContent) {
      throw badRequest('商品暂不可购买，请联系商家')
    }
    if (deliveryMode !== 'instant_inventory' && product.stockMode === 'limited' && product.stock <= 0) {
      throw badRequest('库存不足，请稍后再试')
    }
```

L61 订单状态改为：

```typescript
        status: isInstantMode(deliveryMode) ? 'delivered' : 'pending',
```

L77 `let deliveryContent` 处改为两个变量，并在 instant_inventory 分支（L79-105）之后追加 instant_fixed 分支：

```typescript
    let deliveryContent: string | undefined
    let deliveryContentType: string | undefined

    if (deliveryMode === 'instant_inventory') {
      // ...原有逻辑不变，仅在 deliveryContent = item.content 之后加一行：
      deliveryContentType = 'text'
    } else if (deliveryMode === 'instant_fixed') {
      deliveryContent = product.fixedContent!
      deliveryContentType = product.fixedContentType

      await tx.deliveryRecord.create({
        data: {
          orderId: order.id,
          userId,
          productId,
          content: product.fixedContent,
          contentType: product.fixedContentType,
          status: 'delivered',
          deliveredAt: new Date(),
        },
      })
    }
```

L132-137 商品库存/销量更新整块替换为：

```typescript
    if (deliveryMode === 'instant_inventory') {
      await tx.product.update({
        where: { id: productId },
        data: { stock: { decrement: 1 }, sales: { increment: 1 } },
      })
    } else if (product.stockMode === 'limited') {
      // 条件更新防并发超卖：stock>0 才扣减，失败即售罄
      const updated = await tx.product.updateMany({
        where: { id: productId, stock: { gt: 0 } },
        data: { stock: { decrement: 1 }, sales: { increment: 1 } },
      })
      if (updated.count !== 1) throw badRequest('库存不足，请稍后再试')
    } else {
      await tx.product.update({
        where: { id: productId },
        data: { sales: { increment: 1 } },
      })
    }
```

返回对象（L139-149）增加一行：

```typescript
      deliveryContentType,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && npx vitest run src/__tests__/orders-instant-fixed.test.ts src/__tests__/orders.test.ts`
Expected: 全部 PASS（orders.test.ts 验证 instant_inventory/manual_service 无回归）

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/orders/service.ts server/src/__tests__/orders-instant-fixed.test.ts
git commit -m "feat(orders): instant_fixed delivery with stockMode-aware stock handling"
```

---

### Task 4: 争议驳回泛化到所有即时模式

**Files:**
- Modify: `server/src/modules/merchant/service.ts:610-633`（respondToOrderDispute）
- Test: `server/src/__tests__/dispute-resume.test.ts`（追加用例）

- [ ] **Step 1: 在 dispute-resume.test.ts 追加失败测试**

```typescript
  it('resumes an instant_fixed disputed order back to delivered with content intact', async () => {
    const { merchant } = await createTestMerchant('dispute-fixed@test.local', 'pass123', {
      role: 'merchant', status: 'active', name: '固定内容争议商家',
    })
    await createTestUser('dispute-fixed-buyer@test.local', 'buyer123', 'user', 5000)
    const product = await prisma.product.create({
      data: {
        name: '固定内容争议商品', type: '邀请码', price: 100, stock: 0, status: 'active',
        deliveryMode: 'instant_fixed', stockMode: 'unlimited',
        fixedContent: 'FIXED-CONTENT-001', fixedContentType: 'text', merchantId: merchant.id,
      },
    })

    const buyer = await loginAs('dispute-fixed-buyer@test.local', 'buyer123')
    const created = await api.post('/api/orders').set(authHeader(buyer.accessToken))
      .send({ productId: product.id }).expect(201)
    const orderId = created.body.orderId

    await api.post(`/api/orders/${orderId}/dispute`).set(authHeader(buyer.accessToken)).expect(200)

    const merchantLogin = await loginAsMerchant('dispute-fixed@test.local', 'pass123')
    await api.post(`/api/merchant/orders/${orderId}/fulfillment/respond-dispute`)
      .set(authHeader(merchantLogin.accessToken))
      .send({ resolution: 'resume' }).expect(200)

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, delivery: { select: { content: true, contentType: true } } },
    })
    expect(order?.status).toBe('delivered')
    expect(order?.delivery?.content).toBe('FIXED-CONTENT-001')
    expect(order?.delivery?.contentType).toBe('text')
  })
```

- [ ] **Step 2: 运行确认失败**

Run: `cd server && npx vitest run src/__tests__/dispute-resume.test.ts`
Expected: 新用例 FAIL（resumeTarget 把 instant_fixed 当作 manual 回到 processing，违反 pending 不在 disputed 合法流转的断言或状态不符）

- [ ] **Step 3: 修改 respondToOrderDispute**

merchant/service.ts 顶部 import 增加 `isInstantMode`（从 `../orders/fulfillment.js`）。L618-620 替换为：

```typescript
    // 即时模式（instant_*）内容已交付，恢复履约直接回到 delivered；人工服务单回 processing 由商家重新交付
    const resumeTarget: FulfillmentOrderStatus =
      isInstantMode(order.product.deliveryMode) ? 'delivered' : 'processing'
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && npx vitest run src/__tests__/dispute-resume.test.ts`
Expected: 3 个用例全部 PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/merchant/service.ts server/src/__tests__/dispute-resume.test.ts
git commit -m "feat(merchant): dispute resume returns delivered for all instant modes"
```

---

### Task 5: 商家商品 schema 校验 + 创建/更新落库

**Files:**
- Modify: `server/src/modules/merchant/schema.ts:40-56`
- Modify: `server/src/modules/merchant/service.ts:275-292`（createMyProduct / updateMyProduct）
- Test: `server/src/modules/merchant/instant-fixed-product.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, it, expect } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { api, createTestMerchant, loginAsMerchant, authHeader } from '../../__tests__/helpers.js'

async function merchantToken(email: string) {
  await createTestMerchant(email, 'pass123', { role: 'merchant', status: 'active', name: `商家-${email}` })
  const login = await loginAsMerchant(email, 'pass123')
  return login.accessToken
}

const baseBody = {
  name: '邀请链接商品', type: '邀请码', price: 50,
  deliveryMode: 'instant_fixed',
  fixedContent: 'https://example.com/group-invite', fixedContentType: 'url',
  stockMode: 'unlimited',
}

describe('merchant instant_fixed product validation', () => {
  it('creates an unlimited instant_fixed product', async () => {
    const token = await merchantToken('if-create@test.local')
    const res = await api.post('/api/merchant/products').set(authHeader(token))
      .send(baseBody).expect(201)
    const product = await prisma.product.findUnique({ where: { id: res.body.id } })
    expect(product?.deliveryMode).toBe('instant_fixed')
    expect(product?.stockMode).toBe('unlimited')
    expect(product?.fixedContent).toBe('https://example.com/group-invite')
  })

  it('creates a limited instant_fixed product with stock', async () => {
    const token = await merchantToken('if-limited@test.local')
    const res = await api.post('/api/merchant/products').set(authHeader(token))
      .send({ ...baseBody, stockMode: 'limited', stock: 10 }).expect(201)
    const product = await prisma.product.findUnique({ where: { id: res.body.id } })
    expect(product?.stockMode).toBe('limited')
    expect(product?.stock).toBe(10)
  })

  it('rejects instant_fixed without fixedContent', async () => {
    const token = await merchantToken('if-nocontent@test.local')
    const { fixedContent: _omit, ...body } = baseBody
    await api.post('/api/merchant/products').set(authHeader(token)).send(body).expect(400)
  })

  it('rejects dangerous url protocols', async () => {
    const token = await merchantToken('if-xss@test.local')
    await api.post('/api/merchant/products').set(authHeader(token))
      .send({ ...baseBody, fixedContent: 'javascript:alert(1)' }).expect(400)
  })

  it('rejects limited stockMode without stock for instant_fixed', async () => {
    const token = await merchantToken('if-nostock@test.local')
    await api.post('/api/merchant/products').set(authHeader(token))
      .send({ ...baseBody, stockMode: 'limited' }).expect(400)
  })

  it('rejects unlimited stockMode for instant_inventory', async () => {
    const token = await merchantToken('if-inv@test.local')
    await api.post('/api/merchant/products').set(authHeader(token))
      .send({ name: '卡密', type: '充值卡密', price: 10, deliveryMode: 'instant_inventory', stockMode: 'unlimited' })
      .expect(400)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd server && npx vitest run src/modules/merchant/instant-fixed-product.test.ts`
Expected: FAIL（schema 拒绝未知字段或字段被忽略落库为空）

- [ ] **Step 3: 扩展 merchant/schema.ts**

在 `productStatusSchema` 之后新增：

```typescript
const stockModeSchema = z.enum(['limited', 'unlimited'])
const fixedContentTypeSchema = z.enum(['text', 'url'])
```

`createMerchantProductSchema` 增加四个字段（`deliveryMode` 行之后）：

```typescript
  stockMode: stockModeSchema.optional(),
  stock: z.number().int().min(0).max(1_000_000).optional(),
  fixedContent: z.string().trim().min(1).max(5000).optional(),
  fixedContentType: fixedContentTypeSchema.optional(),
```

（`updateMerchantProductSchema = createMerchantProductSchema.partial().extend(...)` 自动继承，无需改。交叉校验放 service 层，因 update 需合并现有商品状态。）

- [ ] **Step 4: 在 merchant/service.ts 新增校验函数并改写 create/update**

在 `// ---- Products ----` 区域新增：

```typescript
const HTTP_URL_PATTERN = /^https?:\/\/\S+$/i

function assertDeliveryConfig(config: {
  deliveryMode: string
  stockMode: string
  incomingStock?: number
  effectiveStock?: number
  fixedContent?: string | null
  fixedContentType: string
}) {
  if (config.deliveryMode === 'instant_inventory') {
    if (config.stockMode !== 'limited') throw badRequest('即时库存发货必须为限量库存')
    if (typeof config.incomingStock === 'number') throw badRequest('即时库存发货的库存请通过库存导入管理')
    return
  }
  if (config.deliveryMode === 'instant_fixed') {
    const content = config.fixedContent?.trim()
    if (!content) throw badRequest('固定内容交付必须填写交付内容')
    if (config.fixedContentType === 'url' && (content.length > 2048 || !HTTP_URL_PATTERN.test(content))) {
      throw badRequest('链接必须以 http(s):// 开头且不超过 2048 字符')
    }
  } else if (config.fixedContent != null) {
    throw badRequest('仅固定内容交付支持 fixedContent')
  }
  if (config.stockMode === 'limited' && typeof config.effectiveStock !== 'number') {
    throw badRequest('限量库存必须填写库存数量')
  }
}
```

`createMyProduct` 替换为：

```typescript
export async function createMyProduct(
  merchantId: number,
  data: {
    name: string; description?: string; richDescription?: string;
    type: string; icon?: string; imageUrl?: string; images?: string[];
    price: number; originalPrice?: number; isHot?: boolean; deliveryMode?: string;
    stockMode?: string; stock?: number; fixedContent?: string; fixedContentType?: string
  }
) {
  const deliveryMode = data.deliveryMode ?? 'instant_inventory'
  const stockMode = data.stockMode ?? (deliveryMode === 'instant_inventory' ? 'limited' : 'unlimited')
  const fixedContentType = data.fixedContentType ?? 'text'

  assertDeliveryConfig({
    deliveryMode,
    stockMode,
    incomingStock: data.stock,
    effectiveStock: data.stock,
    fixedContent: data.fixedContent,
    fixedContentType,
  })

  return prisma.product.create({
    data: {
      ...data,
      deliveryMode,
      stockMode,
      fixedContentType,
      stock: deliveryMode === 'instant_inventory' ? 0 : (data.stock ?? 0),
      merchantId,
    },
  })
}
```

`updateMyProduct` 替换为：

```typescript
export async function updateMyProduct(merchantId: number, productId: number, data: Record<string, unknown>) {
  const product = await prisma.product.findFirst({ where: { id: productId, merchantId } })
  if (!product) throw notFound('商品不存在')

  const deliveryMode = (data.deliveryMode as string | undefined) ?? product.deliveryMode
  const stockMode = (data.stockMode as string | undefined)
    ?? (deliveryMode !== product.deliveryMode
      ? (deliveryMode === 'instant_inventory' ? 'limited' : 'unlimited')
      : product.stockMode)
  const incomingStock = typeof data.stock === 'number' ? data.stock : undefined

  assertDeliveryConfig({
    deliveryMode,
    stockMode,
    incomingStock,
    effectiveStock: incomingStock ?? product.stock,
    fixedContent: 'fixedContent' in data ? (data.fixedContent as string | null) : product.fixedContent,
    fixedContentType: (data.fixedContentType as string | undefined) ?? product.fixedContentType,
  })

  return prisma.product.update({
    where: { id: productId },
    data: { ...data, deliveryMode, stockMode },
  })
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd server && npx vitest run src/modules/merchant/instant-fixed-product.test.ts src/__tests__/merchant.test.ts src/modules/merchant/product-images.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/merchant/schema.ts server/src/modules/merchant/service.ts server/src/modules/merchant/instant-fixed-product.test.ts
git commit -m "feat(merchant): validate and persist instant_fixed delivery config"
```

---

### Task 6: 库存导入/作废仅限 instant_inventory（商家 + 管理员）

**Files:**
- Modify: `server/src/modules/merchant/service.ts`（previewMyInventoryImport L256-273、importMyInventory L294-335、voidMyInventory L337-387）
- Modify: `server/src/modules/admin/service.ts:229`（importInventory）
- Test: `server/src/modules/merchant/instant-fixed-product.test.ts`（追加用例）

- [ ] **Step 1: 追加失败测试**

```typescript
  it('rejects inventory import for instant_fixed products', async () => {
    const token = await merchantToken('if-noimport@test.local')
    const created = await api.post('/api/merchant/products').set(authHeader(token))
      .send(baseBody).expect(201)

    await api.post(`/api/merchant/products/${created.body.id}/inventory/preview`)
      .set(authHeader(token)).send({ text: 'CARD-001' }).expect(400)
    await api.post(`/api/merchant/products/${created.body.id}/inventory`)
      .set(authHeader(token)).send({ text: 'CARD-001' }).expect(400)
    await api.post(`/api/merchant/products/${created.body.id}/inventory/void`)
      .set(authHeader(token)).send({ count: 1 }).expect(400)
  })
```

（路由路径以 `server/src/modules/merchant/routes.ts:26-38` 实际为准，写测试前先核对。）

- [ ] **Step 2: 运行确认失败**

Run: `cd server && npx vitest run src/modules/merchant/instant-fixed-product.test.ts`
Expected: 新用例 FAIL（当前返回 200/201）

- [ ] **Step 3: 加守卫**

merchant/service.ts 三个函数中，把商品查询 `select: { id: true }` 改为 `select: { id: true, deliveryMode: true }`，并在 `if (!product) throw notFound(...)` 之后统一加：

```typescript
  if (product.deliveryMode !== 'instant_inventory') {
    throw badRequest('仅即时库存发货商品支持库存管理')
  }
```

admin/service.ts `importInventory`（L229）在事务开始前加载商品并加同样守卫：

```typescript
export async function importInventory(productId: number, items: string[], adminUserId: number) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, deliveryMode: true },
  })
  if (!product) throw notFound('商品不存在')
  if (product.deliveryMode !== 'instant_inventory') {
    throw badRequest('仅即时库存发货商品支持库存管理')
  }
  // ...原有事务逻辑不变
```

（确认 admin/service.ts 已 import `badRequest`/`notFound`，缺则补。）

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && npx vitest run src/modules/merchant/instant-fixed-product.test.ts src/modules/merchant/inventory.test.ts src/modules/admin/admin-query.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/merchant/service.ts server/src/modules/admin/service.ts server/src/modules/merchant/instant-fixed-product.test.ts
git commit -m "feat(inventory): restrict inventory operations to instant_inventory products"
```

---

### Task 7: 低库存重构 + 序列化（含 fixedContent 泄漏防护）

**Files:**
- Modify: `server/src/modules/merchant/service.ts:124-152`（isLowStockProduct / serializeMerchantProduct）
- Modify: `server/src/modules/products/service.ts:20-35,128-139`（productListSelect / getProductDetail）
- Modify: `server/src/modules/orders/service.ts:159`（getOrderDetail delivery select）
- Test: `server/src/modules/merchant/instant-fixed-product.test.ts`（追加）、`server/src/modules/products/images.test.ts` 所在目录新建 `server/src/modules/products/public-fields.test.ts`

- [ ] **Step 1: 写失败测试（公开端点不泄漏 fixedContent + 透出 stockMode）**

`server/src/modules/products/public-fields.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { api } from '../../__tests__/helpers.js'

describe('public product endpoints with instant_fixed', () => {
  it('never exposes fixedContent and includes stockMode/deliveryMode', async () => {
    const product = await prisma.product.create({
      data: {
        name: '公开字段商品', type: '邀请码', price: 100, stock: 0, status: 'active',
        deliveryMode: 'instant_fixed', stockMode: 'unlimited',
        fixedContent: 'SECRET-PAID-CONTENT', fixedContentType: 'url',
      },
    })

    const detail = await api.get(`/api/products/${product.id}`).expect(200)
    expect(JSON.stringify(detail.body)).not.toContain('SECRET-PAID-CONTENT')
    expect(detail.body.stockMode).toBe('unlimited')
    expect(detail.body.deliveryMode).toBe('instant_fixed')

    const list = await api.get('/api/products').expect(200)
    expect(JSON.stringify(list.body)).not.toContain('SECRET-PAID-CONTENT')
  })
})
```

（公开路由路径以 `server/src/modules/products/routes.ts` 实际为准。）

merchant 测试追加低库存用例：

```typescript
  it('flags limited instant_fixed products as lowStock by Product.stock', async () => {
    const token = await merchantToken('if-lowstock@test.local')
    await api.post('/api/merchant/products').set(authHeader(token))
      .send({ ...baseBody, name: '低库存固定商品', stockMode: 'limited', stock: 2 }).expect(201)

    const list = await api.get('/api/merchant/products?lowStock=true').set(authHeader(token)).expect(200)
    const found = list.body.items.find((p: { name: string }) => p.name === '低库存固定商品')
    expect(found).toBeTruthy()
    expect(found.lowStock).toBe(true)
    expect(found.stockMode).toBe('limited')
  })
```

- [ ] **Step 2: 运行确认失败**

Run: `cd server && npx vitest run src/modules/products/public-fields.test.ts src/modules/merchant/instant-fixed-product.test.ts`
Expected: FAIL（detail 泄漏 SECRET-PAID-CONTENT；lowStock 为 false）

- [ ] **Step 3: 实现**

products/service.ts `productListSelect` 增加：

```typescript
  deliveryMode: true,
  stockMode: true,
```

`getProductDetail` 末尾返回前剔除付费内容：

```typescript
  const { fixedContent: _fixedContent, ...publicProduct } = product
  return publicProduct
```

merchant/service.ts `isLowStockProduct` 替换为：

```typescript
function isLowStockProduct(product: ProductWithAvailableStock, threshold: number) {
  if (product.stockMode !== 'limited') return false
  if (product.deliveryMode === 'instant_inventory') return product._count.inventory <= threshold
  if (product.deliveryMode === 'instant_fixed') return product.stock <= threshold
  return false // manual_service 不参与低库存提醒
}
```

`serializeMerchantProduct` 返回对象增加（商家可见自己的 fixedContent，用于编辑回填）：

```typescript
    stockMode: product.stockMode,
    fixedContent: product.fixedContent,
    fixedContentType: product.fixedContentType,
```

orders/service.ts `getOrderDetail` 的 delivery select（L159）增加 `contentType: true`：

```typescript
      delivery: { select: { status: true, content: true, contentType: true, publicNote: true, deliveredAt: true } },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && npx vitest run src/modules/products/public-fields.test.ts src/modules/merchant/instant-fixed-product.test.ts src/__tests__/orders.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 跑 server 全量测试**

Run: `cd server && npm test`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/merchant/service.ts server/src/modules/products/service.ts server/src/modules/orders/service.ts server/src/modules/products/public-fields.test.ts server/src/modules/merchant/instant-fixed-product.test.ts
git commit -m "feat(delivery): stockMode-aware low stock, contentType in order detail, guard fixedContent leak"
```

---

### Task 8: 前端类型与 API 层

**Files:**
- Modify: `src/types/order.ts`（UserOrderDetail.delivery）
- Modify: `src/types/merchant.ts`（MerchantProduct）
- Modify: `src/api/orders.ts`（createOrder 响应类型，若有显式类型）

- [ ] **Step 1: types/order.ts** — `UserOrderDetail` 的 delivery 增加 `contentType?: string`：

```typescript
  delivery: null | {
    status: string
    content: string
    contentType?: string
    publicNote?: string | null
    deliveredAt?: string | null
  }
```

- [ ] **Step 2: types/merchant.ts** — `MerchantProduct` 接口增加：

```typescript
  stockMode: string
  fixedContent?: string | null
  fixedContentType?: string
```

- [ ] **Step 3: src/api/orders.ts** — 若 createOrder 返回值有显式类型，增加 `deliveryContentType?: string`；若是宽松类型则跳过。

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`（在仓库根目录）
Expected: 无新增错误

- [ ] **Step 5: Commit**

```bash
git add src/types/order.ts src/types/merchant.ts src/api/orders.ts
git commit -m "feat(types): stockMode and delivery contentType in frontend contracts"
```

---

### Task 9: 商家发布表单按模式条件渲染

**Files:**
- Modify: `src/components/merchant/MerchantProductFormModal.tsx`

- [ ] **Step 1: 扩展 form state（L26-38）**

```typescript
  const [form, setForm] = useState({
    // ...原有字段不变，追加：
    stockMode: 'unlimited',
    stock: '',
    fixedContent: '',
    fixedContentType: 'text'
  })
```

编辑回填（L49-61 product 分支）追加：

```typescript
          stockMode: product.stockMode || (product.deliveryMode === 'instant_inventory' ? 'limited' : 'unlimited'),
          stock: typeof product.stock === 'number' ? product.stock.toString() : '',
          fixedContent: product.fixedContent || '',
          fixedContentType: product.fixedContentType || 'text'
```

新建分支（L66-78）追加相同四字段的默认值（`stockMode: 'unlimited', stock: '', fixedContent: '', fixedContentType: 'text'`）。

- [ ] **Step 2: 在「基本属性」FormSection 内、发货模式 radio 之后插入条件区块**

```tsx
                {form.deliveryMode === 'instant_fixed' && (
                  <div className="md:col-span-2 space-y-4 border-t border-[var(--color-border)] pt-4">
                    <div>
                      <FieldLabel required>交付内容类型</FieldLabel>
                      <div className="flex gap-4 items-center">
                        {([['text', '固定文本'], ['url', '外部链接']] as const).map(([value, label]) => (
                          <label key={value} className="flex items-center gap-2 cursor-pointer text-sm">
                            <input
                              type="radio"
                              name="fixedContentType"
                              value={value}
                              checked={form.fixedContentType === value}
                              onChange={(e) => setForm({ ...form, fixedContentType: e.target.value })}
                              className="w-4 h-4 text-[var(--color-primary)] border-[var(--color-border)] focus:ring-[var(--color-primary)]"
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                    </div>
                    <div>
                      <FieldLabel required>交付内容（每位买家收到同一份）</FieldLabel>
                      {form.fixedContentType === 'url' ? (
                        <input
                          type="url"
                          placeholder="https://example.com/invite"
                          className="input font-mono text-xs"
                          value={form.fixedContent}
                          onChange={(e) => setForm({ ...form, fixedContent: e.target.value })}
                          data-testid="fixed-content-input"
                        />
                      ) : (
                        <textarea
                          placeholder="买家付款后立即收到的内容，如群邀请说明、会员权益说明..."
                          className="input min-h-[80px] resize-y font-mono text-xs"
                          value={form.fixedContent}
                          onChange={(e) => setForm({ ...form, fixedContent: e.target.value })}
                          data-testid="fixed-content-input"
                        />
                      )}
                    </div>
                  </div>
                )}
                {form.deliveryMode !== 'instant_inventory' && (
                  <div className="md:col-span-2 grid grid-cols-2 gap-5">
                    <div>
                      <FieldLabel required>库存模式</FieldLabel>
                      <select
                        className="input appearance-none cursor-pointer"
                        value={form.stockMode}
                        onChange={(e) => setForm({ ...form, stockMode: e.target.value })}
                        data-testid="stock-mode-select"
                      >
                        <option value="unlimited">不限库存</option>
                        <option value="limited">限量</option>
                      </select>
                    </div>
                    {form.stockMode === 'limited' && (
                      <div>
                        <FieldLabel required>库存数量</FieldLabel>
                        <input
                          type="number"
                          step="1"
                          min="0"
                          className="input font-mono"
                          value={form.stock}
                          onChange={(e) => setForm({ ...form, stock: e.target.value })}
                          data-testid="stock-input"
                        />
                      </div>
                    )}
                  </div>
                )}
```

- [ ] **Step 3: handleSubmit 校验与 payload（L152-206）**

价格校验之后追加：

```typescript
    if (form.deliveryMode === 'instant_fixed' && !form.fixedContent.trim()) {
      showToast('固定内容交付必须填写交付内容', 'error')
      return
    }
    if (form.deliveryMode === 'instant_fixed' && form.fixedContentType === 'url' && !/^https?:\/\//i.test(form.fixedContent.trim())) {
      showToast('链接必须以 http(s):// 开头', 'error')
      return
    }
    let stockNum: number | undefined
    if (form.deliveryMode !== 'instant_inventory' && form.stockMode === 'limited') {
      stockNum = Number(form.stock)
      if (!Number.isInteger(stockNum) || stockNum < 0) {
        showToast('限量库存必须填写有效数量', 'error')
        return
      }
    }
```

payload 构造追加：

```typescript
    if (payload.deliveryMode !== 'instant_inventory') {
      payload.stockMode = form.stockMode
      if (stockNum !== undefined) payload.stock = stockNum
    }
    if (payload.deliveryMode === 'instant_fixed') {
      payload.fixedContent = form.fixedContent.trim()
      payload.fixedContentType = form.fixedContentType
    }
```

- [ ] **Step 4: 切换 deliveryMode 时同步重置 stockMode**

发货模式 radio 的 onChange（L284）改为：

```typescript
                            onChange={(e) => setForm({
                              ...form,
                              deliveryMode: e.target.value,
                              stockMode: e.target.value === 'instant_inventory' ? 'limited' : form.stockMode,
                            })}
```

- [ ] **Step 5: 类型检查 + 手测**

Run: `npx tsc --noEmit && npm run dev`（另启 server）
手测：商家后台发布 instant_fixed（链接型）商品成功；切换模式时表单区块正确显隐；instant_inventory 不显示库存模式区块。

- [ ] **Step 6: Commit**

```bash
git add src/components/merchant/MerchantProductFormModal.tsx
git commit -m "feat(merchant-ui): instant_fixed content and stockMode fields in product form"
```

---

### Task 10: 订单展示按 contentType 渲染（用户侧）

**Files:**
- Modify: `src/components/OrderDetailModal.tsx:107-130`
- Modify: `src/components/SuccessModal.tsx`
- Modify: `src/pages/ProductDetailPage.tsx`

- [ ] **Step 1: OrderDetailModal 发货内容区**

L112-115 的内容渲染替换为：

```tsx
            {order.delivery?.content ? (
              order.delivery.contentType === 'url' ? (
                <div className="bg-[var(--color-surface)] p-3 rounded border border-[var(--color-border)] text-xs leading-relaxed break-all">
                  <a
                    href={order.delivery.content}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--color-primary)] underline font-mono"
                    data-testid="delivery-link"
                  >
                    {order.delivery.content}
                  </a>
                </div>
              ) : (
                <div className="bg-[var(--color-surface)] p-3 rounded border border-[var(--color-border)] font-mono text-xs text-[var(--color-text)] leading-relaxed break-all whitespace-pre-wrap select-all max-h-48 overflow-y-auto">
                  {order.delivery.content}
                </div>
              )
            ) : order.deliveryMode === 'manual_service' ? (
```

（后续两个空态分支不变。）

- [ ] **Step 2: SuccessModal 增加 contentType 支持**

Props 增加 `deliveryContentType?: string`，内容区（L40-42）替换为：

```tsx
          {deliveryContentType === 'url' ? (
            <a
              href={deliveryContent}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-sm break-all text-[var(--color-primary)] underline block bg-[var(--color-surface)] p-3 rounded border border-[var(--color-border)] leading-relaxed"
              data-testid="success-delivery-link"
            >
              {deliveryContent}
            </a>
          ) : (
            <div className="font-mono text-sm break-all text-[var(--color-text)] select-all bg-[var(--color-surface)] p-3 rounded border border-[var(--color-border)] leading-relaxed whitespace-pre-wrap">
              {deliveryContent}
            </div>
          )}
```

- [ ] **Step 3: ProductDetailPage**

本地 Product 接口（L23 附近）增加 `stockMode?: string`；新增 state：

```typescript
  const [deliveryContentType, setDeliveryContentType] = useState<string | undefined>(undefined)
```

购买成功回调（L65 附近）追加 `setDeliveryContentType(data.deliveryContentType)`；
L112 售罄判断改为：

```typescript
  const isSoldOut = product.stockMode !== 'unlimited' && product.stock === 0
```

L208 库存展示改为：

```tsx
                  库存: <span className="text-[var(--color-text)] font-bold">{product.stockMode === 'unlimited' ? '不限' : product.stock}</span>
```

SuccessModal 调用处（L341）传入 `deliveryContentType={deliveryContentType}`。

- [ ] **Step 4: 类型检查 + 浏览器验证**

Run: `npx tsc --noEmit`
启动前后端，完整手测黄金路径：商家发布 instant_fixed 链接商品 → 用户购买 → 成功弹窗显示可点击链接 → 个人中心订单详情显示链接 + 复制按钮可用 → 旧卡密订单详情仍正常显示文本块（回归）。

- [ ] **Step 5: Commit**

```bash
git add src/components/OrderDetailModal.tsx src/components/SuccessModal.tsx src/pages/ProductDetailPage.tsx
git commit -m "feat(ui): render delivery content by contentType, unlimited stock display"
```

---

### Task 11: e2e 全链路测试

**Files:**
- Create: `e2e/instant-fixed.spec.ts`

- [ ] **Step 1: 先读 `e2e/product-exchange.spec.ts` 与 `e2e/merchant-inventory.spec.ts`**，对齐既有选择器与流程写法（登录用 `helpers.ts` 的 `loginAs(page, SEED_ACCOUNTS.merchant)`）。

- [ ] **Step 2: 编写 spec（按既有写法调整选择器细节）**

覆盖场景：

1. merchant 登录 → 商家后台发布 instant_fixed 商品（类型「邀请码」，交付内容类型「外部链接」，填 `https://example.com/e2e-invite`，库存模式「不限」）→ 列表出现该商品。
2. user 登录 → 商店进入该商品详情 → 库存显示「不限」→ 购买 → 成功弹窗出现 `data-testid="success-delivery-link"` 且 href 正确。
3. 个人中心订单详情 → `data-testid="delivery-link"` 可见 → 发起争议（`order-dispute-button` → `dispute-dialog-confirm`）。
4. merchant 后台对该订单驳回争议（resume）→ user 刷新订单详情状态回到「已交付」。

骨架（选择器以 Step 1 读到的实际写法为准修正）：

```typescript
import { test, expect } from '@playwright/test'
import { loginAs, SEED_ACCOUNTS } from './helpers'

const PRODUCT_NAME = `E2E固定内容商品-${Date.now()}`
const INVITE_URL = 'https://example.com/e2e-invite'

test.describe.serial('instant_fixed delivery flow', () => {
  test('merchant publishes an instant_fixed url product', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.merchant)
    // 进入商家后台商品 Tab → 发布新商品（参照 merchant-inventory.spec.ts 的导航写法）
    // 填写名称/类型/价格 → 选「固定内容直发」radio → 选「外部链接」→ fixed-content-input 填 INVITE_URL
    // stock-mode-select 保持 unlimited → 提交 → 断言列表出现 PRODUCT_NAME
  })

  test('user buys and receives clickable link, dispute resume restores delivered', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    // 商店搜索/找到 PRODUCT_NAME → 详情页断言「不限」→ 购买（参照 product-exchange.spec.ts）
    await expect(page.getByTestId('success-delivery-link')).toHaveAttribute('href', INVITE_URL)
    // 个人中心订单详情 → delivery-link 可见 → 发起争议
  })
})
```

- [ ] **Step 3: 运行 e2e**

Run: `npx playwright test e2e/instant-fixed.spec.ts`
Expected: PASS（需前后端与 seed 数据按既有 e2e 约定启动）

- [ ] **Step 4: 跑全量 e2e 防回归**

Run: `npx playwright test`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add e2e/instant-fixed.spec.ts
git commit -m "test(e2e): instant_fixed publish, purchase, link delivery and dispute resume"
```

---

## 完成定义（DoD）

- `cd server && npm test` 全绿；`npx tsc --noEmit` 无错；`npx playwright test` 全绿。
- 公开商品 list/detail 响应中不出现 fixedContent（Task 7 测试守住）。
- 旧商品（instant_inventory / manual_service）购买、争议、结算流程零回归。
- 不改动：Settlement 门控、InventoryReservation（属现金支付 Phase 2，仅在设计文档预埋约束）。
