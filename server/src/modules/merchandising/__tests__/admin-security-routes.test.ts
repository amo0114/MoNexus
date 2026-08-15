import jwt from 'jsonwebtoken'
import { describe, expect, it } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from '../../../__tests__/helpers.js'
import { config } from '../../../config/index.js'
import { prisma } from '../../../lib/prisma.js'

const realPg = describe.skipIf(!process.env.TEST_DATABASE_URL)

async function adminTokenWithoutMfa(): Promise<string> {
  const { user } = await createTestUser('cmi-admin-route-mfa@test.local', 'admin123', 'admin')
  await loginAs(user.email, 'admin123')
  const session = await prisma.refreshToken.findFirstOrThrow({
    where: { userId: user.id, revoked: false },
    orderBy: { id: 'desc' },
  })
  return jwt.sign(
    { userId: user.id, role: 'admin', sid: session.sessionId },
    config.jwtSecret,
    { expiresIn: '15m' },
  )
}

async function expectMfaRequired(request: Promise<{ body: { error?: { code?: string } }; status: number }>) {
  const response = await request
  expect(response.status).toBe(403)
  expect(response.body.error?.code).toBe('MFA_REQUIRED')
}

realPg('CMI merchandising admin route MFA boundary', () => {
  it('rejects every admin merchandising surface before validation or mutation', async () => {
    const token = await adminTokenWithoutMfa()
    const header = authHeader(token)

    await expectMfaRequired(api.get('/api/admin/promotion-packages').set(header))
    await expectMfaRequired(api.post('/api/admin/promotion-packages').set(header).send({
      code: 'mfa-blocked-package',
      label: 'MFA blocked',
      placement: 'store_home_sponsored',
      durationDays: 7,
      pricePoints: 100,
    }))

    await expectMfaRequired(api.get('/api/admin/editorial-features').set(header))
    await expectMfaRequired(api.post('/api/admin/editorial-features').set(header).send({
      productId: 1,
      placement: 'store_editorial',
      startsAt: new Date(Date.now() - 1_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      internalReason: 'MFA blocked',
    }))

    await expectMfaRequired(api.get('/api/admin/merchant-entitlements').set(header))
    await expectMfaRequired(api.post('/api/admin/merchant-entitlements').set(header).send({
      merchantId: 1,
      validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      reason: 'MFA blocked',
    }))

    await expectMfaRequired(api.get('/api/admin/merchandising/runs').set(header))
    await expectMfaRequired(api.post('/api/admin/merchandising/recompute').set(header).send({}))
  })
})
