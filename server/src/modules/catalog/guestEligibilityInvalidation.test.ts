import { describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import {
  createTestMerchant,
  createTestProduct,
  createTestUser,
  loginAs,
  api,
  authHeader,
} from '../../__tests__/helpers.js'
import { lockProductRow } from '../catalog/productLock.js'
import { invalidateGuestEligibility, touchesPublicContent } from '../catalog/guestEligibility.js'

/**
 * SPEC-CATALOG-VIS-001 §4.4 / §4.5 / §4.8.2（P1.5-A）——写入口失效。
 *
 * 要证明两件事：
 *   1. **展示字段**变化会让旧批准失效（revision 递增 + decision→pending）；
 *   2. **价格/库存**变化不触发失效（§4.4 明确排除）。
 *
 * 断言都写在**用户可见的状态**上——即 ProductGuestEligibility 与
 * Product.publicContentRevision 的真实行，而不是只断言函数返回值。
 */

async function seedApprovedProduct(name = '已批准商品') {
  const product = await createTestProduct(name, 50, 3, ['A-1', 'A-2', 'A-3'])
  await prisma.product.update({
    where: { id: product.id },
    data: { visibility: 'public', publicContentRevision: 1 },
  })
  // helpers.createTestProduct 现在自带一条 approved 记录（见该函数注释），
  // 这里把它对齐到 revision=1，而不是再插一条（productId 唯一）。
  await prisma.productGuestEligibility.update({
    where: { productId: product.id },
    data: { decision: 'approved', reviewedRevision: 1, version: 1 },
  })
  return product
}

async function readState(productId: number) {
  const product = await prisma.product.findUniqueOrThrow({
    where: { id: productId },
    select: { publicContentRevision: true },
  })
  const eligibility = await prisma.productGuestEligibility.findUnique({
    where: { productId },
    select: { decision: true, reviewedRevision: true, version: true, reasonCode: true },
  })
  return { revision: product.publicContentRevision, eligibility }
}

describe('SPEC-CATALOG-VIS-001 §4.4 展示字段判定', () => {
  it('名称/描述/details/分类/图片/visibility 触发；价格/库存/销量不触发', () => {
    for (const field of ['name', 'description', 'richDescription', 'details', 'attributes',
      'categoryId', 'type', 'icon', 'imageUrl', 'images', 'templateKey', 'templateVersion',
      'visibility']) {
      expect(touchesPublicContent({ [field]: 'x' }), field).toBe(true)
    }
    for (const field of ['price', 'stock', 'sales', 'ratingAvg', 'ratingCount', 'internalNote',
      'deliveryMode', 'stockMode']) {
      expect(touchesPublicContent({ [field]: 1 }), field).toBe(false)
    }
  })
})

describe('SPEC-CATALOG-VIS-001 §4.5 失效原子性', () => {
  it('无记录的商品被失效时创建 pending，reviewedRevision 为空', async () => {
    const product = await createTestProduct('无准入记录商品', 10, 1, ['N-1'])
    // helper 自带一条 approved；本用例要验证"无记录 → 创建 pending"，
    // 因此先删掉它。
    await prisma.productGuestEligibility.delete({ where: { productId: product.id } })

    await prisma.$transaction(async tx => {
      await lockProductRow(tx, product.id)
      const result = await invalidateGuestEligibility(tx, product.id)
      expect(result.created).toBe(true)
    })

    const state = await readState(product.id)
    expect(state.revision).toBe(2)
    expect(state.eligibility).toMatchObject({
      decision: 'pending',
      reviewedRevision: null,
    })
  })

  it('已批准商品失效后 decision→pending 且 reviewedRevision 保留原值', async () => {
    const product = await seedApprovedProduct('失效保留版本商品')
    expect(await readState(product.id)).toMatchObject({
      revision: 1,
      eligibility: { decision: 'approved', reviewedRevision: 1, version: 1 },
    })

    await prisma.$transaction(async tx => {
      await lockProductRow(tx, product.id)
      await invalidateGuestEligibility(tx, product.id)
    })

    const state = await readState(product.id)
    // revision 递增 → 与 reviewedRevision(1) 不再相等 → 批准自然失效。
    expect(state.revision).toBe(2)
    // pending + 保留 reviewedRevision：记录的是"上次审的是 v1"。
    expect(state.eligibility).toMatchObject({
      decision: 'pending',
      reviewedRevision: 1,
      reasonCode: 'content_changed',
    })
    // version 递增：持有旧 version 的审批操作必须 409。
    expect(state.eligibility!.version).toBe(2)
  })

  it('重复失效只保留一条当前记录（不因重复保存生成多条待办）', async () => {
    const product = await seedApprovedProduct('重复失效商品')
    for (let i = 0; i < 3; i += 1) {
      await prisma.$transaction(async tx => {
        await lockProductRow(tx, product.id)
        await invalidateGuestEligibility(tx, product.id)
      })
    }
    const count = await prisma.productGuestEligibility.count({ where: { productId: product.id } })
    expect(count).toBe(1)
    const state = await readState(product.id)
    expect(state.revision).toBe(4) // 1 + 3 次递增
    // version 同步递增 3 次（初始 1）。
    expect(state.eligibility!.version).toBe(4)
  })
})

describe('SPEC-CATALOG-VIS-001 §4.4 真实写入口', () => {
  it('商家编辑商品名称 → revision 递增且批准失效', async () => {
    const { merchant } = await createTestMerchant('p15-merchant@test.local', 'pass123', {
      role: 'merchant', status: 'active', name: 'P15商家',
    })
    const product = await createTestProduct('商家待改商品', 50, 2, ['M-1', 'M-2'], merchant.id)
    await prisma.product.update({
      where: { id: product.id },
      data: { visibility: 'public', publicContentRevision: 1 },
    })
    await prisma.productGuestEligibility.update({
      where: { productId: product.id },
      data: { decision: 'approved', reviewedRevision: 1, version: 1 },
    })

    const { accessToken } = await loginAs('p15-merchant@test.local', 'pass123')
    // 商家编辑走 PUT /api/merchant/products/:id（路由定义见 merchant/routes.ts:59）。
    const res = await api
      .put(`/api/merchant/products/${product.id}`)
      .set(authHeader(accessToken))
      .send({ name: '商家改名后商品' })
    expect(res.status).toBe(200)

    const state = await readState(product.id)
    expect(state.revision).toBe(2)
    expect(state.eligibility!.decision).toBe('pending')
    // reviewedRevision 保留原值 1（记录"上次审的是 v1"）。
    expect(state.eligibility!.reviewedRevision).toBe(1)
  })

  it('纯价格编辑不递增 revision、不撤销批准', async () => {
    const { merchant } = await createTestMerchant('p15-price@test.local', 'pass123', {
      role: 'merchant', status: 'active', name: 'P15价格商家',
    })
    const product = await createTestProduct('价格编辑商品', 50, 2, ['P-1', 'P-2'], merchant.id)
    await prisma.product.update({
      where: { id: product.id },
      data: { visibility: 'public', publicContentRevision: 1 },
    })
    await prisma.productGuestEligibility.update({
      where: { productId: product.id },
      data: { decision: 'approved', reviewedRevision: 1, version: 1 },
    })

    const { accessToken } = await loginAs('p15-price@test.local', 'pass123')
    const res = await api
      .put(`/api/merchant/products/${product.id}`)
      .set(authHeader(accessToken))
      .send({ price: 88 })
    expect(res.status).toBe(200)

    const state = await readState(product.id)
    // §4.4：价格不在审核内容中 → 不递增、不撤销。
    expect(state.revision).toBe(1)
    expect(state.eligibility!.decision).toBe('approved')
    // 但价格确实变了（确认这次请求真的改到了东西，不是空操作）。
    const offer = await prisma.offer.findFirstOrThrow({
      where: { productId: product.id, isDefault: true },
      select: { price: true },
    })
    expect(offer.price).toBe(88)
  })
})
