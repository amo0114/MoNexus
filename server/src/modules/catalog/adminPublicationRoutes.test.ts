import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import { prisma } from '../../lib/prisma.js'
import { config } from '../../config/index.js'
import { api, authHeader, createTestUser, loginAs } from '../../__tests__/helpers.js'

async function adminToken(email: string) {
  const { user } = await createTestUser(email, 'admin123', 'admin')
  const { accessToken } = await loginAs(user.email, 'admin123')
  return accessToken
}

const completeDraft = {
  name: '管理员可发布平台商品',
  type: '邀请码',
  price: 50,
  deliveryMode: 'instant_fixed',
  stockMode: 'unlimited',
  fixedContent: 'https://example.com/delivery',
  fixedContentType: 'url',
  imageUrl: 'https://example.com/cover.png',
  images: ['https://example.com/cover.png'],
}

describe('admin publication routes — existing contract characterization (T-APUB-006)', () => {
  it('lets an MFA admin readiness-check, publish, unpublish, and preserve publishedAt', async () => {
    const token = await adminToken('admin-pub-ready@test.local')
    const created = await api.post('/api/admin/products')
      .set(authHeader(token))
      .send(completeDraft)
      .expect(201)
    expect(created.body).toMatchObject({
      status: 'draft',
      merchantId: null,
      publishedAt: null,
    })

    const readiness = await api.get(`/api/admin/products/${created.body.id}/readiness`)
      .set(authHeader(token))
      .expect(200)
    expect(readiness.body).toEqual({
      ready: true,
      productId: created.body.id,
      issues: [],
    })

    const published = await api.post(`/api/admin/products/${created.body.id}/publish`)
      .set(authHeader(token))
      .expect(200)
    expect(published.body).toMatchObject({ id: created.body.id, status: 'active' })
    expect(published.body.publishedAt).toEqual(expect.any(String))
    const firstPublishedAt = published.body.publishedAt

    const unpublished = await api.post(`/api/admin/products/${created.body.id}/unpublish`)
      .set(authHeader(token))
      .expect(200)
    expect(unpublished.body).toMatchObject({
      id: created.body.id,
      status: 'inactive',
      publishedAt: firstPublishedAt,
    })

    const stored = await prisma.product.findUniqueOrThrow({
      where: { id: created.body.id },
      select: { status: true, publishedAt: true, merchantId: true },
    })
    expect(stored).toMatchObject({
      status: 'inactive',
      merchantId: null,
    })
    expect(stored.publishedAt?.toISOString()).toBe(firstPublishedAt)
  })

  it('rejects unauthenticated callers on the existing admin publication routes', async () => {
    await api.get('/api/admin/products/1/readiness').expect(401)
    await api.post('/api/admin/products/1/publish').expect(401)
    await api.post('/api/admin/products/1/unpublish').expect(401)
  })

  it('rejects a non-admin caller (403) and an admin token without MFA (403 MFA_REQUIRED)', async () => {
    const { user: member, password } = await createTestUser('admin-pub-user@test.local', 'user1234', 'user')
    const { accessToken: userToken } = await loginAs(member.email, password)
    await api.get('/api/admin/products/1/readiness').set(authHeader(userToken)).expect(403)
    await api.post('/api/admin/products/1/publish').set(authHeader(userToken)).expect(403)
    await api.post('/api/admin/products/1/unpublish').set(authHeader(userToken)).expect(403)

    const { user: admin } = await createTestUser('admin-pub-nomfa@test.local', 'admin123', 'admin')
    await loginAs(admin.email, 'admin123')
    const session = await prisma.refreshToken.findFirstOrThrow({
      where: { userId: admin.id, revoked: false },
      orderBy: { id: 'desc' },
    })
    const adminWithoutMfa = jwt.sign(
      { userId: admin.id, role: 'admin', sid: session.sessionId },
      config.jwtSecret,
      { expiresIn: '15m' },
    )
    const blocked = await api.post('/api/admin/products/1/publish')
      .set(authHeader(adminWithoutMfa))
      .expect(403)
    expect(blocked.body.error.code).toBe('MFA_REQUIRED')
  })
})
