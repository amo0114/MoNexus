import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { app } from '../app.js'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { __setRedisForTests, __resetRedisForTests, type RedisLike } from '../lib/redis.js'
import { prepareSignedJsonV2 } from '../lib/signedProtocolV2.js'
import * as bridge from '../lib/fakaBridge/accountV2.js'
import * as paid from '../lib/fakaBridge/paidResetV2.js'
import { purchaseReset } from '../modules/xboardAccounts/purchase.js'
import { paidResetHistory } from '../modules/xboardAccounts/resetHistory.js'
import { profile } from '../modules/xboardAccounts/queries.js'
import { enableAccountTests, linked, instanceId } from './xboardAccountFixture.js'

let restore: () => void
class ReplayStore implements RedisLike {
  values = new Set<string>()
  async get() { return null }
  async set(key: string) { if (this.values.has(key)) return null; this.values.add(key); return 'OK' }
  async del() { return 0 }
  async incr() { return 1 }
  async ping() { return 'PONG' }
  async eval(_s: string, _n: number, _key: string, ttl: string) { return [1, Number(ttl)] }
}
function send(platformId: string, fields = {}) {
  const s = prepareSignedJsonV2({ audience: 'bot', path: '/api/bot/v2/xboard/purchase-reset',
    body: { platform: 'qq', platformId, ...fields }, secret: 'bot-test' })
  return request(app).post(s.path).set(s.headers).send(s.body)
}
async function fixture(sku = 'plan-3-reset_traffic') {
  const f = await linked(undefined, '9007199254740993')
  await prisma.product.update({ where: { id: f.product.id }, data: { status: 'active' } })
  const offer = await prisma.offer.create({ data: { productId: f.product.id, name: 'Reset', price: 123,
    deliveryMode: 'manual_service', stockMode: 'unlimited', externalIntegration: 'faka_bridge', externalSku: sku } })
  return { ...f, offer }
}
function proof(no: string, userId = '9007199254740993', status: 'completed' | 'revoked' = 'completed') {
  const payload = { order_no: no, user_id: userId, sku: 'plan-3-reset_traffic', expected_plan_id: '3', period: 'reset_traffic' as const }
  const before = { plan_id: '3', transfer_enable: '100', expired_at: null, last_reset_at: null, reset_count: '8', next_reset_at: null, u: '9', d: '2' }
  return { ...payload, expected_plan_id: undefined, plan_id: '3', status, payload_hash: paid.paidResetPayloadHash(payload, 'monexus'),
    trade_no: `TRADE-${no}`, error_code: null, before, after: { ...before, u: '0', d: '0', reset_count: '9' }, completed_at: '2026-10-25T12:00:00.000Z' }
}
async function historyTask(f: Awaited<ReturnType<typeof fixture>>, no: string, result: unknown, options: { status?: string; refunded?: boolean; remoteId?: string; ownerId?: number } = {}) {
  const order = await prisma.order.create({ data: { userId: options.ownerId ?? f.user.id, productId: f.product.id, price: 123, status: options.refunded ? 'refunded' : 'delivered' } })
  return prisma.fakaBridgeTask.create({ data: { orderId: order.id, requestOrderNo: no, emailSnapshot: 'unrelated@panel.test',
    protocolVersion: 2, instanceIdSnapshot: instanceId, originSnapshot: 'https://xboard.test', xboardUserIdSnapshot: options.remoteId ?? f.link.xboardUserId,
    accountLinkIdSnapshot: randomUUID(), expectedPlanIdSnapshot: '3', clientIdSnapshot: 'monexus', skuSnapshot: 'plan-3-reset_traffic', periodSnapshot: 'reset_traffic',
    status: options.status ?? 'succeeded', paidResetResult: JSON.parse(JSON.stringify(result)) } })
}

