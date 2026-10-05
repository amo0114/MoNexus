import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { config } from '../config/index.js'
import { __resetRedisForTests, __setRedisForTests } from '../lib/redis.js'
import { addCalendarDays, businessDateString, businessDayStartUtc } from '../lib/businessTime.js'
import { aggregateTraffic, getTrafficReport, recordTrafficEvent } from '../modules/traffic/service.js'
import { api, authHeader, createTestMerchant, createTestProduct, createTestUser, loginAs } from './helpers.js'

afterEach(() => {
  config.redisEnabled = false
  __resetRedisForTests()
})

describe('traffic analytics', () => {
  it('persists each event once despite concurrent HTTP retries and repeated aggregation', async () => {
    const event = { eventId: randomUUID(), visitorId: randomUUID(), page: '/' }
    await Promise.all(Array.from({ length: 3 }, () => api.post('/api/traffic/events').send(event).expect(204)))
    await api.post('/api/traffic/events').send({ ...event, eventId: randomUUID() }).expect(204)
    expect(await prisma.trafficEvent.count()).toBe(2)
    await Promise.all([aggregateTraffic(), aggregateTraffic()])
    await aggregateTraffic()
    expect((await getTrafficReport('7d')).totals).toEqual({ pv: 2, uv: 1 })
    expect(await prisma.trafficEvent.count({ where: { processedAt: null } })).toBe(0)
  })

  it('deduplicates UV across Beijing days/products/merchants and enforces both report roles', async () => {
    const a = await createTestMerchant('traffic-a@test.local', 'pass123', { status: 'active' })
    const b = await createTestMerchant('traffic-b@test.local', 'pass123', { status: 'active' })
    const productA = await createTestProduct('A', 100, 0, [], a.merchant.id)
    const productB = await createTestProduct('B', 100, 0, [], b.merchant.id)
    const visitor = randomUUID()
    const today = businessDateString()
    const midnight = businessDayStartUtc(today)
    await prisma.trafficEvent.createMany({ data: [
      { id: randomUUID(), visitorId: visitor, page: `/product/${productA.id}`, productId: productA.id, merchantId: a.merchant.id, receivedAt: new Date(midnight.getTime() - 1) },
      { id: randomUUID(), visitorId: visitor, page: `/product/${productA.id}`, productId: productA.id, merchantId: a.merchant.id, receivedAt: midnight },
      { id: randomUUID(), visitorId: visitor, page: `/product/${productB.id}`, productId: productB.id, merchantId: b.merchant.id, receivedAt: midnight },
      { id: randomUUID(), visitorId: randomUUID(), page: '/', receivedAt: midnight },
    ] })
    await aggregateTraffic()
    const { accessToken } = await loginAs('traffic-a@test.local', 'pass123')
    const merchant = await api.get('/api/merchant/dashboard/traffic').query({ range: '7d', merchantId: b.merchant.id }).set(authHeader(accessToken)).expect(200)
    expect(merchant.body.totals).toEqual({ pv: 2, uv: 1 })
    expect(merchant.body.topProducts.map((p: { productId: number }) => p.productId)).toEqual([productA.id])
    expect(merchant.body.topMerchants).toEqual([])
    expect(merchant.body.points.filter((p: { pv: number }) => p.pv > 0)).toEqual([
      { date: addCalendarDays(today, -1), pv: 1, uv: 1 },
      { date: today, pv: 1, uv: 1 },
    ])
    await api.get('/api/admin/reports/traffic').set(authHeader(accessToken)).expect(403)
    await api.get('/api/merchant/dashboard/traffic').expect(401)
    await api.get('/api/admin/reports/traffic').expect(401)
    await createTestUser('traffic-admin@test.local', 'pass123', 'admin')
    const admin = await loginAs('traffic-admin@test.local', 'pass123')
    const platform = await api.get('/api/admin/reports/traffic').query({ range: '7d' }).set(authHeader(admin.accessToken)).expect(200)
    expect(platform.body.totals).toEqual({ pv: 4, uv: 2 })
    expect(platform.body.topMerchants).toHaveLength(2)
  })

  it('derives product ownership and rejects inaccessible products and untrusted payload fields', async () => {
    const merchant = await createTestMerchant('traffic-owner@test.local', 'pass123', { status: 'active' })
    const product = await createTestProduct('Private', 100, 0, [], merchant.merchant.id)
    const event = { eventId: randomUUID(), visitorId: randomUUID(), page: `/product/${product.id}` }
    await api.post('/api/traffic/events').send({ ...event, merchantId: 999 }).expect(400)
    await api.post('/api/traffic/events').send(event).expect(204)
    expect(await prisma.trafficEvent.findUnique({ where: { id: event.eventId } })).toMatchObject({ merchantId: merchant.merchant.id })
    await prisma.product.update({ where: { id: product.id }, data: { visibility: 'members_only' } })
    await api.post('/api/traffic/events').send({ ...event, eventId: randomUUID() }).expect(404)
    const owner = await loginAs('traffic-owner@test.local', 'pass123')
    await api.post('/api/traffic/events').set(authHeader(owner.accessToken)).send({ ...event, eventId: randomUUID() }).expect(204)
    await prisma.product.update({ where: { id: product.id }, data: { status: 'inactive' } })
    await api.post('/api/traffic/events').set(authHeader(owner.accessToken)).send({ ...event, eventId: randomUUID() }).expect(404)
    expect(await prisma.trafficEvent.count()).toBe(2)
  })

  it('keeps ingestion and reports working when the Redis cache is unavailable', async () => {
    config.redisEnabled = true
    const offline = vi.fn().mockRejectedValue(new Error('Redis unavailable'))
    __setRedisForTests({ get: offline, set: offline, del: offline, incr: offline, eval: offline, ping: offline })
    await recordTrafficEvent({ eventId: randomUUID(), visitorId: randomUUID(), page: '/' }, 'guest')
    await aggregateTraffic()
    const report = await getTrafficReport('30d')
    expect(report.totals).toEqual({ pv: 1, uv: 1 })
    expect(report.pendingEvents).toBe(0)
    expect(report.updatedAt).not.toBeNull()
    expect(offline).toHaveBeenCalled()
  })

  it('rolls back both counters and acknowledgements if a batch fails, then safely retries', async () => {
    await recordTrafficEvent({ eventId: randomUUID(), visitorId: randomUUID(), page: '/' }, 'guest')
    // Force the final write to fail, after the counter and event acknowledgement writes.
    await prisma.$executeRawUnsafe('ALTER TABLE "TrafficAggregationState" ADD CONSTRAINT traffic_test_failure CHECK ("updatedAt" IS NULL)')
    try {
      await expect(aggregateTraffic()).rejects.toThrow()
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "TrafficAggregationState" DROP CONSTRAINT traffic_test_failure')
    }
    expect(await prisma.trafficDailyVisitor.count()).toBe(0)
    expect(await prisma.trafficEvent.count({ where: { processedAt: null } })).toBe(1)
    await aggregateTraffic()
    expect((await getTrafficReport('7d')).totals).toEqual({ pv: 1, uv: 1 })
  })
})
