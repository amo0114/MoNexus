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

async function setVisibility(productId: number, visibility: 'public' | 'members_only') {
  await prisma.product.update({ where: { id: productId }, data: { visibility } })
}

describe('product audience visibility (SPEC-PRODUCT-COMMERCE-002 §6)', () => {
  it('lets guests list and read public products, but not members_only content', async () => {
    const open = await createTestProduct('公开可见商品', 50, 2, ['OPEN-1', 'OPEN-2'])
    const locked = await createTestProduct('会员可见商品', 50, 2, ['LOCK-1', 'LOCK-2'])
    await setVisibility(locked.id, 'members_only')

    const guestList = await api.get('/api/products').expect(200)
    expect(guestList.headers['cache-control']).toMatch(/no-store/)
    const guestIds = guestList.body.items.map((item: { id: number }) => item.id)
    expect(guestIds).toContain(open.id)
    expect(guestIds).not.toContain(locked.id)

    const guestOpen = await api.get(`/api/products/${open.id}`).expect(200)
    expect(guestOpen.body.name).toBe('公开可见商品')
    expect(guestOpen.body.merchant?.status).toBeUndefined()

    const guestLocked = await api.get(`/api/products/${locked.id}`).expect(403)
    expect(guestLocked.body.error.code).toBe('PRODUCT_LOGIN_REQUIRED')
    expect(JSON.stringify(guestLocked.body)).not.toContain('会员可见商品')
    expect(guestLocked.body.error.message).toBe('登录后查看商品')

    const guestReviews = await api.get(`/api/products/${locked.id}/reviews`).expect(403)
    expect(guestReviews.body.error.code).toBe('PRODUCT_LOGIN_REQUIRED')
    expect(JSON.stringify(guestReviews.body)).not.toContain('会员可见商品')
  })

  it('lets a logged-in member read members_only products after a guest cache warm', async () => {
    const product = await createTestProduct('暖缓存会员商品', 80, 1, ['WARM-1'])
    await setVisibility(product.id, 'members_only')
    await createTestUser('vis-member@test.local', 'pass123', 'user', 1000)
    const { accessToken } = await loginAs('vis-member@test.local', 'pass123')

    await api.get('/api/products').expect(200)
    await api.get(`/api/products/${product.id}`).expect(403)

    const memberList = await api.get('/api/products').set(authHeader(accessToken)).expect(200)
    expect(memberList.body.items.some((item: { id: number }) => item.id === product.id)).toBe(true)

    const memberDetail = await api.get(`/api/products/${product.id}`).set(authHeader(accessToken)).expect(200)
    expect(memberDetail.body.name).toBe('暖缓存会员商品')

    const guestAgain = await api.get('/api/products').expect(200)
    expect(guestAgain.body.items.some((item: { id: number }) => item.id === product.id)).toBe(false)
  })

  it('re-checks live visibility after public→members_only and merchant ban', async () => {
    const product = await createTestProduct('将改为会员可见', 60, 1, ['FLIP-1'])
    await api.get(`/api/products/${product.id}`).expect(200)

    await setVisibility(product.id, 'members_only')
    await api.get(`/api/products/${product.id}`).expect(403)
    const listAfterFlip = await api.get('/api/products').expect(200)
    expect(listAfterFlip.body.items.some((item: { id: number }) => item.id === product.id)).toBe(false)

    const { merchant } = await createTestMerchant('vis-banned@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '将被封禁商家',
    })
    const owned = await createTestProduct('封禁商家商品', 40, 1, ['BAN-1'], merchant.id)
    await api.get(`/api/products/${owned.id}`).expect(200)
    await prisma.merchant.update({ where: { id: merchant.id }, data: { status: 'suspended' } })
    await api.get(`/api/products/${owned.id}`).expect(404)
    const listAfterBan = await api.get('/api/products').expect(200)
    expect(listAfterBan.body.items.some((item: { id: number }) => item.id === owned.id)).toBe(false)
  })

  it('rejects a guest cursor on a member-only listing', async () => {
    await createTestProduct('游标A', 10, 1, ['CUR-A'])
    await createTestProduct('游标B', 10, 1, ['CUR-B'])
    const locked = await createTestProduct('游标会员', 10, 1, ['CUR-M'])
    await setVisibility(locked.id, 'members_only')
    await createTestUser('vis-cursor@test.local', 'pass123', 'user', 1000)
    const { accessToken } = await loginAs('vis-cursor@test.local', 'pass123')
    const memberPage = await api.get('/api/products').query({ pageSize: 1 }).set(authHeader(accessToken)).expect(200)
    expect(memberPage.body.nextCursor).toEqual(expect.any(String))
    await api.get('/api/products').query({ cursor: memberPage.body.nextCursor, pageSize: 1 }).expect(409)
  })

  it('returns 404 for draft products instead of login required', async () => {
    const product = await createTestProduct('草稿商品', 10, 1, ['DRAFT-1'])
    await prisma.product.update({ where: { id: product.id }, data: { status: 'draft', visibility: 'public' } })
    await api.get(`/api/products/${product.id}`).expect(404)
    await api.get(`/api/products/${product.id}/reviews`).expect(404)
  })
})
