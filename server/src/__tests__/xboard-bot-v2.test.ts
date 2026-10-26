import * as resetRemote from '../lib/fakaBridge/resetV2.js'
import { grantForOrderInTx } from '../modules/trafficReset/benefits.js'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { app } from '../app.js'
import { prisma } from '../lib/prisma.js'
import { config } from '../config/index.js'
import { __setRedisForTests, __resetRedisForTests, type RedisLike } from '../lib/redis.js'
import { prepareSignedJsonV2, signProtocolV2 } from '../lib/signedProtocolV2.js'
import * as bridge from '../lib/fakaBridge/accountV2.js'
import { profile, selectDefault } from '../modules/xboardAccounts/queries.js'
import { clearAccountQueryCachesForTests, invalidateAccountSnapshot, readSnapshot } from '../modules/xboardAccounts/bridgeQueries.js'
import { enableAccountTests, linked, instanceId } from './xboardAccountFixture.js'

class AtomicRedis implements RedisLike {
  values = new Set<string>()
  counts = new Map<string, number>()
  async get() { return null }
  async set(key: string) { if (this.values.has(key)) return null; this.values.add(key); return 'OK' }
  async del() { return 0 }
  async incr() { return 1 }
  async ping() { return 'PONG' }
  async eval(_script: string, _keys: number, key: string, ttl: string) {
    const count = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, count)
    return [count, Number(ttl)]
  }
}
let restore: () => void
beforeEach(() => { restore = enableAccountTests(); __setRedisForTests(new AtomicRedis()) })
afterEach(() => { __resetRedisForTests(); restore() })
function signed(action: string, body: unknown, timestamp = Date.now()) {
  return prepareSignedJsonV2({ audience: 'bot', path: `/api/bot/v2/xboard/${action}`, body, secret: 'bot-test' }, timestamp)
}
function send(action: string, body: unknown) {
  const s = signed(action, body)
  return request(app).post(s.path).set(s.headers).send(s.body)
}
const identity = (platformId: string) => ({ platform: 'qq', platformId })

