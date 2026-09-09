import { describe, expect, it } from 'vitest'
import { prisma } from '../../../lib/prisma.js'
import {
  api,
  authHeader,
  createTestMerchant,
  createTestProduct,
  createTestUser,
  loginAs,
} from '../../../__tests__/helpers.js'

async function adminToken(email: string) {
  await createTestUser(email, 'admin123', 'admin')
  const { accessToken } = await loginAs(email, 'admin123')
  return accessToken
}

function later(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString()
}

describe('product assurance applications and grants (SPEC-PRODUCT-COMMERCE-002 §7)', () => {
  it('lets a merchant apply and withdraw, and rejects a second pending row', async () => {
    const { merchant } = await createTestMerchant('as-apply@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '保障商家',
    })
    const { accessToken } = await loginAs('as-apply@test.local', 'pass123')
    const product = await createTestProduct('保障申请商品', 50, 1, ['AS-1'], merchant.id)

    const created = await api
      .post(`/api/merchant/products/${product.id}/assurance/applications`)
      .set(authHeader(accessToken))
      .send({ reason: '希望平台协助处理该商品的售后争议与发货异常。' })
      .expect(201)
    expect(created.body.status).toBe('pending')
    expect(created.body.reviewedByUserId).toBeUndefined()

    await api
      .post(`/api/merchant/products/${product.id}/assurance/applications`)
      .set(authHeader(accessToken))
      .send({ reason: '这是第二条不应该成功的待审核申请，长度必须足够。' })
      .expect(409)

    const withdrawn = await api
      .post(`/api/merchant/assurance-applications/${created.body.id}/withdraw`)
      .set(authHeader(accessToken))
      .send({})
      .expect(200)
    expect(withdrawn.body.status).toBe('withdrawn')

    const again = await api
      .post(`/api/merchant/products/${product.id}/assurance/applications`)
      .set(authHeader(accessToken))
      .send({ reason: '撤回后重新申请平台保障，用于售后争议协助处理。' })
      .expect(201)
    expect(again.body.status).toBe('pending')
  })

  it('approves an application atomically with a grant and public projection', async () => {
    const { merchant } = await createTestMerchant('as-approve@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '批准商家',
    })
    const { accessToken: merchantToken } = await loginAs('as-approve@test.local', 'pass123')
    const product = await createTestProduct('保障公开商品', 80, 1, ['AS-PUB'], merchant.id)
    const application = await api
      .post(`/api/merchant/products/${product.id}/assurance/applications`)
      .set(authHeader(merchantToken))
      .send({ reason: '该商品需要平台协助售后，申请开通平台保障标识。' })
      .expect(201)

    const token = await adminToken('as-approve-admin@test.local')
    const approved = await api
      .post(`/api/admin/assurance-applications/${application.body.id}/approve`)
      .set(authHeader(token))
      .send({ validUntil: later(90), reason: '审核通过，授予90天平台保障。' })
      .expect(200)
    expect(approved.body.application.status).toBe('approved')
    expect(approved.body.grant.status).toBe('active')
    expect(approved.body.grant.policyCode).toBe('platform_assistance_v1')

    const duplicate = await api
      .post(`/api/admin/assurance-applications/${application.body.id}/approve`)
      .set(authHeader(token))
      .send({ validUntil: later(30), reason: '重复批准应失败。' })
      .expect(409)
    expect(duplicate.body.error.code).toBe('ASSURANCE_APPLICATION_CLOSED')

    const publicDetail = await api.get(`/api/products/${product.id}`).expect(200)
    expect(publicDetail.body.assurance).toEqual(expect.objectContaining({
      label: '平台保障',
      policyCode: 'platform_assistance_v1',
    }))
    expect(JSON.stringify(publicDetail.body)).not.toContain('审核通过')

    expect(await prisma.adminLog.count({
      where: { targetType: 'productAssuranceApplication', targetId: application.body.id },
    })).toBe(1)
  })

  it('direct-grants only when no pending application exists, and revoke keeps historical orders', async () => {
    const { merchant } = await createTestMerchant('as-grant@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '直授商家',
    })
    await createTestUser('as-buyer@test.local', 'pass123', 'user', 5000)
    const { accessToken: merchantToken } = await loginAs('as-grant@test.local', 'pass123')
    const { accessToken: buyerToken } = await loginAs('as-buyer@test.local', 'pass123')
    const product = await createTestProduct('保障直授商品', 40, 2, ['AS-G1', 'AS-G2'], merchant.id)
    const pending = await api
      .post(`/api/merchant/products/${product.id}/assurance/applications`)
      .set(authHeader(merchantToken))
      .send({ reason: '先提交申请，管理员不能绕过待审直接授权。' })
      .expect(201)

    const token = await adminToken('as-grant-admin@test.local')
    await api
      .post(`/api/admin/products/${product.id}/assurance/grants`)
      .set(authHeader(token))
      .send({ validUntil: later(30), reason: '有待审申请时不能直接授权。' })
      .expect(409)

    await api
      .post(`/api/admin/assurance-applications/${pending.body.id}/reject`)
      .set(authHeader(token))
      .send({ reason: '材料不足，先拒绝后再直接授权。' })
      .expect(200)

    const granted = await api
      .post(`/api/admin/products/${product.id}/assurance/grants`)
      .set(authHeader(token))
      .send({ validUntil: later(60), reason: '管理员直接授予该商品平台保障。' })
      .expect(201)

    const preview = await api.get('/api/checkout/preview').query({ productId: product.id }).set(authHeader(buyerToken)).expect(200)
    expect(preview.body.assuranceGrantId).toBe(granted.body.id)
    const order = await api.post('/api/orders').set(authHeader(buyerToken)).send({
      productId: product.id,
      offerId: preview.body.offerId,
      expectedPrice: 40,
      expectedCheckoutVersion: preview.body.checkoutVersion,
      expectedProductContentVersion: preview.body.productContentVersion,
      expectedAssuranceGrantId: preview.body.assuranceGrantId,
    }).expect(201)

    const revoked = await api
      .post(`/api/admin/assurance-grants/${granted.body.id}/revoke`)
      .set(authHeader(token))
      .send({ reason: '发现履约风险，撤销后续新单保障。' })
      .expect(200)
    expect(revoked.body.status).toBe('revoked')

    const replay = await api
      .post(`/api/admin/assurance-grants/${granted.body.id}/revoke`)
      .set(authHeader(token))
      .send({ reason: '再次撤销不应重复审计。' })
      .expect(200)
    expect(replay.body.status).toBe('revoked')
    expect(await prisma.adminLog.count({
      where: { targetType: 'productAssuranceGrant', targetId: granted.body.id, action: '撤销商品保障' },
    })).toBe(1)

    const publicAfter = await api.get(`/api/products/${product.id}`).expect(200)
    expect(publicAfter.body.assurance).toBeNull()

    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.body.orderId } })
    const snapshot = stored.productContentSnapshot as { assurance?: { grantId: number } | null }
    expect(snapshot.assurance?.grantId).toBe(granted.body.id)
  })

  it('does not project an expired grant and refuses overlapping active grants', async () => {
    const product = await createTestProduct('过期保障商品', 20, 1, ['AS-EXP'])
    const admin = await createTestUser('as-exp-admin@test.local', 'admin123', 'admin')
    const now = new Date()
    await prisma.productAssuranceGrant.create({
      data: {
        productId: product.id,
        status: 'active',
        policyCode: 'platform_assistance_v1',
        validFrom: new Date(now.getTime() - 10 * 86_400_000),
        validUntil: new Date(now.getTime() - 1000),
        grantedByUserId: admin.user.id,
        grantReason: '已到期的历史授权',
      },
    })
    const publicDetail = await api.get(`/api/products/${product.id}`).expect(200)
    expect(publicDetail.body.assurance).toBeNull()

    const token = await loginAs('as-exp-admin@test.local', 'admin123')
    const fresh = await api
      .post(`/api/admin/products/${product.id}/assurance/grants`)
      .set(authHeader(token.accessToken))
      .send({ validUntil: later(10), reason: '过期行应被标记后才能授予新的保障。' })
      .expect(201)
    expect(fresh.body.status).toBe('active')
    const expired = await prisma.productAssuranceGrant.findMany({
      where: { productId: product.id, status: 'expired' },
    })
    expect(expired).toHaveLength(1)
  })
})
