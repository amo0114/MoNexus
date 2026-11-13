import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import * as client from '../lib/fakaBridge/client.js'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { getActiveNetworkNodeCategoryId } from './catalogFixture.js'
import { fakaSettings } from '../modules/admin/fakaSettings.js'
import { createOrder } from '../modules/orders/service.js'
import { __setFakaClientOverridesForTests, processFakaBridgeTask, runFakaBridgeBatch } from '../modules/fakaBridge/worker.js'
import { onFakaOrderRefundedInTx, processFakaRevokeTask, runFakaRevokeBatch, runFakaReconcileBatch } from '../modules/fakaBridge/lifecycle.js'
import { activeFakaSnapshot, withActiveFaka } from '../lib/runtimeSettings/fakaBridge.js'
import { __clearFakaCapacityCacheForTests, __setFakaCapacityProbeForTests, fetchFakaCapacityForSku } from '../lib/fakaBridge/capacity.js'

const initial = { bridge: config.fakaBridge, key: config.integrationCredentialsEncKey, instanceId: config.xboardAccounts.instanceId }
const settings = (origin: string) => ({ url: `${origin}/plugin/faka-bridge/order-paid`, statusUrl: `${origin}/plugin/faka-bridge/order-status`,
  revokeUrl: `${origin}/plugin/faka-bridge/order-revoke`, panelUrl: origin, timeoutMs: 3000, maxAttempts: 3, instanceId: null, clientId: 'monexus' })
