import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { config } from '../config/index.js'
import * as accountBridge from '../lib/fakaBridge/accountV2.js'
import * as paidBridge from '../lib/fakaBridge/paidResetV2.js'
import { __clearFakaCapacityCacheForTests, __setFakaCapacityProbeForTests, fetchFakaCapacityForSku } from '../lib/fakaBridge/capacity.js'
import { __setBeforeFakaOfferTaskRecheckHookForTests, createOrder } from '../modules/orders/service.js'
import { getCheckoutPreview } from '../modules/checkout/service.js'
import { getProductDetail } from '../modules/products/service.js'
import { __setFakaClientOverridesForTests, processFakaBridgeTask } from '../modules/fakaBridge/service.js'
import { api, createTestUser } from './helpers.js'
import { enableAccountTests, linked } from './xboardAccountFixture.js'
import { getActiveNetworkNodeCategoryId } from './catalogFixture.js'

let restore: () => void
const capacity = vi.fn(async (sku: string) => ({ sku, planId: 3, capacityLimit: 1, activeUsers: 1, remaining: 0,
  sellable: false, source: 'xboard' as const }))
async function fixture(sku = 'plan-3-reset_traffic') {
  const { user } = await createTestUser(`${randomUUID()}@monexus.test`, 'pass123', 'user', 1000)
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: new Date() } })
  const { link } = await linked(user.id, '9007199254740993')
  await prisma.xboardAccountLink.update({ where: { id: link.id }, data: { currentEmail: 'changed@xboard.test' } })
  const product = await prisma.product.create({ data: { name: 'Paid reset checkout', type: '网络节点', price: 200,
    categoryId: await getActiveNetworkNodeCategoryId(), status: 'active', deliveryMode: 'manual_service', stockMode: 'unlimited',
    purchaseForm: [{ key: 'xboardEmail', label: 'Xboard 邮箱', type: 'text', required: true }] } })
  const offer = await prisma.offer.create({ data: { productId: product.id, name: 'Reset', price: 200, isDefault: true,
    deliveryMode: 'manual_service', stockMode: 'unlimited', externalIntegration: 'faka_bridge', externalSku: sku } })
  const token = jwt.sign({ userId: user.id, role: 'user' }, config.jwtSecret, { expiresIn: '5m' })
  return { user, link, product, offer, token }
}
async function quote(f: Awaited<ReturnType<typeof fixture>>) {
  const preview = await getCheckoutPreview(f.user.id, f.product.id, f.offer.id, f.link.id)
  return { offerId: f.offer.id, expectedPrice: preview.price, idempotencyKey: randomUUID(),
    xboardAccountLinkId: preview.xboardPaidReset!.selectedAccountLinkId!,
    expectedXboardTargetVersion: preview.xboardPaidReset!.targetVersion!,
    expectedPurchaseFormVersion: preview.purchaseFormVersion, expectedCheckoutVersion: preview.checkoutVersion }
}
async function unchangedFunds(userId: number) {
  expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId } })).toMatchObject({ balance: 1000, frozenBalance: 0 })
}
describe('stable account paid reset checkout', () => {
  beforeEach(async () => {
    restore = enableAccountTests()
    config.xboardAccounts.paidResetEnabled = true
    const caps = await accountBridge.callFakaV2Capabilities()
    if (!caps.ok) throw new Error('fixture')
    vi.mocked(accountBridge.callFakaV2Capabilities).mockResolvedValue({ ...caps, body: { ...caps.body,
      capabilities: { ...caps.body.capabilities, paid_reset_by_user_id: true } } })
    vi.spyOn(paidBridge, 'callPaidResetPreview').mockImplementation(async input => ({ ok: true, httpStatus: 200,
      body: { success: true, protocol_version: 2, request_id: randomUUID(), queried_at: new Date().toISOString(),
        preview: { user_id: input.user_id, sku: input.sku, plan_id: input.expected_plan_id,
          period: 'reset_traffic', eligible: true, block_reason: null } } }))
    capacity.mockClear()
    __setFakaCapacityProbeForTests(capacity)
  })
  afterEach(() => {
    __setBeforeFakaOfferTaskRecheckHookForTests(null)
    __setFakaClientOverridesForTests(undefined)
    __clearFakaCapacityCacheForTests()
    restore()
  })

  it.each(['plan-3-reset_traffic', 'plan-3-reset_price'])('creates stable held task for %s despite full plan and changed email, with no OTP proof', async sku => {
    const f = await fixture(sku)
    await fetchFakaCapacityForSku(sku)
    const preview = await getCheckoutPreview(f.user.id, f.product.id, f.offer.id)
    expect(preview).toMatchObject({ purchasable: true, requiresProvisionEmailProof: false, purchaseForm: [], fakaCapacity: null,
      xboardPaidReset: { selectedAccountLinkId: f.link.id, eligible: true } })
    expect(JSON.stringify(preview)).not.toContain('9007199254740993')
    expect(JSON.stringify(preview)).not.toContain('changed@xboard.test')
    const beforeCalls = capacity.mock.calls.length
    const result = await createOrder(f.user.id, f.product.id, await quote(f))
    expect(capacity).toHaveBeenCalledTimes(beforeCalls)
    expect(await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: result.orderId } })).toMatchObject({
      protocolVersion: 2, xboardUserIdSnapshot: '9007199254740993', emailSnapshot: 'changed@xboard.test',
      accountLinkIdSnapshot: f.link.id, periodSnapshot: 'reset_traffic', expectedPlanIdSnapshot: '3' })
    expect(await prisma.fakaProvisionEmailProof.count({ where: { email: 'changed@xboard.test' } })).toBe(0)
    expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId: f.user.id } })).toMatchObject({ balance: 800, frozenBalance: 200 })
  })

  it('threads authenticated preview/body target fields and rejects malformed or missing identities', async () => {
    const f = await fixture()
    expect((await api.get('/api/checkout/preview').query({ productId: f.product.id })).status).toBe(401)
    const preview = await api.get('/api/checkout/preview').set('Authorization', `Bearer ${f.token}`)
      .query({ productId: f.product.id, offerId: f.offer.id, xboardAccountLinkId: f.link.id })
    expect(preview.status).toBe(200)
    expect(preview.headers['cache-control']).toBe('no-store')
    const options = await quote(f)
    const { idempotencyKey, ...body } = options
    const invalid = await api.post('/api/orders').set('Authorization', `Bearer ${f.token}`).set('Idempotency-Key', idempotencyKey)
      .send({ productId: f.product.id, ...body, expectedXboardTargetVersion: undefined })
    expect(invalid.status).toBe(400)
    const result = await api.post('/api/orders').set('Authorization', `Bearer ${f.token}`).set('Idempotency-Key', idempotencyKey)
      .send({ productId: f.product.id, ...body })
    expect(result.status).toBe(201)
    expect((await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: result.body.orderId } })).protocolVersion).toBe(2)
  })

  it('replays the original order after gate/ownership changes and rejects same-key target changes', async () => {
    const f = await fixture(), options = await quote(f)
    const first = await createOrder(f.user.id, f.product.id, options)
    config.xboardAccounts.paidResetEnabled = false
    await prisma.xboardAccountLink.update({ where: { id: f.link.id }, data: { status: 'blocked' } })
    expect(await createOrder(f.user.id, f.product.id, options)).toMatchObject({ orderId: first.orderId, idempotentReplay: true })
    await expect(createOrder(f.user.id, f.product.id, { ...options, xboardAccountLinkId: randomUUID() })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await prisma.pointLog.count({ where: { orderId: first.orderId, type: 'hold' } })).toBe(1)
  })

  it('requires explicit selection for multiple accounts and returns only owned masked choices', async () => {
    const f = await fixture()
    await linked(f.user.id, '43')
    const other = await linked(undefined, '44')
    const preview = await getCheckoutPreview(f.user.id, f.product.id, f.offer.id)
    expect(preview.purchasable).toBe(false)
    expect(preview.xboardPaidReset?.selectedAccountLinkId).toBeNull()
    expect(preview.xboardPaidReset?.accounts).toHaveLength(2)
    expect(preview.xboardPaidReset?.accounts.map(a => a.id)).not.toContain(other.link.id)
    await expect(getCheckoutPreview(f.user.id, f.product.id, f.offer.id, other.link.id)).rejects.toMatchObject({ status: 404 })
  })

  it('keeps an explicit owned target visible beyond the bounded account list', async () => {
    const f = await fixture(), selected = 'ffffffff-ffff-4fff-afff-ffffffffffff'
    await prisma.xboardAccountLink.createMany({ data: Array.from({ length: 101 }, (_, i) => ({
      id: i === 100 ? selected : randomUUID(), userId: f.user.id, instanceId: f.link.instanceId,
      xboardUserId: String(i + 1), currentEmail: `panel-${i}@panel.test`, emailSnapshot: `panel-${i}@panel.test`,
      sourceOrderId: f.link.sourceOrderId, sourceExternalOrderNo: f.link.sourceExternalOrderNo,
    })) })
    const preview = await getCheckoutPreview(f.user.id, f.product.id, f.offer.id, selected)
    expect(preview.xboardPaidReset?.accounts).toHaveLength(100)
    expect(preview.xboardPaidReset?.accounts.map(a => a.id)).toContain(selected)
    expect(preview.xboardPaidReset?.selectedAccountLinkId).toBe(selected)
  })

  it.each(['blocked', 'foreign', 'missing', 'capability', 'disabled'] as const)('rejects %s target without a hold or v1 fallback', async mode => {
    const f = await fixture(), options = await quote(f)
    if (mode === 'blocked') await prisma.xboardAccountLink.update({ where: { id: f.link.id }, data: { status: 'blocked' } })
    if (mode === 'foreign') options.xboardAccountLinkId = (await linked(undefined, '43')).link.id
    if (mode === 'missing') options.xboardAccountLinkId = randomUUID()
    if (mode === 'capability') {
      const caps = await accountBridge.callFakaV2Capabilities()
      if (caps.ok) vi.mocked(accountBridge.callFakaV2Capabilities).mockResolvedValue({ ...caps, body: { ...caps.body,
        capabilities: { ...caps.body.capabilities, paid_reset_by_user_id: false } } })
    }
    if (mode === 'disabled') config.xboardAccounts.paidResetEnabled = false
    await expect(createOrder(f.user.id, f.product.id, options)).rejects.toThrow()
    await unchangedFunds(f.user.id)
    expect(await prisma.order.count({ where: { productId: f.product.id } })).toBe(0)
    expect(await prisma.fakaBridgeTask.count({ where: { protocolVersion: 2 } })).toBe(0)
  })

  it('does not fall back to email checkout when the client omits the target', async () => {
    const f = await fixture()
    await expect(createOrder(f.user.id, f.product.id, { offerId: f.offer.id, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'CHECKOUT_CHANGED' })
    await unchangedFunds(f.user.id)
  })

  it('rejects a changed stable target during the remote preview and before holding funds', async () => {
    const f = await fixture(), options = await quote(f)
    const original = vi.mocked(paidBridge.callPaidResetPreview).getMockImplementation()!
    vi.mocked(paidBridge.callPaidResetPreview).mockImplementation(async (...args) => {
      await prisma.xboardAccountLink.update({ where: { id: f.link.id }, data: { xboardUserId: '43' } })
      return original(...args)
    })
    await expect(createOrder(f.user.id, f.product.id, options)).rejects.toMatchObject({ code: 'CHECKOUT_CHANGED' })
    await unchangedFunds(f.user.id)
  })

  it('rejects an offer SKU race without leaving an order/hold/task', async () => {
    const f = await fixture(), options = await quote(f)
    __setBeforeFakaOfferTaskRecheckHookForTests(async () => {
      await prisma.offer.update({ where: { id: f.offer.id }, data: { externalSku: 'plan-4-reset_traffic' } })
    })
    await expect(createOrder(f.user.id, f.product.id, options)).rejects.toMatchObject({ code: 'CHECKOUT_CHANGED' })
    await unchangedFunds(f.user.id)
    expect(await prisma.order.count({ where: { productId: f.product.id } })).toBe(0)
  })

  it('enforces remote eligibility, price and local stock while exempting only new-subscription capacity', async () => {
    const f = await fixture(), options = await quote(f)
    await expect(createOrder(f.user.id, f.product.id, { ...options, expectedPrice: 201 })).rejects.toMatchObject({ code: 'PRICE_CHANGED' })
    await prisma.offer.update({ where: { id: f.offer.id }, data: { stockMode: 'limited', stock: 0 } })
    await expect(createOrder(f.user.id, f.product.id, { ...options, expectedCheckoutVersion: undefined })).rejects.toThrow('库存不足')
    await prisma.offer.update({ where: { id: f.offer.id }, data: { stockMode: 'unlimited' } })
    const original = vi.mocked(paidBridge.callPaidResetPreview).getMockImplementation()!
    vi.mocked(paidBridge.callPaidResetPreview).mockImplementation(async (...args) => {
      const result = await original(...args)
      return result.ok ? { ...result, body: { ...result.body, preview: { ...result.body.preview, eligible: false, block_reason: 'SUBSCRIPTION_INELIGIBLE' } } } : result
    })
    expect((await getCheckoutPreview(f.user.id, f.product.id, f.offer.id, f.link.id)).purchasable).toBe(false)
    await expect(createOrder(f.user.id, f.product.id, { ...options, expectedCheckoutVersion: undefined })).rejects.toThrow('当前账号套餐不可购买')
    await unchangedFunds(f.user.id)
  })

  it('keeps normal subscription email/capacity validation and rejects account-target injection', async () => {
    const f = await fixture('plan-3-monthly')
    await expect(getCheckoutPreview(f.user.id, f.product.id, f.offer.id, f.link.id)).rejects.toThrow('此规格不支持')
    await expect(createOrder(f.user.id, f.product.id, { offerId: f.offer.id, xboardAccountLinkId: f.link.id,
      expectedXboardTargetVersion: 'a'.repeat(64), idempotencyKey: randomUUID() })).rejects.toThrow('此规格不支持')
    await expect(createOrder(f.user.id, f.product.id, { offerId: f.offer.id, formAnswers: { xboardEmail: f.user.email } })).rejects.toThrow('名额已满')
    await unchangedFunds(f.user.id)
  })

  it('public detail leaves reset selectable at full capacity while retaining local sold-out state', async () => {
    const f = await fixture()
    await fetchFakaCapacityForSku(f.offer.externalSku!)
    const detail = await getProductDetail(f.product.id, 'member')
    expect(detail.offers[0]).toMatchObject({ availability: { status: 'available' } })
    expect(detail.offers[0]).not.toHaveProperty('fakaCapacity')
    await prisma.offer.update({ where: { id: f.offer.id }, data: { stockMode: 'limited', stock: 0 } })
    expect((await getProductDetail(f.product.id, 'member')).offers[0].availability.status).toBe('unavailable')
  })

  it('delivers and captures a real checkout-created v2 task with strict remote evidence', async () => {
    const f = await fixture(), result = await createOrder(f.user.id, f.product.id, await quote(f))
    const task = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: result.orderId } })
    __setFakaClientOverridesForTests({ url: config.fakaBridge.url, secret: config.fakaBridge.secret, transport: async req => {
      const sent = JSON.parse(req.body!)
      const before = { plan_id: '3', transfer_enable: '1000', expired_at: null, last_reset_at: null, reset_count: '1', next_reset_at: null, u: '1', d: '2' }
      return { status: 200, text: JSON.stringify({ success: true, protocol_version: 2, request_id: sent.request_id, queried_at: new Date().toISOString(),
        operation: { order_no: sent.order_no, user_id: sent.user_id, sku: sent.sku, plan_id: '3', period: 'reset_traffic',
          payload_hash: paidBridge.paidResetPayloadHash({ order_no: sent.order_no, user_id: sent.user_id, sku: sent.sku,
            expected_plan_id: '3', period: 'reset_traffic' }, task.clientIdSnapshot!), status: 'completed', trade_no: 'PAID-CHECKOUT-1', error_code: null,
          before, after: { ...before, reset_count: '2', u: '0', d: '0' }, completed_at: new Date().toISOString() } }) }
    } })
    expect(await processFakaBridgeTask(task.id)).toBe('succeeded')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: result.orderId } })).status).toBe('delivered')
    expect(await prisma.pointAccount.findUniqueOrThrow({ where: { userId: f.user.id } })).toMatchObject({ balance: 800, frozenBalance: 0 })
  })
})
