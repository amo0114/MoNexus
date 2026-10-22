import { describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { createTestProduct } from '../../__tests__/helpers.js'
import {
  applyGuestEligibilityAction,
  getGuestEligibility,
} from './guestEligibilityService.js'

/**
 * SPEC-CATALOG-VIS-001 §4.5 / §4.5.1 / §4.8.2（P1.5-A）——审批 CAS 与状态流转。
 *
 * 断言全部落在**真实数据行**上（ProductGuestEligibility + Product.
 * publicContentRevision），而不是只看返回值。
 */

async function admin() {
  return prisma.user.upsert({
    where: { email: 'p15-admin@test.local' },
    update: {},
    create: { email: 'p15-admin@test.local', password: 'x', role: 'admin' },
    select: { id: true },
  })
}

async function seedProduct(name = '审批测试商品') {
  const product = await createTestProduct(name, 100, 2, ['E-1', 'E-2'])
  await prisma.product.update({
    where: { id: product.id },
    data: { visibility: 'public' },
  })
  return product
}

/**
 * 造一件「无准入记录」的商品。
 *
 * helpers.createTestProduct 现在自带一条 approved 记录（P1.5 语义下"正常
 * 在售商品"应当可被游客看到）。本文件的多数用例需要从**无记录**开始，
 * 因此显式删掉它，而不是让断言建立在 helper 的默认值上。
 */
async function seedProductWithoutEligibility(name: string) {
  const product = await seedProduct(name)
  await prisma.productGuestEligibility.delete({ where: { productId: product.id } })
  return product
}

describe('SPEC-CATALOG-VIS-001 §4.5.1 状态流转', () => {
  it('无记录 + approve → approved，reviewedRevision = 当前版本', async () => {
    const { id: adminId } = await admin()
    const product = await seedProductWithoutEligibility('审批测试商品')

    const view = await applyGuestEligibilityAction(adminId, product.id, {
      action: 'approve',
      expectedPublicContentRevision: 1,
      expectedEligibilityVersion: 0,
    })

    expect(view).toMatchObject({
      decision: 'approved',
      reviewedRevision: 1,
      publicContentRevision: 1,
      guestVisible: true,
    })
    // 落库校验。
    const row = await prisma.productGuestEligibility.findUniqueOrThrow({
      where: { productId: product.id },
    })
    expect(row).toMatchObject({ decision: 'approved', reviewedRevision: 1, version: 1 })
    expect(row.reviewedByUserId).toBe(adminId)
    expect(row.reviewedAt).not.toBeNull()
  })

  it('pending + reject（带原因）→ denied', async () => {
    const { id: adminId } = await admin()
    const product = await seedProductWithoutEligibility('待拒商品')
    await prisma.productGuestEligibility.create({
      data: { productId: product.id, decision: 'pending' },
    })

    const view = await applyGuestEligibilityAction(adminId, product.id, {
      action: 'reject',
      expectedPublicContentRevision: 1,
      expectedEligibilityVersion: 1,
      reasonCode: 'rejected',
    })

    expect(view).toMatchObject({ decision: 'denied', reasonCode: 'rejected' })
    expect(view.guestVisible).toBe(false)
  })

  it('approved + revoke → denied，reasonCode=revoked，游客立即不可见', async () => {
    const { id: adminId } = await admin()
    const product = await seedProductWithoutEligibility('待撤商品')
    await applyGuestEligibilityAction(adminId, product.id, {
      action: 'approve',
      expectedPublicContentRevision: 1,
      expectedEligibilityVersion: 0,
    })

    const view = await applyGuestEligibilityAction(adminId, product.id, {
      action: 'revoke',
      expectedPublicContentRevision: 1,
      expectedEligibilityVersion: 1,
    })

    expect(view).toMatchObject({ decision: 'denied', reasonCode: 'revoked' })
    expect(view.guestVisible).toBe(false)
    // 撤销保留 reviewedRevision（记录"上次审的是 v1"）。
    expect(view.reviewedRevision).toBe(1)
  })

  it('内容变化后批准失效：pending 且 guestVisible=false', async () => {
    const { id: adminId } = await admin()
    const product = await seedProductWithoutEligibility('内容变更商品')
    await applyGuestEligibilityAction(adminId, product.id, {
      action: 'approve',
      expectedPublicContentRevision: 1,
      expectedEligibilityVersion: 0,
    })

    // 模拟展示内容写入：递增 revision（真实写入口见 guestEligibilityInvalidation.test.ts）。
    await prisma.product.update({
      where: { id: product.id },
      data: { publicContentRevision: { increment: 1 } },
    })
    await prisma.productGuestEligibility.update({
      where: { productId: product.id },
      data: { decision: 'pending', version: { increment: 1 } },
    })

    const view = await getGuestEligibility(product.id)
    expect(view).toMatchObject({ decision: 'pending', publicContentRevision: 2 })
    // 关键：reviewedRevision(1) ≠ publicContentRevision(2) → 不放行。
    expect(view.guestVisible).toBe(false)
  })
})

describe('SPEC-CATALOG-VIS-001 §4.5 审批 CAS', () => {
  it('批准 v1 时商品已改成 v2 → 409，且不写入批准', async () => {
    const { id: adminId } = await admin()
    const product = await seedProductWithoutEligibility('版本已变商品')

    // 管理员读到的是 revision=1，但期间商品被改到 2。
    await prisma.product.update({
      where: { id: product.id },
      data: { publicContentRevision: 2 },
    })

    await expect(applyGuestEligibilityAction(adminId, product.id, {
      action: 'approve',
      expectedPublicContentRevision: 1,
      expectedEligibilityVersion: 0,
    })).rejects.toMatchObject({ status: 409 })

    // 未创建任何批准记录。
    const row = await prisma.productGuestEligibility.findUnique({ where: { productId: product.id } })
    expect(row).toBeNull()
  })

  it('两个管理员同时操作：后到者 409，撤销不被旧批准覆盖', async () => {
    const { id: adminA } = await admin()
    const adminB = await prisma.user.upsert({
      where: { email: 'p15-admin-b@test.local' },
      update: {},
      create: { email: 'p15-admin-b@test.local', password: 'x', role: 'admin' },
      select: { id: true },
    })
    const product = await seedProductWithoutEligibility('并发审批商品')

    // A 批准（version 1）。
    await applyGuestEligibilityAction(adminA, product.id, {
      action: 'approve',
      expectedPublicContentRevision: 1,
      expectedEligibilityVersion: 0,
    })
    // B 撤销（version 2）。
    await applyGuestEligibilityAction(adminB.id, product.id, {
      action: 'revoke',
      expectedPublicContentRevision: 1,
      expectedEligibilityVersion: 1,
    })

    // A 拿着旧 version=1 再批准 → 必须失败（不得复活已撤销的批准）。
    await expect(applyGuestEligibilityAction(adminA, product.id, {
      action: 'approve',
      expectedPublicContentRevision: 1,
      expectedEligibilityVersion: 1,
    })).rejects.toMatchObject({ status: 409 })

    // 记录仍是撤销状态。
    const row = await prisma.productGuestEligibility.findUniqueOrThrow({
      where: { productId: product.id },
    })
    expect(row.decision).toBe('denied')
    expect(row.reasonCode).toBe('revoked')
    expect(row.version).toBe(2)
  })

  it('并发首次批准：两个请求都以 version=0 提交，只有一个成功', async () => {
    const { id: adminId } = await admin()
    const product = await seedProductWithoutEligibility('并发首批准商品')

    const results = await Promise.allSettled([
      applyGuestEligibilityAction(adminId, product.id, {
        action: 'approve',
        expectedPublicContentRevision: 1,
        expectedEligibilityVersion: 0,
      }),
      applyGuestEligibilityAction(adminId, product.id, {
        action: 'approve',
        expectedPublicContentRevision: 1,
        expectedEligibilityVersion: 0,
      }),
    ])

    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    // 商品行锁串行化两者：第二个看到 version 已是 1，CAS 失败。
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const count = await prisma.productGuestEligibility.count({ where: { productId: product.id } })
    expect(count).toBe(1)
  })

  it('拒绝必须带 reasonCode', async () => {
    const { id: adminId } = await admin()
    const product = await seedProductWithoutEligibility('缺原因拒绝商品')
    await prisma.productGuestEligibility.create({
      data: { productId: product.id, decision: 'pending' },
    })

    await expect(applyGuestEligibilityAction(adminId, product.id, {
      action: 'reject',
      expectedPublicContentRevision: 1,
      expectedEligibilityVersion: 1,
    } as never)).rejects.toMatchObject({ status: 400 })
  })

  it('未批准的商品即使 visibility=public + 分类 public 也对游客不可见', async () => {
    const { id: adminId } = await admin()
    const product = await seedProductWithoutEligibility('未批准公开商品')
    // 分类默认 public，商品 public，但无准入记录。
    const view = await getGuestEligibility(product.id)
    expect(view.decision).toBeNull()
    expect(view.guestVisible).toBe(false)
    expect(adminId).toBeGreaterThan(0)
  })
})