const credentials = { secret: 'RUNTIME-FAKA-SECRET-SENTINEL' }
let actor: number
beforeEach(async () => {
  config.integrationCredentialsEncKey = 'ac'.repeat(32)
  config.xboardAccounts.instanceId = undefined
  config.fakaBridge = { ...initial.bridge, ...settings('https://a.example.com'), ...credentials, enabled: true, allowInsecureTargets: false }
  actor = (await createTestUser('runtime-faka-admin@test.local', 'pass123', 'admin')).user.id
  vi.spyOn(client, 'callFakaPlanCatalog').mockResolvedValue({ ok: true, httpStatus: 200, code: 'UNKNOWN', rawText: '', body: { success: true, plans: [] } } as never)
})
afterEach(() => { config.fakaBridge = initial.bridge; config.integrationCredentialsEncKey = initial.key; config.xboardAccounts.instanceId = initial.instanceId; vi.restoreAllMocks(); __setFakaClientOverridesForTests(); __clearFakaCapacityCacheForTests() })
async function activate(origin: string, version: number, legacyConfirmed = true) {
  const saved = await fakaSettings.api.save(actor, { expectedVersion: version, settings: settings(origin), credentials })
  await fakaSettings.api.test(actor, saved.version)
  return fakaSettings.api.activate(actor, saved.version, legacyConfirmed)
}
async function order() {
  const { user } = await createTestUser(`${randomUUID()}@test.local`, 'pass123', 'user', 1000)
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: new Date(Date.now() - 10000) } })
  const product = await prisma.product.create({ data: { name: 'runtime task', type: '网络节点', categoryId: await getActiveNetworkNodeCategoryId(), price: 200, status: 'active', stock: 0, deliveryMode: 'manual_service', stockMode: 'unlimited' } })
  const offer = await prisma.offer.create({ data: { productId: product.id, name: '月卡', isDefault: true, price: 200, deliveryMode: 'manual_service', stockMode: 'unlimited', externalIntegration: 'faka_bridge', externalSku: `aster-${randomUUID()}-monthly`, validityDays: 30 } })
  const result = await withActiveFaka(() => createOrder(user.id, product.id, { offerId: offer.id, expectedPrice: 200, idempotencyKey: randomUUID() }))
  return prisma.fakaBridgeTask.findUniqueOrThrow({ where: { orderId: result.orderId } })
}
describe('version-bound FakaBridge runtime', () => {
  it('does not let unreadable refunded tasks with future schedules or active leases fill later batches', async () => {
    const first = await activate('https://a.example.com', 0)
    const damaged = await order()
    await activate('https://b.example.com', first.version)
    const healthy = await order()
    await prisma.order.updateMany({ data: { status: 'refunded' } })
    await prisma.fakaBridgeTask.updateMany({ data: { status: 'succeeded', nextAttemptAt: new Date(Date.now() - 1000) } })
    await prisma.integrationConfigRevision.update({ where: { id: first.activeRevisionId! }, data: { credentialsCiphertext: 'damaged-ciphertext' } })
    const scheduledAt = new Date(Date.now() + 60 * 60_000)
    await prisma.fakaBridgeTask.update({ where: { id: damaged.id }, data: { nextAttemptAt: scheduledAt } })
    expect(await runFakaReconcileBatch(1)).toBe(0)
    let deferred = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: damaged.id } })
    expect(deferred.lastError).toBe('CONFIG_UNAVAILABLE')
    expect(deferred.nextAttemptAt).toEqual(scheduledAt)
    expect(await runFakaReconcileBatch(1)).toBe(1)

    // An active worker keeps its scheduling/error/lease snapshot intact, while
    // a healthy unleased task is selected first even with a single-item batch.
    const leaseUntil = new Date(Date.now() + 60_000)
    const leaseToken = randomUUID()
    await prisma.fakaBridgeTask.update({ where: { id: damaged.id }, data: {
      nextAttemptAt: new Date(Date.now() - 1000), leaseUntil, leaseToken, lastError: null,
    } })
    await prisma.fakaBridgeTask.update({ where: { id: healthy.id }, data: { revokeStatus: null } })
    expect(await runFakaReconcileBatch(1)).toBe(1)
    expect(await runFakaReconcileBatch(1)).toBe(0)
    deferred = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: damaged.id } })
    expect(deferred).toMatchObject({ leaseToken, leaseUntil, lastError: null, status: 'succeeded', configRevisionId: damaged.configRevisionId })
  })
  it.each(['provision', 'revoke', 'refunded_reconcile', 'pending_reconcile'] as const)(
    'defers damaged historical credentials without blocking healthy %s tasks', async stage => {
      const first = await activate('https://a.example.com', 0)
      const damaged = await order()
      await activate('https://b.example.com', first.version)
      const healthy = await order()
      const destinations: string[] = []
      __setFakaClientOverridesForTests({ transport: async req => {
        destinations.push(new URL(req.url).origin)
        const body = req.method === 'POST' ? JSON.parse(req.body!) : Object.fromEntries(new URL(req.url).searchParams)
        return { status: 200, text: JSON.stringify({ success: true, order_no: body.order_no,
          status: req.url.includes('revoke') ? 'revoked' : 'completed', trade_no: `T-${body.order_no}` }) }
      } })
      if (stage === 'revoke' || stage === 'refunded_reconcile') {
        await processFakaBridgeTask(damaged.id)
        await processFakaBridgeTask(healthy.id)
        for (const task of [damaged, healthy]) await prisma.$transaction(async tx => {
          await tx.order.update({ where: { id: task.orderId }, data: { status: 'refunded' } })
          if (stage === 'revoke') await onFakaOrderRefundedInTx(tx, task.orderId)
        })
      }
      const due = new Date(Date.now() - 180_000)
      await prisma.fakaBridgeTask.updateMany({ data: { createdAt: due, nextAttemptAt: due } })
      const original = await prisma.integrationConfigRevision.findUniqueOrThrow({ where: { id: first.activeRevisionId! } })
      await prisma.integrationConfigRevision.update({ where: { id: original.id }, data: { credentialsCiphertext: 'damaged-ciphertext' } })
      destinations.length = 0
      const run = stage === 'provision' ? runFakaBridgeBatch : stage === 'revoke' ? runFakaRevokeBatch : runFakaReconcileBatch
      expect(await run()).toBe(1)
      const deferred = await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: damaged.id } })
      expect(deferred.configRevisionId).toBe(damaged.configRevisionId)
      expect(deferred.lastError).toBe('CONFIG_UNAVAILABLE')
      expect(deferred.nextAttemptAt.getTime()).toBeGreaterThan(Date.now())
      expect(deferred.attempts).toBe(stage === 'revoke' || stage === 'refunded_reconcile' ? 1 : 0)
      expect(destinations).toEqual(stage === 'refunded_reconcile' ? [] : ['https://b.example.com'])
      if (stage === 'refunded_reconcile') {
        expect((await prisma.fakaBridgeTask.findUniqueOrThrow({ where: { id: healthy.id } })).revokeStatus).toBe('pending')
      }
      // Repair and retry preserves the original destination rather than using B.
      await prisma.integrationConfigRevision.update({ where: { id: original.id }, data: { credentialsCiphertext: original.credentialsCiphertext } })
      await prisma.fakaBridgeTask.update({ where: { id: damaged.id }, data: { nextAttemptAt: due } })
      expect(await run()).toBe(1)
      expect(destinations).toEqual(stage === 'refunded_reconcile' ? [] : ['https://b.example.com', 'https://a.example.com'])
    },
  )
  it('freezes legacy and newly accepted tasks; activation and disable do not reroute provision or later refund revoke', async () => {
    const legacy = await order()
    expect(legacy.configRevisionId).toBeNull()
    const first = await activate('https://a.example.com', 0)
    const bound = await order()
    expect(bound.configRevisionId).toBe(first.activeRevisionId)
    const second = await activate('https://b.example.com', first.version)
    const newer = await order()
    expect(newer.configRevisionId).toBe(second.activeRevisionId)
    await fakaSettings.api.enabled(actor, second.version, false)
    Object.assign(config.fakaBridge, { url: 'https://wrong.example.com/plugin/faka-bridge/order-paid', secret: 'CHANGED-ENV-SENTINEL' })
    const destinations: string[] = []
    __setFakaClientOverridesForTests({ transport: async req => {
      destinations.push(new URL(req.url).origin)
      const body = req.method === 'POST' ? JSON.parse(req.body!) : Object.fromEntries(new URL(req.url).searchParams)
      return { status: 200, text: JSON.stringify({ success: true, order_no: body.order_no, status: req.url.includes('revoke') ? 'revoked' : 'completed', trade_no: `T-${body.order_no}` }) }
    } })
    expect(await processFakaBridgeTask(legacy.id)).toBe('succeeded')
    expect(await processFakaBridgeTask(bound.id)).toBe('succeeded')
    expect(await processFakaBridgeTask(newer.id)).toBe('succeeded')
    await prisma.$transaction(async tx => {
      await tx.order.update({ where: { id: bound.orderId }, data: { status: 'refunded' } })
      await onFakaOrderRefundedInTx(tx, bound.orderId)
    })
    expect(await processFakaRevokeTask(bound.id)).toBe('succeeded')
    expect(destinations).toEqual(['https://a.example.com', 'https://a.example.com', 'https://b.example.com', 'https://a.example.com'])
    expect((await activeFakaSnapshot()).bridge.enabled).toBe(false)
    expect(JSON.stringify(await prisma.adminLog.findMany())).not.toContain(credentials.secret)
    await expect(prisma.fakaBridgeTask.update({ where: { id: bound.id }, data: { configRevisionId: newer.configRevisionId } })).rejects.toThrow()
  })
  it('requires confirmed trustworthy bootstrap and does not send preserved secrets to a new destination', async () => {
    await order()
    await expect(activate('https://b.example.com', 0, false)).rejects.toMatchObject({ status: 400 })
    await expect(fakaSettings.api.save(actor, { expectedVersion: 1, settings: settings('https://c.example.com') })).rejects.toMatchObject({ status: 400 })
    config.fakaBridge = { ...config.fakaBridge, enabled: false, secret: undefined, url: undefined } as typeof config.fakaBridge
    await expect(fakaSettings.api.activate(actor, 1, true)).rejects.toMatchObject({ status: 400 })
    expect(await prisma.integrationConfigRevision.count()).toBe(0)
  })
  it('isolates capacity caches and in-flight work across revisions', async () => {
    const first = await activate('https://a.example.com', 0)
    let release!: () => void, entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    __setFakaCapacityProbeForTests(async sku => { entered(); await gate; return { sku, planId: 1, capacityLimit: 10, activeUsers: 10, remaining: 0, sellable: false, source: 'xboard' } })
    const old = withActiveFaka(() => fetchFakaCapacityForSku('plan-1-monthly'))
    await started
    await activate('https://b.example.com', first.version)
    __setFakaCapacityProbeForTests(async sku => ({ sku, planId: 1, capacityLimit: 10, activeUsers: 1, remaining: 9, sellable: true, source: 'xboard' }))
    expect((await withActiveFaka(() => fetchFakaCapacityForSku('plan-1-monthly'))).remaining).toBe(9)
    release(); expect((await old).remaining).toBe(0)
    expect((await withActiveFaka(() => fetchFakaCapacityForSku('plan-1-monthly'))).remaining).toBe(9)
  })
  it('mounts admin settings behind settings permission and hides secrets', async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { id: actor } })
    const token = (await loginAs(admin.email, 'pass123')).accessToken
    const path = '/api/admin/integrations/faka-bridge/config'
    await api.get(path).expect(401)
    const saved = await api.put(path).set(authHeader(token)).send({ expectedVersion: 0, settings: settings('https://a.example.com'), credentials }).expect(200)
    expect(JSON.stringify(saved.body)).not.toContain(credentials.secret)
    await prisma.adminAuthorization.update({ where: { userId: actor }, data: { tier: 'operator' } })
    await api.get(path).set(authHeader(token)).expect(403)
  })
})
