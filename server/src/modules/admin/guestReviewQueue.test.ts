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
 * SPEC-CATALOG-VIS-001 §4.5 / §4.6（P1.5-B）——管理端待公开审核队列与列表状态，
 * 以及商家列表看到的结论。
 */

async function adminToken() {
  const email = `p15b-admin-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`
  await createTestUser(email, 'admin123', 'admin')
  const { accessToken } = await loginAs(email, 'admin123')
  return accessToken
}

async function setEligibility(
  productId: number,
  data: { decision: string; reviewedRevision: number | null; reasonCode?: string | null } | null,
) {
  await prisma.productGuestEligibility.deleteMany({ where: { productId } })
  if (data) await prisma.productGuestEligibility.create({ data: { productId, ...data } })
}

async function seedQueueFixtures(merchantId?: number) {
  const tag = Math.random().toString(36).slice(2, 8)
  const approved = await createTestProduct(`队列-已批准-${tag}`, 10, 1, ['A'], merchantId)
  const noRecord = await createTestProduct(`队列-无记录-${tag}`, 10, 1, ['B'], merchantId)
  await setEligibility(noRecord.id, null)
  const pending = await createTestProduct(`队列-待审-${tag}`, 10, 1, ['C'], merchantId)
  await setEligibility(pending.id, { decision: 'pending', reviewedRevision: null })
  const rejected = await createTestProduct(`队列-已拒绝-${tag}`, 10, 1, ['D'], merchantId)
  await setEligibility(rejected.id, { decision: 'denied', reviewedRevision: 1, reasonCode: 'rejected' })
  const revoked = await createTestProduct(`队列-已撤销-${tag}`, 10, 1, ['E'], merchantId)
  await setEligibility(revoked.id, { decision: 'denied', reviewedRevision: 1, reasonCode: 'revoked' })
  const stale = await createTestProduct(`队列-版本过期-${tag}`, 10, 1, ['F'], merchantId)
  await prisma.product.update({ where: { id: stale.id }, data: { publicContentRevision: 2 } })
  const membersOnly = await createTestProduct(`队列-仅登录-${tag}`, 10, 1, ['G'], merchantId)
  await prisma.product.update({ where: { id: membersOnly.id }, data: { visibility: 'members_only' } })
  await setEligibility(membersOnly.id, null)

  const restrictedCategory = await prisma.productCategory.create({
    data: {
      code: `p15b-locked-${tag}`,
      label: `受限分类${tag}`,
      normalizedLabel: `受限分类${tag}`,
      guestVisibility: 'members_only',
      createdByUserId: (await prisma.user.findFirstOrThrow({ select: { id: true } })).id,
      updatedByUserId: (await prisma.user.findFirstOrThrow({ select: { id: true } })).id,
    },
  })
  const inLockedCategory = await createTestProduct(`队列-受限分类-${tag}`, 10, 1, ['H'], merchantId)
  await prisma.product.update({ where: { id: inLockedCategory.id }, data: { categoryId: restrictedCategory.id } })
  await setEligibility(inLockedCategory.id, null)

  return { tag, approved, noRecord, pending, rejected, revoked, stale, membersOnly, inLockedCategory }
}

describe('SPEC-CATALOG-VIS-001 §4.5 管理端待公开审核队列', () => {
  it('guestReview=pending 只返回 public、分类允许游客、无记录或 pending 的商品', async () => {
    const f = await seedQueueFixtures()
    const token = await adminToken()

    const res = await api
      .get('/api/admin/products')
      .query({ guestReview: 'pending', q: `队列-`, pageSize: 100 })
      .set(authHeader(token))
    expect(res.status).toBe(200)

    const ids = (res.body.items as Array<{ id: number }>).map(item => item.id).sort((a, b) => a - b)
    expect(ids).toEqual([f.noRecord.id, f.pending.id].sort((a, b) => a - b))
  })

  it('列表每项带 guestReview 状态与两个 CAS 版本', async () => {
    const f = await seedQueueFixtures()
    const token = await adminToken()

    const res = await api
      .get('/api/admin/products')
      .query({ q: `队列-`, pageSize: 100 })
      .set(authHeader(token))
    expect(res.status).toBe(200)

    const byId = new Map(
      (res.body.items as Array<{ id: number; guestReview: Record<string, unknown> }>)
        .map(item => [item.id, item.guestReview]),
    )
    expect(byId.get(f.approved.id)).toMatchObject({ state: 'approved', publicContentRevision: 1, eligibilityVersion: 1 })
    expect(byId.get(f.noRecord.id)).toMatchObject({ state: 'pending', eligibilityVersion: 0 })
    expect(byId.get(f.pending.id)).toMatchObject({ state: 'pending' })
    expect(byId.get(f.rejected.id)).toMatchObject({ state: 'rejected', reasonCode: 'rejected' })
    expect(byId.get(f.revoked.id)).toMatchObject({ state: 'revoked' })
    // 批准记录仍是 approved，但版本已过期：不算已批准。
    expect(byId.get(f.stale.id)).toMatchObject({ state: 'pending', publicContentRevision: 2 })
    expect(byId.get(f.membersOnly.id)).toMatchObject({ state: 'members_only' })
    expect(byId.get(f.inLockedCategory.id)).toMatchObject({ state: 'category_restricted' })
  })

  it('guestReview 只接受 pending', async () => {
    const token = await adminToken()
    const res = await api
      .get('/api/admin/products')
      .query({ guestReview: 'approved' })
      .set(authHeader(token))
    expect(res.status).toBe(400)
  })
})

describe('SPEC-CATALOG-VIS-001 §4.6 商家商品列表的公开审核状态', () => {
  it('商家看到 visibility 与 guestReview 结论，不含审批版本', async () => {
    const email = `p15b-merchant-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`
    const { merchant } = await createTestMerchant(email, 'pass123', {
      role: 'merchant', status: 'active', name: 'P15B商家',
    })
    const f = await seedQueueFixtures(merchant.id)
    const { accessToken } = await loginAs(email, 'pass123')

    const res = await api
      .get('/api/merchant/products')
      .query({ pageSize: 100 })
      .set(authHeader(accessToken))
    expect(res.status).toBe(200)

    const byId = new Map(
      (res.body.items as Array<{ id: number; visibility: string; guestReview: unknown }>)
        .map(item => [item.id, item]),
    )
    expect(byId.get(f.approved.id)).toMatchObject({ visibility: 'public', guestReview: 'approved' })
    expect(byId.get(f.pending.id)).toMatchObject({ guestReview: 'pending' })
    expect(byId.get(f.rejected.id)).toMatchObject({ guestReview: 'rejected' })
    expect(byId.get(f.revoked.id)).toMatchObject({ guestReview: 'revoked' })
    expect(byId.get(f.membersOnly.id)).toMatchObject({ visibility: 'members_only', guestReview: 'members_only' })
    expect(byId.get(f.inLockedCategory.id)).toMatchObject({ guestReview: 'category_restricted' })
    expect(JSON.stringify(res.body.items)).not.toContain('eligibilityVersion')
  })
})
