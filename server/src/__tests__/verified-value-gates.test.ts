import { afterEach, describe, expect, it } from 'vitest'
import {
  api,
  authHeader,
  createTestMerchant,
  createTestProduct,
  createTestUser,
  loginAs,
} from './helpers.js'
import { prisma } from '../lib/prisma.js'

const GATE_KEY = 'emailVerificationRequiredForValue'

async function setValueGate(value: 0 | 1) {
  await prisma.systemConfig.upsert({
    where: { key: GATE_KEY },
    update: { value },
    create: { key: GATE_KEY, value },
  })
}

async function clearValueGate() {
  await prisma.systemConfig.deleteMany({ where: { key: GATE_KEY } })
}

afterEach(async () => {
  // The system-config table is intentionally not part of the shared test
  // truncation. Restore the missing-row default so this file cannot leak an
  // enabled gate into an unrelated suite.
  await clearValueGate()
})

describe('SPEC-RAP-001 verified-value gate', () => {
  it('is a no-op when disabled and reads the current database verification state', async () => {
    const { user, password } = await createTestUser('gate-state@test.local', 'pass123', 'user', 0)
    const { accessToken } = await loginAs(user.email, password)

    await setValueGate(0)
    await api.post('/api/points/checkin').set(authHeader(accessToken)).expect(200)

    // Reuse the same JWT after changing only the current database row. The
    // gate must not trust a token/profile snapshot captured at login time.
    await prisma.checkinRecord.deleteMany({ where: { userId: user.id } })
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: new Date() } })
    await setValueGate(1)
    await api.post('/api/points/checkin').set(authHeader(accessToken)).expect(200)
  })

  it('blocks an unverified check-in before creating a check-in or reward log', async () => {
    const { user, password } = await createTestUser('gate-checkin@test.local', 'pass123', 'user', 0)
    const { accessToken } = await loginAs(user.email, password)
    await setValueGate(1)

    const before = await Promise.all([
      prisma.checkinRecord.count({ where: { userId: user.id } }),
      prisma.pointLog.count({ where: { userId: user.id } }),
    ])
    const response = await api.post('/api/points/checkin').set(authHeader(accessToken)).expect(403)

    expect(response.body.error.code).toBe('EMAIL_VERIFICATION_REQUIRED')
    await expect(prisma.checkinRecord.count({ where: { userId: user.id } })).resolves.toBe(before[0])
    await expect(prisma.pointLog.count({ where: { userId: user.id } })).resolves.toBe(before[1])
  })

  it('blocks order creation with zero order, inventory, and balance mutation', async () => {
    const { user, password } = await createTestUser('gate-order@test.local', 'pass123', 'user', 1000)
    const product = await createTestProduct('邮箱门槛商品', 100, 1, ['gate-order-item'])
    const { accessToken } = await loginAs(user.email, password)
    await setValueGate(1)

    const before = await Promise.all([
      prisma.order.count({ where: { userId: user.id } }),
      prisma.inventoryItem.findMany({ where: { productId: product.id }, select: { status: true, orderId: true } }),
      prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id }, select: { balance: true } }),
    ])

    const response = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: product.id })
      .expect(403)

    expect(response.body.error.code).toBe('EMAIL_VERIFICATION_REQUIRED')
    await expect(prisma.order.count({ where: { userId: user.id } })).resolves.toBe(before[0])
    await expect(
      prisma.inventoryItem.findMany({ where: { productId: product.id }, select: { status: true, orderId: true } }),
    ).resolves.toEqual(before[1])
    await expect(
      prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id }, select: { balance: true } }),
    ).resolves.toEqual(before[2])
  })

  it('blocks review create and update while leaving the existing review unchanged', async () => {
    const { user, password } = await createTestUser('gate-review@test.local', 'pass123', 'user', 1000)
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: new Date() } })
    const product = await createTestProduct('评价门槛商品', 100, 2, ['review-a', 'review-b'])
    const { accessToken } = await loginAs(user.email, password)

    // Establish a delivered order and an existing review while the gate is off.
    await setValueGate(0)
    const order = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: product.id })
      .expect(201)
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: null } })
    await setValueGate(1)

    const createResponse = await api
      .post(`/api/orders/${order.body.orderId}/review`)
      .set(authHeader(accessToken))
      .send({ rating: 5, comment: '第一次评价' })
      .expect(403)
    expect(createResponse.body.error.code).toBe('EMAIL_VERIFICATION_REQUIRED')
    await expect(prisma.review.count({ where: { orderId: order.body.orderId } })).resolves.toBe(0)

    await setValueGate(0)
    await api
      .post(`/api/orders/${order.body.orderId}/review`)
      .set(authHeader(accessToken))
      .send({ rating: 4, comment: '既有评价' })
      .expect(201)
    await setValueGate(1)

    const updateResponse = await api
      .put(`/api/orders/${order.body.orderId}/review`)
      .set(authHeader(accessToken))
      .send({ rating: 3, comment: '不应写入' })
      .expect(403)
    expect(updateResponse.body.error.code).toBe('EMAIL_VERIFICATION_REQUIRED')
    await expect(
      prisma.review.findUniqueOrThrow({ where: { orderId: order.body.orderId }, select: { rating: true, comment: true } }),
    ).resolves.toEqual({ rating: 4, comment: '既有评价' })
  })

  it('blocks merchant application without creating a merchant row', async () => {
    const { user, password } = await createTestUser('gate-merchant-application@test.local', 'pass123')
    const { accessToken } = await loginAs(user.email, password)
    await setValueGate(1)

    const response = await api
      .post('/api/merchant/register')
      .set(authHeader(accessToken))
      .send({ name: '未验证商家', contactEmail: user.email })
      .expect(403)

    expect(response.body.error.code).toBe('EMAIL_VERIFICATION_REQUIRED')
    await expect(prisma.merchant.count({ where: { userId: user.id } })).resolves.toBe(0)
  })

  it('rejects image and delivery-file uploads before multipart parsers run', async () => {
    const imageUser = await createTestUser('gate-image@test.local', 'pass123')
    const imageLogin = await loginAs(imageUser.user.email, imageUser.password)
    const merchantSetup = await createTestMerchant('gate-delivery@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
    })
    const merchantLogin = await loginAs(merchantSetup.user.email, merchantSetup.password)
    await setValueGate(1)

    const imageResponse = await api
      .post('/api/uploads/image')
      .set(authHeader(imageLogin.accessToken))
      .attach('file', Buffer.alloc(6 * 1024 * 1024, 0xff), {
        filename: 'too-large.png',
        contentType: 'image/png',
      })
      .expect(403)
    expect(imageResponse.body.error.code).toBe('EMAIL_VERIFICATION_REQUIRED')

    const deliveryResponse = await api
      .post('/api/uploads/delivery-file')
      .set(authHeader(merchantLogin.accessToken))
      .attach('file', Buffer.from('delivery-content'), {
        filename: 'delivery.txt',
        contentType: 'text/plain',
      })
      .expect(403)
    expect(deliveryResponse.body.error.code).toBe('EMAIL_VERIFICATION_REQUIRED')
    await expect(prisma.deliveryFile.count({ where: { merchantId: merchantSetup.merchant.id } })).resolves.toBe(0)
  })

  it('does not gate order reads or checkout preview', async () => {
    const { user, password } = await createTestUser('gate-exemptions@test.local', 'pass123', 'user', 1000)
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: new Date() } })
    const product = await createTestProduct('门槛豁免商品', 100, 2, ['exempt-a', 'exempt-b'])
    const { accessToken } = await loginAs(user.email, password)
    await setValueGate(0)
    const order = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: product.id })
      .expect(201)
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: null } })
    await setValueGate(1)

    await api.get('/api/orders').set(authHeader(accessToken)).expect(200)
    await api.get(`/api/orders/${order.body.orderId}`).set(authHeader(accessToken)).expect(200)
    await api.get('/api/checkout/preview').query({ productId: product.id }).set(authHeader(accessToken)).expect(200)
  })
})
