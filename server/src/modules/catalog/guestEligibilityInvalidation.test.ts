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
import {
  invalidateGuestEligibility,
  offerPublicContentChanged,
  productPublicContentChanged,
  publicContentValuesEqual,
} from '../catalog/guestEligibility.js'

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

describe('SPEC-CATALOG-VIS-001 §4.4 展示字段判定（按值，不按键存在）', () => {
  it('JSON 字段按归一化内容比较：键顺序不同视为未变', () => {
    expect(publicContentValuesEqual('details', { a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true)
    expect(publicContentValuesEqual('attributes', [{ x: 1, y: 2 }], [{ y: 2, x: 1 }])).toBe(true)
    // 内容确实不同则判为变了。
    expect(publicContentValuesEqual('details', { a: 1 }, { a: 2 })).toBe(false)
    expect(publicContentValuesEqual('images', ['a', 'b'], ['b', 'a'])).toBe(false)
  })

  it('null 与 undefined 视为等价，避免"清空 vs 未设"误判为变更', () => {
    expect(publicContentValuesEqual('name', null, undefined)).toBe(true)
    expect(publicContentValuesEqual('description', null, 'x')).toBe(false)
    expect(publicContentValuesEqual('description', 'x', null)).toBe(false)
  })

  it('Date 按时间戳比较', () => {
    const t = new Date('2026-01-01T00:00:00Z')
    expect(publicContentValuesEqual('x', t, new Date(t.getTime()))).toBe(true)
    expect(publicContentValuesEqual('x', t, new Date(t.getTime() + 1))).toBe(false)
  })
})

describe('SPEC-CATALOG-VIS-001 §4.4 无改动保存不失效（复审阻塞项 2）', () => {
  it('提交与现状相同的值 → 不失效，revision 与批准都不变', async () => {
    const product = await seedApprovedProduct('同值提交商品')
    const before = await readState(product.id)

    // 模拟"编辑表单整包提交但什么都没改"：键都在，值都与现状一致。
    await prisma.$transaction(async tx => {
      await lockProductRow(tx, product.id)
      const changed = await productPublicContentChanged(tx, product.id, {
        name: '同值提交商品',
        visibility: 'public',
      })
      expect(changed).toBe(false)
    })

    const after = await readState(product.id)
    expect(after.revision).toBe(before.revision)
    expect(after.eligibility!.decision).toBe('approved')
  })

  it('JSON 字段只有键顺序不同 → 不失效', async () => {
    const product = await seedApprovedProduct('JSON顺序商品')
    await prisma.product.update({
      where: { id: product.id },
      data: { details: { highlights: ['a'], usageInstructions: 'x', purchaseNotes: '', afterSalesInstructions: '', faq: [] } },
    })
    // 把 revision 与批准对齐到当前版本，作为"已批准"基线。
    await prisma.product.update({ where: { id: product.id }, data: { publicContentRevision: 2 } })
    await prisma.productGuestEligibility.update({
      where: { productId: product.id },
      data: { decision: 'approved', reviewedRevision: 2 },
    })

    await prisma.$transaction(async tx => {
      await lockProductRow(tx, product.id)
      const changed = await productPublicContentChanged(tx, product.id, {
        // 键顺序不同、内容相同。
        details: { faq: [], afterSalesInstructions: '', purchaseNotes: '', usageInstructions: 'x', highlights: ['a'] },
      })
      expect(changed).toBe(false)
    })

    const state = await readState(product.id)
    expect(state.revision).toBe(2)
    expect(state.eligibility!.decision).toBe('approved')
  })

  it('真实修改 → 失效', async () => {
    const product = await seedApprovedProduct('真实修改商品')
    await prisma.$transaction(async tx => {
      await lockProductRow(tx, product.id)
      const changed = await productPublicContentChanged(tx, product.id, { name: '改过的名字' })
      expect(changed).toBe(true)
      await invalidateGuestEligibility(tx, product.id)
    })
    const state = await readState(product.id)
    expect(state.revision).toBe(2)
    expect(state.eligibility!.decision).toBe('pending')
  })

  it('价格/库存字段即使提交也不失效', async () => {
    const product = await seedApprovedProduct('价格提交商品')
    await prisma.$transaction(async tx => {
      await lockProductRow(tx, product.id)
      const changed = await productPublicContentChanged(tx, product.id, {
        price: 999, stock: 42, sales: 7, ratingAvg: 5, deliveryMode: 'manual_service',
      })
      expect(changed).toBe(false)
    })
    const state = await readState(product.id)
    expect(state.revision).toBe(1)
    expect(state.eligibility!.decision).toBe('approved')
  })
})

describe('SPEC-CATALOG-VIS-001 §4.4 套餐侧按值判定', () => {
  it('套餐名称未变 → 不失效；名称变了 → 失效；启用 → 失效', async () => {
    const product = await seedApprovedProduct('套餐值判定商品')
    const offer = await prisma.offer.findFirstOrThrow({
      where: { productId: product.id, isDefault: true },
      select: { id: true, name: true, status: true },
    })

    // 同值：不改。
    expect(await offerPublicContentChanged(prisma, offer.id, { name: offer.name })).toBe(false)
    // 名称变化：改。
    expect(await offerPublicContentChanged(prisma, offer.id, { name: '新套餐名' })).toBe(true)
    // 纯价格：不改。
    expect(await offerPublicContentChanged(prisma, offer.id, { price: 123 })).toBe(false)
    // 状态变 active（已是 active）：不改。
    expect(await offerPublicContentChanged(prisma, offer.id, { status: 'active' })).toBe(false)
  })

  it('inactive 套餐启用 → 失效（复审阻塞项 1 的漏洞链）', async () => {
    const product = await seedApprovedProduct('启用套餐商品')
    const offer = await prisma.offer.findFirstOrThrow({
      where: { productId: product.id, isDefault: true },
      select: { id: true },
    })
    await prisma.offer.update({ where: { id: offer.id }, data: { status: 'inactive' } })

    expect(await offerPublicContentChanged(prisma, offer.id, { status: 'active' })).toBe(true)
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
