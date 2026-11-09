import { it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../lib/prisma.js'
import { createOrder } from '../modules/orders/service.js'
import { cancelUnacceptedOrder } from '../modules/orders/cancellation.js'
import { processFulfillmentJob } from '../modules/fulfillment/jobProvider.js'
import { createTestUser, createTestProduct, makeManualService, loginAs, api, authHeader, createTestMerchant } from './helpers.js'
import { createJobFulfillmentProvider } from '../modules/fulfillment/jobProvider.js'
import { registerFulfillmentProvider } from '../modules/fulfillment/registry.js'
import { captureHeldOrder, releaseHeldOrder } from '../modules/orders/accounting.js'

it('R2-07: unknown cancellations stay held, enter the admin queue and require audited proof before refund', async () => {
  const { user } = await createTestUser('r2-review-buyer@test.local', 'pass123', 'user', 1000)
  const { user: admin } = await createTestUser('r2-review-admin@test.local', 'pass123', 'admin')
  const adminLogin = await loginAs(admin.email, 'pass123')
  const buyerLogin = await loginAs(user.email, 'pass123')
  const product = await createTestProduct('review unknown', 100, 0, [])
  await makeManualService(product.id)
  const offer = await prisma.offer.findFirstOrThrow({ where: { productId: product.id } })
  await prisma.offer.update({ where: { id: offer.id }, data: { externalIntegration: 'demo_license', externalSku: 'demo-unknown' } })
  const created = await createOrder(user.id, product.id, { idempotencyKey: randomUUID() })
  const orderId = created.orderId
  const job = await prisma.fulfillmentJob.findUniqueOrThrow({ where: { orderId } })
  const providerId = `review_${randomUUID().replaceAll('-', '').slice(0, 8)}`
  registerFulfillmentProvider(createJobFulfillmentProvider({ id: providerId, label: 'review test', isConfigured: () => true,
    execute: async () => ({ kind: 'unknown', code: 'UNKNOWN' }),
    query: async () => ({ kind: 'unknown', code: 'UNKNOWN' }),
    cancel: async () => ({ kind: 'unknown', code: 'UNKNOWN' }),
  }))
  await prisma.fulfillmentJob.update({ where: { id: job.id }, data: { providerId } })
  await processFulfillmentJob(job.id)
  expect(await cancelUnacceptedOrder(orderId, { kind: 'buyer', userId: user.id })).toBe('cancel_pending')
  await processFulfillmentJob(job.id)
  const endpoint = `/api/admin/orders/${orderId}/fulfillment-review`
  await api.post(endpoint).set(authHeader(buyerLogin.accessToken)).send({ action: 'retry' }).expect(403)
  const list = await api.get('/api/admin/orders').set(authHeader(adminLogin.accessToken)).query({ fulfillmentReview: 'true' }).expect(200)
  expect(list.body.items.map((row: { id: number }) => row.id)).toContain(orderId)
  await api.post(endpoint).set(authHeader(adminLogin.accessToken)).send({ action: 'retry' }).expect(200)
  expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({ balance: 900, frozenBalance: 100 })
  await api.post(endpoint).set(authHeader(adminLogin.accessToken)).send({ action: 'confirm_cancelled', evidence: '404' }).expect(400)
  const evidence = '供应商工单 REVIEW-123 已确认操作键撤销且禁止后续开通，核对时间 2026-11-09'
  await prisma.fulfillmentJob.update({ where: { id: job.id }, data: { leaseUntil: new Date(Date.now() + 60_000) } })
  await api.post(endpoint).set(authHeader(adminLogin.accessToken)).send({ action: 'confirm_cancelled', evidence }).expect(409)
  await prisma.fulfillmentJob.update({ where: { id: job.id }, data: { leaseUntil: null } })
  const refunded = await api.post(endpoint).set(authHeader(adminLogin.accessToken)).send({ action: 'confirm_cancelled', evidence }).expect(200)
  expect(refunded.body.outcome).toBe('refunded')
  expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({ balance: 1000, frozenBalance: 0 })
  expect(await prisma.adminLog.findFirst({ where: { adminUserId: admin.id, action: 'fulfillment.confirm_cancelled', targetId: orderId } })).toMatchObject({ detail: evidence })
  expect(await processFulfillmentJob(job.id)).toBe('skipped')
  await api.post(endpoint).set(authHeader(adminLogin.accessToken)).send({ action: 'confirm_cancelled', evidence }).expect(409)
  expect(await prisma.pointLog.count({ where: { orderId, type: 'release' } })).toBe(1)
})

it('SR-15: stale held-order snapshots cannot capture or release another orders reservation', async () => {
  const { user } = await createTestUser('r2-hold-cas@test.local', 'pass123', 'user', 1000)
  const product = await createTestProduct('hold CAS', 100, 0, [])
  await makeManualService(product.id)
  const first = await createOrder(user.id, product.id)
  const second = await createOrder(user.id, product.id)
  const snapshot = await prisma.order.findUniqueOrThrow({ where: { id: first.orderId } })
  await prisma.$transaction(async tx => {
    await captureHeldOrder(tx, snapshot, 'first capture')
    expect(await captureHeldOrder(tx, snapshot, 'stale capture')).toBeNull()
    expect(await releaseHeldOrder(tx, snapshot, 'stale release')).toBeNull()
  })
  expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({ balance: 800, frozenBalance: 100 })
  expect((await prisma.order.findUniqueOrThrow({ where: { id: second.orderId } })).holdingPoints).toBe(100)
  expect(await prisma.pointLog.count({ where: { orderId: first.orderId, type: 'out' } })).toBe(1)
})

it('manual evidence cannot bypass an active webhook lease or Xboard revoke verification', async () => {
  const { user: admin } = await createTestUser('r2-review-guards-admin@test.local', 'pass123', 'admin')
  const { user } = await createTestUser('r2-review-guards-buyer@test.local', 'pass123', 'user', 1000)
  const { merchant } = await createTestMerchant('r2-review-guards-merchant@test.local', 'pass123', { role: 'merchant', status: 'active' })
  const token = (await loginAs(admin.email, 'pass123')).accessToken
  const product = await createTestProduct('review guards', 100, 0, [])
  await makeManualService(product.id)
  const first = await createOrder(user.id, product.id)
  const hook = await prisma.merchantWebhookConfig.create({ data: { merchantId: merchant.id, url: 'https://merchant.example.test/hook', secretCiphertext: 'unused' } })
  const leaseUntil = new Date(Date.now() + 60_000)
  const task = await prisma.provisionTask.create({ data: { orderId: first.orderId, webhookConfigId: hook.id, attempts: 1, leaseUntil } })
  const endpoint = `/api/admin/orders/${first.orderId}/fulfillment-review`
  const evidence = '供应商工单 REVIEW-GUARDS 已确认撤销且禁止后续开通，核对日期 2026-11-09'
  await api.post(endpoint).set(authHeader(token)).send({ action: 'retry' }).expect(200)
  expect((await prisma.provisionTask.findUniqueOrThrow({ where: { id: task.id } })).leaseUntil).toEqual(leaseUntil)
  await api.post(endpoint).set(authHeader(token)).send({ action: 'confirm_cancelled', evidence }).expect(409)
  await prisma.provisionTask.update({ where: { id: task.id }, data: { leaseUntil: new Date(0) } })
  await api.post(endpoint).set(authHeader(token)).send({ action: 'confirm_cancelled', evidence }).expect(200)
  const second = await createOrder(user.id, product.id)
  await prisma.order.update({ where: { id: second.orderId }, data: { cancelRequestedAt: new Date() } })
  const faka = await prisma.fakaBridgeTask.create({ data: { orderId: second.orderId, status: 'needs_reconcile', attempts: 1,
    requestOrderNo: `MN-${second.orderId}`, emailSnapshot: user.email, skuSnapshot: 'test-only', revokeStatus: 'failed' } })
  await api.post(`/api/admin/orders/${second.orderId}/fulfillment-review`).set(authHeader(token)).send({ action: 'confirm_cancelled', evidence }).expect(409)
  expect((await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: faka.id } })).revokeStatus).toBe('failed')
  expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({ balance: 900, frozenBalance: 100 })
})