describe('QQ paid reset pointer and verified execution coverage', () => {
  beforeEach(async () => {
    restore = enableAccountTests()
    config.xboardAccounts.paidResetEnabled = true
    __setRedisForTests(new ReplayStore())
    const caps = await bridge.callFakaV2Capabilities()
    if (!caps.ok) throw new Error('fixture')
    vi.mocked(bridge.callFakaV2Capabilities).mockResolvedValue({ ...caps, body: { ...caps.body, capabilities: { ...caps.body.capabilities, paid_reset_by_user_id: true } } })
    vi.spyOn(paid, 'callPaidResetPreview').mockImplementation(async p => ({ ok: true, httpStatus: 200, body: {
      success: true, protocol_version: 2, request_id: randomUUID(), queried_at: new Date().toISOString(),
      preview: { user_id: p.user_id, sku: p.sku, plan_id: p.expected_plan_id, period: 'reset_traffic', eligible: true, block_reason: null } } }))
  })
  afterEach(() => { __resetRedisForTests(); restore() })

  it.each(['plan-3-reset_traffic', ' PLAN-3-RESET_PRICE '])('returns only the exact current-plan %s offer and selected stable account, without a charge', async sku => {
    const f = await fixture(sku)
    await prisma.offer.create({ data: { productId: f.product.id, name: 'Wrong default', price: 1, isDefault: true,
      externalIntegration: 'faka_bridge', externalSku: 'plan-3-monthly' } })
    const result = await send(f.actor.platformId)
    expect(result.status).toBe(200)
    expect(result.headers['cache-control']).toContain('no-store')
    expect(result.body).toEqual({ bound: true, accountLinkId: f.link.id, blockReason: null,
      purchase: { productId: f.product.id, offerId: f.offer.id, accountLinkId: f.link.id, price: 123 } })
    expect(JSON.stringify(result.body)).not.toContain(f.email)
    expect(JSON.stringify(result.body)).not.toContain(f.link.xboardUserId)
    expect(await prisma.order.count()).toBe(1)
    expect(await prisma.fakaBridgeTask.count()).toBe(1)
    expect(await prisma.pointLog.count()).toBe(0)
  })

  it('tries the alternate reset SKU when the first is not for sale', async () => {
    const f = await fixture()
    const alias = await prisma.offer.create({ data: { productId: f.product.id, name: 'Alias', price: 234,
      deliveryMode: 'manual_service', stockMode: 'unlimited', externalIntegration: 'faka_bridge', externalSku: 'plan-3-reset_price' } })
    const original = vi.mocked(paid.callPaidResetPreview).getMockImplementation()!
    vi.mocked(paid.callPaidResetPreview).mockImplementationOnce(async (...args) => {
      const result = await original(...args)
      if (!result.ok) throw new Error('fixture')
      return { ...result, body: { ...result.body, preview: { ...result.body.preview, eligible: false, block_reason: 'RESET_NOT_FOR_SALE' } } }
    })
    expect((await purchaseReset(f.actor)).purchase?.offerId).toBe(alias.id)
  })

  it('filters unavailable products before choosing bounded canonical SKU candidates', async () => {
    const f = await fixture()
    await prisma.product.update({ where: { id: f.product.id }, data: { status: 'inactive' } })
    for (let i = 1; i <= 20; i++) await prisma.offer.create({ data: { productId: f.product.id, name: 'Hidden duplicate', price: 1,
      deliveryMode: 'manual_service', stockMode: 'unlimited', externalIntegration: 'faka_bridge', externalSku: ' '.repeat(i) + 'plan-3-reset_traffic' } })
    const product = await prisma.product.create({ data: { name: 'Visible reset', type: '网络节点', categoryId: f.product.categoryId, status: 'active', price: 300 } })
    const visible = await prisma.offer.create({ data: { productId: product.id, name: 'Visible', price: 300,
      deliveryMode: 'manual_service', stockMode: 'unlimited', externalIntegration: 'faka_bridge', externalSku: 'plan-3-reset_traffic ' } })
    expect((await purchaseReset(f.actor)).purchase?.offerId).toBe(visible.id)
  })

  it('requires signed owned-account selection, strict fields, and the paid gate', async () => {
    const f = await fixture(), other = await linked(undefined, '43')
    expect((await send('999999')).body).toEqual({ bound: false })
    expect((await send(f.actor.platformId, { accountLinkId: other.link.id })).status).toBe(404)
    expect((await send(f.actor.platformId, { email: f.email })).status).toBe(400)
    await linked(f.user.id, '44')
    expect((await send(f.actor.platformId)).body.error.code).toBe('XBOARD_ACCOUNT_SELECTION_REQUIRED')
    expect((await send(f.actor.platformId, { accountLinkId: f.link.id })).status).toBe(200)
    await prisma.xboardAccountLink.update({ where: { id: f.link.id }, data: { status: 'blocked' } })
    expect((await send(f.actor.platformId, { accountLinkId: f.link.id })).status).toBe(409)
    config.xboardAccounts.paidResetEnabled = false
    expect((await send(f.actor.platformId)).body.error.code).toBe('XBOARD_PAID_RESET_UNAVAILABLE')
  })

  it.each(['offer', 'product', 'archived', 'stock'])('does not emit an unavailable %s pointer', async kind => {
    const f = await fixture()
    if (kind === 'offer') await prisma.offer.update({ where: { id: f.offer.id }, data: { status: 'inactive' } })
    if (kind === 'product') await prisma.product.update({ where: { id: f.product.id }, data: { status: 'inactive' } })
    if (kind === 'archived') await prisma.product.update({ where: { id: f.product.id }, data: { archivedAt: new Date() } })
    if (kind === 'stock') await prisma.offer.update({ where: { id: f.offer.id }, data: { stockMode: 'limited', stock: 0 } })
    expect(await purchaseReset(f.actor)).toEqual({ accountLinkId: f.link.id, purchase: null, blockReason: 'NO_OFFER' })
    expect(paid.callPaidResetPreview).not.toHaveBeenCalled()
  })

  it('does not substitute monthly or another-plan products when there is no matching reset', async () => {
    const f = await fixture('plan-4-reset_traffic')
    expect((await purchaseReset(f.actor)).blockReason).toBe('NO_OFFER')
    expect(paid.callPaidResetPreview).not.toHaveBeenCalled()
  })

  it('fails closed on fresh remote failure, revoked capability and ineligible subscription', async () => {
    const f = await fixture()
    vi.mocked(bridge.callFakaV2Subscription).mockResolvedValueOnce({ ok: false, code: 'TIMEOUT', httpStatus: 0 })
    await expect(purchaseReset(f.actor)).rejects.toMatchObject({ code: 'XBOARD_CAPABILITY_UNAVAILABLE' })
    vi.mocked(bridge.callFakaV2Capabilities).mockResolvedValueOnce({ ok: false, code: 'TIMEOUT', httpStatus: 0 })
    await expect(purchaseReset(f.actor)).rejects.toMatchObject({ code: 'XBOARD_CAPABILITY_UNAVAILABLE' })
    const remote = await bridge.callFakaV2Subscription(f.link.xboardUserId)
    if (!remote.ok) throw new Error('fixture')
    vi.mocked(bridge.callFakaV2Subscription).mockResolvedValueOnce({ ...remote, body: { ...remote.body, subscription: { ...remote.body.subscription, status: 'expired' } } })
    expect((await purchaseReset(f.actor)).blockReason).toBe('SUBSCRIPTION_INELIGIBLE')
  })

  it('rechecks binding and catalog after remote preview and never returns a withdrawn offer', async () => {
    const f = await fixture()
    const original = vi.mocked(paid.callPaidResetPreview).getMockImplementation()!
    vi.mocked(paid.callPaidResetPreview).mockImplementationOnce(async (...args) => {
      await prisma.offer.update({ where: { id: f.offer.id }, data: { status: 'inactive' } })
      return original(...args)
    })
    expect((await purchaseReset(f.actor)).blockReason).toBe('NO_OFFER')
    await prisma.offer.update({ where: { id: f.offer.id }, data: { status: 'active' } })
    vi.mocked(paid.callPaidResetPreview).mockImplementationOnce(async (...args) => {
      await prisma.chatBinding.delete({ where: { id: f.actor.bindingId } })
      return original(...args)
    })
    await expect(purchaseReset(f.actor)).rejects.toMatchObject({ code: 'XBOARD_BINDING_CHANGED' })
  })

  it('rejects a stable account retargeted during subscription lookup for both purchase and profile', async () => {
    const f = await fixture()
    const original = vi.mocked(bridge.callFakaV2Subscription).getMockImplementation()!
    const mutate = async (id: string) => {
      await prisma.xboardAccountLink.update({ where: { id: f.link.id }, data: { xboardUserId: '43' } })
      return original(id)
    }
    vi.mocked(bridge.callFakaV2Subscription).mockImplementationOnce(mutate)
    await expect(purchaseReset(f.actor)).rejects.toMatchObject({ code: 'CHECKOUT_CHANGED' })
    await prisma.xboardAccountLink.update({ where: { id: f.link.id }, data: { xboardUserId: f.link.xboardUserId } })
    vi.mocked(bridge.callFakaV2Subscription).mockImplementationOnce(mutate)
    await expect(profile(f.actor)).rejects.toMatchObject({ code: 'CHECKOUT_CHANGED' })
    expect((await prisma.xboardAccountLink.findUniqueOrThrow({ where: { id: f.link.id } })).currentEmail).toBe(f.email)
  })

  it('reports bounded history as a lower bound instead of claiming a complete paid total', async () => {
    const f = await fixture()
    await historyTask(f, 'OLDER-EXECUTION', proof('OLDER-EXECUTION'))
    const orders = await prisma.order.createManyAndReturn({ data: Array.from({ length: 1000 }, () => ({
      userId: f.user.id, productId: f.product.id, price: 123 })) })
    await prisma.fakaBridgeTask.createMany({ data: orders.map(order => ({ orderId: order.id, requestOrderNo: `PENDING-${order.id}`,
      emailSnapshot: f.email, skuSnapshot: 'plan-3-reset_traffic', periodSnapshot: 'reset_traffic', protocolVersion: 2,
      accountLinkIdSnapshot: f.link.id, instanceIdSnapshot: instanceId, originSnapshot: 'https://xboard.test',
      xboardUserIdSnapshot: f.link.xboardUserId, expectedPlanIdSnapshot: '3', clientIdSnapshot: 'monexus' })) })
    expect(await paidResetHistory(f.user.id, { ...f.link, origin: 'https://xboard.test' })).toEqual({ successful: 0, truncated: true, coverageFrom: null })
  })

  it('counts verified execution once across retries/refunds, excluding v1, foreign targets and malformed proof', async () => {
    const f = await fixture(), stranger = await linked(undefined, '44')
    await historyTask(f, 'RESET-1', proof('RESET-1'))
    await historyTask(f, 'RESET-1', proof('RESET-1'), { status: 'needs_reconcile' })
    await historyTask(f, 'REFUNDED', proof('REFUNDED', f.link.xboardUserId, 'revoked'), { refunded: true, status: 'cancelled' })
    await historyTask(f, 'TOMBSTONE', { ...proof('TOMBSTONE', f.link.xboardUserId, 'revoked'), before: null, after: null, trade_no: null, completed_at: null }, { refunded: true })
    await historyTask(f, 'BAD-HASH', { ...proof('BAD-HASH'), payload_hash: '0'.repeat(64) })
    await historyTask(f, 'BAD-DELTA', { ...proof('BAD-DELTA'), after: proof('BAD-DELTA').before })
    await historyTask(f, 'UNPROVEN', { status: 'completed', after: {} })
    await historyTask(f, 'OTHER-TARGET', proof('OTHER-TARGET', '43'), { remoteId: '43' })
    await historyTask(f, 'OTHER-OWNER', proof('OTHER-OWNER'), { ownerId: stranger.user.id })
    const summary = await paidResetHistory(f.user.id, { ...f.link, origin: 'https://xboard.test' })
    expect(summary).toMatchObject({ successful: 2, truncated: false })
    config.xboardAccounts.paidResetEnabled = false
    expect((await profile(f.actor)).resetHistory).toMatchObject({ freeSuccessfulForAccount: 0,
      paidSuccessfulForAccount: 2, platformSuccessfulForAccount: 2, coverageScope: 'verified_v2_only', truncated: false })
  })
})
