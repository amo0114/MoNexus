import { describe, expect, it } from 'vitest'
import {
  api,
  authHeader,
  createTestMerchant,
  createTestProduct,
  createTestUser,
  loginAs,
} from './helpers.js'
import { prisma } from '../lib/prisma.js'

const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080600000001f15c4890000' +
    '000d4944415478da6300010000050001' +
    '0d0a2db40000000049454e44ae426082',
  'hex'
)

async function banWithAdmin(adminToken: string, userId: number) {
  await api
    .put(`/api/admin/users/${userId}/ban`)
    .set(authHeader(adminToken))
    .send({ reason: 'hotfix regression' })
    .expect(200)
}

function expectBanned(res: { body: any }) {
  expect(res.body.error.code).toBe('FORBIDDEN')
  expect(res.body.error.message).toBe('账号已被封禁')
}

describe('active user guard', () => {
  it('should reject the same old access token on user business routes after ban', async () => {
    await createTestUser('active-guard-admin@test.local', 'admin123', 'admin')
    const { user, password } = await createTestUser('active-guard-user@test.local', 'pass123', 'user', 5000)
    await createTestProduct('封禁后不可兑换商品', 100, 1, ['active-guard-stock'])
    const oldLogin = await loginAs(user.email, password)
    const adminLogin = await loginAs('active-guard-admin@test.local', 'admin123')

    const oldToken = oldLogin.accessToken
    await banWithAdmin(adminLogin.accessToken, user.id)

    expectBanned(await api.get('/api/auth/me').set(authHeader(oldToken)).expect(403))

    expectBanned(
      await api
        .post('/api/auth/password-change')
        .set(authHeader(oldToken))
        .send({ currentPassword: password, newPassword: 'new-pass-123' })
        .expect(403)
    )

    expectBanned(
      await api
        .post('/api/points/checkin')
        .set(authHeader(oldToken))
        .expect(403)
    )

    expectBanned(
      await api
        .post('/api/orders')
        .set(authHeader(oldToken))
        .send({ productId: 1 })
        .expect(403)
    )

    expectBanned(
      await api
        .post('/api/uploads/image')
        .set(authHeader(oldToken))
        .attach('file', TINY_PNG, { filename: 'tiny.png', contentType: 'image/png' })
        .expect(403)
    )
  })

  it('should reject the same old merchant access token after ban', async () => {
    await createTestUser('active-guard-merchant-admin@test.local', 'admin123', 'admin')
    const { user, password } = await createTestMerchant('active-guard-merchant@test.local', 'merchant123', {
      role: 'merchant',
      status: 'active',
    })
    const oldLogin = await loginAs(user.email, password)
    const adminLogin = await loginAs('active-guard-merchant-admin@test.local', 'admin123')

    const oldToken = oldLogin.accessToken
    await banWithAdmin(adminLogin.accessToken, user.id)

    expectBanned(
      await api
        .get('/api/merchant/me')
        .set(authHeader(oldToken))
        .expect(403)
    )
  })

  it('should reject a banned admin access token before admin authorization', async () => {
    const { user: admin } = await createTestUser('active-guard-banned-admin@test.local', 'admin123', 'admin')
    const oldLogin = await loginAs(admin.email, 'admin123')

    await prisma.user.update({
      where: { id: admin.id },
      data: { status: '已封禁' },
    })

    expectBanned(
      await api
        .get('/api/admin/stats')
        .set(authHeader(oldLogin.accessToken))
        .expect(403)
    )
  })
})
