import { describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import {
  api,
  authHeader,
  createTestMerchant,
  createTestProduct,
  createTestUser,
  loginAs,
} from '../../__tests__/helpers.js'

/**
 * SPEC-CATALOG-VIS-001 §4.4（P1.5-A 复审阻塞项 1）——套餐写入口的失效覆盖。
 *
 * 复审指出的漏洞链：
 *   上游同步一个 inactive 套餐 → 管理员启用它 → 未经审核的套餐名称出现在
 *   已批准的公开商品上，游客能看到。
 *
 * 根因是「启用」这个动作没有触发失效。本文件在 **HTTP 层**驱动各写入口，
 * 断言落在真实数据行（Product.publicContentRevision 与
 * ProductGuestEligibility.decision），而不是只看返回值。
 */

async function seedApprovedProductForMerchant(name: string) {
  const { merchant, user } = await createTestMerchant(
    `p15-offer-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
    'pass123',
    { role: 'merchant', status: 'active', name: 'P15套餐商家' },
  )
  const product = await createTestProduct(name, 50, 2, ['O-1', 'O-2'], merchant.id)
  await prisma.product.update({
    where: { id: product.id },
    data: { visibility: 'public', publicContentRevision: 1 },
  })
  await prisma.productGuestEligibility.update({
    where: { productId: product.id },
    data: { decision: 'approved', reviewedRevision: 1, version: 1 },
  })
  return { product, merchant, merchantUserId: user.id }
}

async function readState(productId: number) {
  const product = await prisma.product.findUniqueOrThrow({
    where: { id: productId },
    select: { publicContentRevision: true },
  })
  const eligibility = await prisma.productGuestEligibility.findUniqueOrThrow({
    where: { productId },
    select: { decision: true, reviewedRevision: true, version: true },
  })
  return { revision: product.publicContentRevision, eligibility }
}

async function adminToken() {
  const email = `p15-offer-admin-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`
  await createTestUser(email, 'admin123', 'admin')
  const { accessToken } = await loginAs(email, 'admin123')
  return accessToken
}

describe('SPEC-CATALOG-VIS-001 §4.4 商家套餐写入口', () => {
  it('商家新建 active 套餐 → 失效（此前完全未接入）', async () => {
    const { product } = await seedApprovedProductForMerchant('商家新建套餐商品')
    const before = await readState(product.id)
    expect(before.revision).toBe(1)

    const { accessToken } = await loginAs(
      (await prisma.merchant.findUniqueOrThrow({
        where: { id: product.merchantId! },
        select: { user: { select: { email: true } } },
      })).user.email,
      'pass123',
    )

    const res = await api
      .post(`/api/merchant/products/${product.id}/offers`)
      .set(authHeader(accessToken))
      .send({
        name: '新套餐',
        price: 60,
        status: 'active',
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
        stock: 0,
      })
    expect(res.status).toBe(201)

    const after = await readState(product.id)
    expect(after.revision).toBe(2)
    expect(after.eligibility.decision).toBe('pending')
  })

  it('商家修改套餐名称 → 失效；同值重提 → 不失效', async () => {
    const { product } = await seedApprovedProductForMerchant('商家改套餐名商品')
    const offer = await prisma.offer.findFirstOrThrow({
      where: { productId: product.id, isDefault: true },
      select: { id: true, name: true },
    })
    const email = (await prisma.merchant.findUniqueOrThrow({
      where: { id: product.merchantId! },
      select: { user: { select: { email: true } } },
    })).user.email
    const { accessToken } = await loginAs(email, 'pass123')

    // 同值重提：不应失效。
    const same = await api
      .put(`/api/merchant/products/${product.id}/offers/${offer.id}`)
      .set(authHeader(accessToken))
      .send({ name: offer.name })
    expect(same.status).toBe(200)
    const unchanged = await readState(product.id)
    expect(unchanged.revision).toBe(1)
    expect(unchanged.eligibility.decision).toBe('approved')

    // 改名：应失效。
    const renamed = await api
      .put(`/api/merchant/products/${product.id}/offers/${offer.id}`)
      .set(authHeader(accessToken))
      .send({ name: '改过的套餐名' })
    expect(renamed.status).toBe(200)
    const changed = await readState(product.id)
    expect(changed.revision).toBe(2)
    expect(changed.eligibility.decision).toBe('pending')
  })
})

describe('SPEC-CATALOG-VIS-001 §4.4 管理员启用套餐（复审指出的漏洞链）', () => {
  it('inactive → active 启用未审核套餐 → 失效', async () => {
    const { product } = await seedApprovedProductForMerchant('管理员启用套餐商品')
    const offer = await prisma.offer.findFirstOrThrow({
      where: { productId: product.id, isDefault: true },
      select: { id: true },
    })
    // 模拟「上游同步了 inactive 套餐」。
    await prisma.offer.update({ where: { id: offer.id }, data: { status: 'inactive' } })

    const token = await adminToken()
    const res = await api
      .post(`/api/admin/products/${product.id}/offers/${offer.id}/restore`)
      .set(authHeader(token))
      .send({})
    expect(res.status).toBe(200)

    const after = await readState(product.id)
    // 漏洞链在此闭合：启用后旧批准失效，未经审核的套餐名不会出现在
    // 已批准的公开商品上。
    expect(after.revision).toBe(2)
    expect(after.eligibility.decision).toBe('pending')
  })
})

describe('SPEC-CATALOG-VIS-001 §4.4 归档套餐不改展示内容', () => {
  it('归档（active → inactive）不触发失效', async () => {
    const { product } = await seedApprovedProductForMerchant('归档套餐商品')
    const offer = await prisma.offer.findFirstOrThrow({
      where: { productId: product.id, isDefault: true },
      select: { id: true },
    })
    // 非默认套餐才能直接归档。
    const extra = await prisma.offer.create({
      data: {
        productId: product.id, name: '可归档套餐', price: 70, status: 'active',
        deliveryMode: 'manual_service', stockMode: 'unlimited', stock: 0,
      },
      select: { id: true },
    })
    expect(offer.id).toBeGreaterThan(0)

    const token = await adminToken()
    const res = await api
      .post(`/api/admin/products/${product.id}/offers/${extra.id}/archive`)
      .set(authHeader(token))
      .send({})
    expect(res.status).toBe(200)

    const after = await readState(product.id)
    // 归档只是下架一个套餐，不改变游客看到的展示文案；
    // 且 §4.4 只要求「新增或**启用**」失效，不要求下架失效。
    expect(after.revision).toBe(1)
    expect(after.eligibility.decision).toBe('approved')
  })
})