describe('QQ Xboard v2 raw HTTP and authorization', () => {
  it('accepts exact wire bytes and reports unbound without remote lookup', async () => {
    const s = signed('accounts', identity('123456'))
    const raw = '{ "platformId": "123456", "platform": "qq" }'
    s.headers['x-monexus-signature'] = signProtocolV2({ audience: 'bot', method: 'POST', path: s.path,
      timestampMs: Number(s.headers['x-monexus-timestamp']), nonce: s.headers['x-monexus-nonce'], rawBody: Buffer.from(raw) }, 'bot-test')
    const response = await request(app).post(s.path).set(s.headers).send(raw)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ bound: false })
    expect(response.headers['cache-control']).toContain('no-store')
    expect(bridge.callFakaV2Subscription).not.toHaveBeenCalled()
  })

  it('rejects byte tampering, signed-path confusion, expired signatures and invalid DTOs', async () => {
    const s = signed('accounts', identity('123456'))
    expect((await request(app).post(s.path).set(s.headers).send(s.body + ' ')).status).toBe(401)
    expect((await request(app).post(s.path + '?x=1').set(s.headers).send(s.body)).status).toBe(401)
    const old = signed('accounts', identity('123456'), Date.now() - 300001)
    expect((await request(app).post(old.path).set(old.headers).send(old.body)).status).toBe(401)
    expect((await send('accounts', { ...identity('123456'), userId: 1 })).status).toBe(400)
    expect((await send('accounts', { platform: 'telegram', platformId: '123456' })).status).toBe(400)
    const duplicate = signed('accounts', identity('123456'))
    expect((await request(app).post(duplicate.path).set(duplicate.headers)
      .set({ 'x-monexus-signature': [duplicate.headers['x-monexus-signature'], duplicate.headers['x-monexus-signature']] }).send(duplicate.body)).status).toBe(401)
  })

  it('atomically rejects replay, but permits retries with a fresh nonce', async () => {
    const s = signed('accounts', identity('123456'))
    const results = await Promise.all([1, 2].map(() => request(app).post(s.path).set(s.headers).send(s.body)))
    expect(results.map(r => r.status).sort()).toEqual([200, 409])
    expect(results.find(r => r.status === 409)?.body.error.code).toBe('BOT_REQUEST_REPLAYED')
    expect((await send('accounts', identity('123456'))).status).toBe(200)
  })

  it('fails closed when replay storage is unavailable and when query is disabled', async () => {
    __setRedisForTests(null)
    expect((await send('accounts', identity('123456'))).status).toBe(503)
    config.xboardAccounts.enabled = false
    expect((await send('accounts', identity('123456'))).status).toBe(503)
  })

  it('enforces the raw byte limit and rejects compressed bodies', async () => {
    const s = signed('accounts', { ...identity('123456'), padding: 'a'.repeat(9000) })
    expect((await request(app).post(s.path).set(s.headers).send(s.body)).status).toBe(413)
    const normal = signed('accounts', identity('123456'))
    expect((await request(app).post(normal.path).set(normal.headers).set('Content-Encoding', 'gzip').send(normal.body)).status).toBe(415)
  })

  it('lists only owned accounts and returns exact traffic with unavailable benefit counts', async () => {
    const a = await linked(), b = await linked(undefined, '43')
    const list = await send('accounts', identity(a.actor.platformId))
    expect(list.status).toBe(200)
    expect(list.body.accounts).toHaveLength(1)
    expect(list.body.defaultAccountLinkId).toBe(a.link.id)
    expect(JSON.stringify(list.body)).not.toContain(a.email)
    const result = await send('profile', identity(a.actor.platformId))
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ bound: true, subscription: { remainingBytes: '9223372036854775804', expiresAtUnix: '0', nextResetAtUnix: null },
      freeReset: null, canFreeReset: false, resetHistory: { platformSuccessfulForAccount: 0, paidSuccessfulForAccount: 0, coverageScope: 'verified_v2_only', xboardAllSources: '7' } })
    const denied = await send('profile', { ...identity(a.actor.platformId), accountLinkId: b.link.id })
    expect(denied.status).toBe(404)
    expect(bridge.callFakaV2Subscription).toHaveBeenCalledTimes(1)
  })

  it('requires explicit multi-account choice, makes selection idempotent and never reverts a later choice', async () => {
    const a = await linked(), b = await linked(a.user.id, '43'), foreign = await linked(undefined, '44')
    expect((await send('profile', identity(a.actor.platformId))).body.error.code).toBe('XBOARD_ACCOUNT_SELECTION_REQUIRED')
    const requestId = randomUUID(), body = { ...identity(a.actor.platformId), requestId, accountLinkId: a.link.id }
    const results = await Promise.all([send('select-default', body), send('select-default', body)])
    expect(results.map(r => r.status)).toEqual([200, 200])
    expect(results.map(r => r.body.replayed).sort()).toEqual([false, true])
    expect((await send('select-default', { ...body, accountLinkId: b.link.id })).status).toBe(409)
    expect((await send('select-default', { ...body, requestId: randomUUID(), accountLinkId: foreign.link.id })).status).toBe(404)
    await selectDefault(a.actor, b.link.id, randomUUID())
    expect((await selectDefault(a.actor, a.link.id, requestId)).replayed).toBe(true)
    expect((await prisma.xboardAccountPreference.findUniqueOrThrow({ where: { userId_instanceId: { userId: a.user.id, instanceId } } })).defaultAccountLinkId).toBe(b.link.id)
  })

  it('rechecks QQ binding after waiting for remote response', async () => {
    const a = await linked()
    let release!: (value: Awaited<ReturnType<typeof bridge.callFakaV2Subscription>>) => void
    let started!: () => void
    const entered = new Promise<void>(r => { started = r })
    const original = await bridge.callFakaV2Subscription('42')
    vi.mocked(bridge.callFakaV2Subscription).mockImplementation(() => { started(); return new Promise(r => { release = r }) })
    const pending = profile(a.actor)
    await entered
    await prisma.chatBinding.delete({ where: { id: a.actor.bindingId } })
    release(original)
    await expect(pending).rejects.toMatchObject({ status: 409, code: 'XBOARD_BINDING_CHANGED' })
  })

  it('does not let an in-flight pre-reset snapshot overwrite the refreshed cache', async () => {
    const original = await bridge.callFakaV2Subscription('42')
    if (!original.ok) throw new Error('fixture unavailable')
    const fresh = structuredClone(original)
    fresh.body.subscription.reset_count = '8'
    let release!: (value: typeof original) => void
    let started!: () => void
    const entered = new Promise<void>(r => { started = r })
    vi.mocked(bridge.callFakaV2Subscription).mockImplementationOnce(() => {
      started(); return new Promise(r => { release = r })
    }).mockResolvedValue(fresh)
    const before = readSnapshot(instanceId, '42')
    await entered
    invalidateAccountSnapshot(instanceId, '42')
    expect((await readSnapshot(instanceId, '42')).body?.subscription.reset_count).toBe('8')
    release(original)
    await before
    expect((await readSnapshot(instanceId, '42')).body?.subscription.reset_count).toBe('8')
    expect(bridge.callFakaV2Subscription).toHaveBeenCalledTimes(3)
  })

  it('rejects cached queries after a ban or ownership conflict and QQ rebind cannot reuse selections', async () => {
    const a = await linked()
    const requestId = randomUUID()
    await selectDefault(a.actor, a.link.id, requestId)
    await profile(a.actor)
    await prisma.xboardAccountLink.update({ where: { id: a.link.id }, data: { status: 'blocked' } })
    await expect(profile(a.actor)).rejects.toMatchObject({ status: 409 })
    await prisma.xboardAccountLink.update({ where: { id: a.link.id }, data: { status: 'active' } })
    await prisma.user.update({ where: { id: a.user.id }, data: { status: '封禁' } })
    expect((await send('accounts', identity(a.actor.platformId))).status).toBe(403)
    await prisma.user.update({ where: { id: a.user.id }, data: { status: '正常' } })
    await prisma.chatBinding.delete({ where: { id: a.actor.bindingId } })
    const replacement = await prisma.chatBinding.create({ data: { platform: 'qq', platformId: a.actor.platformId, userId: a.user.id } })
    await expect(selectDefault({ ...a.actor, bindingId: replacement.id }, a.link.id, requestId)).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' })
  })

  it('limits each bound user independently of the shared bot host', async () => {
    const a = await linked(), b = await linked(undefined, '43')
    for (let i = 0; i < 10; i++) expect((await send('accounts', identity(a.actor.platformId))).status).toBe(200)
    expect((await send('accounts', identity(a.actor.platformId))).status).toBe(429)
    expect((await send('accounts', identity(b.actor.platformId))).status).toBe(200)
  })

  it('enforces owned default/selection foreign keys at the database boundary', async () => {
    const a = await linked(), b = await linked(undefined, '43')
    await expect(prisma.xboardAccountPreference.create({ data: { userId: a.user.id, instanceId, defaultAccountLinkId: b.link.id } })).rejects.toMatchObject({ code: 'P2003' })
    await expect(prisma.xboardAccountSelection.create({ data: { userId: a.user.id, instanceId, requestId: randomUUID(), accountLinkId: b.link.id, chatBindingId: a.actor.bindingId } })).rejects.toMatchObject({ code: 'P2003' })
  })

  it('serves a bounded stale snapshot only on transient faults and never fabricates zero traffic', async () => {
    const a = await linked()
    const base = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base)
    await profile(a.actor)
    clock.mockReturnValue(base + 16000)
    vi.mocked(bridge.callFakaV2Capabilities).mockResolvedValue({ ok: false, code: 'TIMEOUT', httpStatus: 0 })
    expect(await profile(a.actor)).toMatchObject({ subscription: { remainingBytes: '9223372036854775804' }, freshness: { stale: true, unavailable: true } })
    clock.mockReturnValue(base + 60001)
    expect(await profile(a.actor)).toMatchObject({ subscription: null, freshness: { stale: false, unavailable: true } })
    clearAccountQueryCachesForTests()
  })

  it('does not serve old snapshots after explicit capability revocation', async () => {
    const a = await linked()
    const base = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(base)
    await profile(a.actor)
    clock.mockReturnValue(base + 16000)
    vi.mocked(bridge.callFakaV2Capabilities).mockResolvedValue({ ok: false, code: 'REMOTE_REJECTED', httpStatus: 503, remoteCode: 'CAPABILITY_UNAVAILABLE' })
    await expect(profile(a.actor)).rejects.toMatchObject({ status: 503 })
    vi.mocked(bridge.callFakaV2Capabilities).mockResolvedValue({ ok: false, code: 'TIMEOUT', httpStatus: 0 })
    expect(await profile(a.actor)).toMatchObject({ subscription: null, freshness: { unavailable: true, stale: false } })
  })
  it('isolates snapshot identities and refuses to write back stale email', async () => {
    const a = await linked(), b = await linked(undefined, '43')
    const base = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(base)
    const first = await profile(a.actor)
    expect(first.subscription).not.toBeNull()
    vi.mocked(bridge.callFakaV2Subscription).mockResolvedValue({ ok: false, code: 'TIMEOUT', httpStatus: 0 })
    expect(await profile(b.actor)).toMatchObject({ subscription: null, freshness: { stale: false, unavailable: true } })
    clock.mockReturnValue(base + 16000)
    await prisma.xboardAccountLink.update({ where: { id: a.link.id }, data: { currentEmail: 'new-local@example.com' } })
    expect(await profile(a.actor)).toMatchObject({ freshness: { stale: true, unavailable: true } })
    expect((await prisma.xboardAccountLink.findUniqueOrThrow({ where: { id: a.link.id } })).currentEmail).toBe('new-local@example.com')
    clock.mockReturnValue(base + 60001)
    expect(await profile(a.actor)).toMatchObject({ subscription: null })
  })

  it('submits a signed confirmation as 202 without executing a commercial order', async () => {
    const a = await linked(), saved = { ...config.trafficReset }
    try {
      Object.assign(config.trafficReset, { grantsEnabled: true, requestsEnabled: true, dispatchEnabled: false, confirmSecret: 'test-confirmation-key-at-least-32-characters' })
      await prisma.xboardAccountEvidence.create({ data: { userId: a.user.id, sourceOrderId: a.order.id, accountLinkId: a.link.id,
        externalOrderNo: a.task.requestOrderNo, emailSnapshot: a.email, proofKind: 'email_proof', proofVerifiedAt: new Date('2026-01-01') } })
      await prisma.$transaction(tx => grantForOrderInTx(tx, a.order.id))
      const caps = await bridge.callFakaV2Capabilities()
      if (!caps.ok) throw new Error('fixture capabilities')
      Object.assign(caps.body.capabilities, { reset_idempotency: true, reset_status: true, cancel_tombstone: true })
      vi.mocked(bridge.callFakaV2Capabilities).mockResolvedValue(caps)
      vi.spyOn(resetRemote, 'callResetPreview').mockResolvedValue({ ok: true, httpStatus: 200, body: { success: true, protocol_version: 2,
        request_id: randomUUID(), queried_at: new Date().toISOString(), preview: { user_id: '42', plan_id: '3', fingerprint: 'a'.repeat(64), eligible: true,
          block_reason: null, snapshot: { plan_id: '3', transfer_enable: '1000', expired_at: null, last_reset_at: null, reset_count: '0', next_reset_at: null, u: '100', d: '20' } } } })
      const intent = await send('reset-intents', { ...identity(a.actor.platformId), requestId: randomUUID() })
      expect(intent.status).toBe(200)
      const pending = await send('reset-intent-status', { ...identity(a.actor.platformId), intentId: intent.body.intentId })
      expect(pending.status).toBe(200)
      expect(pending.body).toEqual({ bound: true, intentId: intent.body.intentId, operation: null })
      expect(await prisma.xboardTrafficResetOperation.count()).toBe(0)
      const body = { ...identity(a.actor.platformId), intentId: intent.body.intentId, confirmationCode: intent.body.confirmationCode, requestId: randomUUID() }
      const first = await send('resets', body), replay = await send('resets', body)
      expect(first.status).toBe(202)
      expect(replay.body.operationId).toBe(first.body.operationId)
      expect(replay.body.replayed).toBe(true)
      const status = await send('reset-status', { ...identity(a.actor.platformId), operationId: first.body.operationId })
      expect(status.body.status).toBe('queued')
      config.trafficReset.requestsEnabled = false
      await prisma.trafficResetIntent.update({ where: { id: intent.body.intentId }, data: { expiresAt: new Date(0) } })
      const recovered = await send('reset-intent-status', { ...identity(a.actor.platformId), intentId: intent.body.intentId })
      expect(recovered.status).toBe(200)
      expect(recovered.body.operation).toMatchObject({ operationId: first.body.operationId, status: 'queued' })
      expect(recovered.headers['cache-control']).toContain('no-store')
      expect((await send('reset-intent-status', { ...identity(a.actor.platformId), intentId: intent.body.intentId, operationId: first.body.operationId })).status).toBe(400)
      const other = await prisma.user.create({ data: { email: `${randomUUID()}@other.test`, password: 'unused' } })
      const stranger = await prisma.chatBinding.create({ data: { userId: other.id, platform: 'qq', platformId: String(200000 + other.id) } })
      expect((await send('reset-intent-status', { ...identity(stranger.platformId), intentId: intent.body.intentId })).status).toBe(404)
      await prisma.chatBinding.delete({ where: { id: a.actor.bindingId } })
      await prisma.chatBinding.create({ data: { userId: a.user.id, platform: 'qq', platformId: a.actor.platformId } })
      expect((await send('reset-intent-status', { ...identity(a.actor.platformId), intentId: intent.body.intentId })).status).toBe(404)
      expect(await prisma.order.count()).toBe(1)
      expect(await prisma.xboardTrafficResetOperation.count()).toBe(1)
    } finally { Object.assign(config.trafficReset, saved) }
  })

})
