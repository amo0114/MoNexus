import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import { api, authHeader, createTestProduct, createTestUser, loginAs } from '../../__tests__/helpers.js'
import { signRecommendationList, verifyRecommendationList } from './token.js'
import { cleanupRecommendationEvents, recordRecommendationEvents } from './service.js'
import { calculateRecommendationReport } from './report.js'
import { getProductRecommendations } from '../products/service.js'

const key = Buffer.alloc(32, 17)
afterEach(() => { config.recommendationEventHmacKey = undefined })
const item = (id: number) => ({ id, pos: 1, tier: 3, same: false, platform: true })
function batch(token: string, type: 'click' | 'impression', id = 5) {
  return { listToken: token, visitorId: randomUUID(), events: [{ type, productId: id }] }
}

describe('recommendation events', () => {
  it('drops disabled, invalid, expired and non-list events, and never trusts client dimensions', async () => {
    config.recommendationEventHmacKey = key
    const token = signRecommendationList(1, 'guest', [item(5)])!
    const bad = `${token.slice(0, 5)}x${token.slice(6)}`
    expect(verifyRecommendationList(bad)).toEqual({ reason: 'invalid' })
    await api.post('/api/recommendations/events').send(batch(bad, 'click')).expect(204)
    const expired = signRecommendationList(1, 'guest', [item(5)], key, new Date(Date.now() - 7201_000))!
    await api.post('/api/recommendations/events').send(batch(expired, 'click')).expect(204)
    await api.post('/api/recommendations/events').send(batch(token, 'click', 6)).expect(204)
    await api.post('/api/recommendations/events').send({ ...batch(token, 'click'), tier: 3 }).expect(400)
    config.recommendationEventHmacKey = undefined
    await api.post('/api/recommendations/events').send(batch(token, 'click')).expect(204)
    expect(await prisma.recommendationClick.count()).toBe(0)
    expect(signRecommendationList(1, 'guest', [item(5)])).toBeUndefined()
  })

  it('deduplicates concurrent clicks and changes only implied when the real exposure arrives', async () => {
    config.recommendationEventHmacKey = key
    const token = signRecommendationList(1, 'guest', [item(5)])!
    const event = batch(token, 'click')
    await Promise.all([1,2,3].map(() => api.post('/api/recommendations/events').send(event).expect(204)))
    const first = await prisma.recommendationImpression.findFirstOrThrow()
    expect(first).toMatchObject({ implied: true, position: 1, tier: 3, platformSeller: true, userId: null })
    await api.post('/api/recommendations/events').send({ ...event, events: [{ type: 'impression', productId: 5 }] }).expect(204)
    await api.post('/api/recommendations/events').send(event).expect(204)
    expect(await prisma.recommendationClick.count()).toBe(1)
    const real = await prisma.recommendationImpression.findFirstOrThrow()
    expect(real).toMatchObject({ implied: false, receivedAt: first.receivedAt, visitorId: first.visitorId })
    expect(await prisma.recommendationImpression.count()).toBe(1)
  })

  it('signs the final ranked visible list without changing recommendations when disabled', async () => {
    await createTestUser()
    const base = await createTestProduct('base')
    const target = await createTestProduct('target')
    const off = await getProductRecommendations(base.id)
    expect(off).not.toHaveProperty('tracking')
    config.recommendationEventHmacKey = key
    const on = await getProductRecommendations(base.id)
    expect(on.items).toEqual(off.items)
    const verified = verifyRecommendationList(on.tracking!.listToken)
    expect('list' in verified && verified.list.items).toEqual([{ id: target.id, pos: 1, tier: 1, same: true, platform: true }])
    expect(await prisma.recommendationImpression.count()).toBe(0)
  })

  it('keeps exposure/click cohorts across midnight, attributes the last click, caps conversion by clicks, and separates refunds and windows', async () => {
    config.recommendationEventHmacKey = key
    const { user } = await createTestUser()
    const target = await createTestProduct('target')
    const exposureAt = new Date('2026-10-02T15:59:00Z')
    const clickAt = new Date('2026-10-02T16:01:00Z')
    const first = signRecommendationList(10, 'member', [item(target.id)], key, exposureAt)!
    await recordRecommendationEvents(batch(first, 'impression', target.id), user.id, exposureAt)
    await recordRecommendationEvents(batch(first, 'click', target.id), user.id, clickAt)
    // A later list wins attribution for the same user/product, not the older list.
    const secondAt = new Date('2026-10-02T16:03:00Z')
    const second = signRecommendationList(11, 'member', [item(target.id)], key, secondAt)!
    await recordRecommendationEvents(batch(second, 'click', target.id), user.id, secondAt)
    const order = (minutes: number, status = 'delivered') => prisma.order.create({ data: {
      userId: user.id, productId: target.id, price: 100, status,
      createdAt: new Date(secondAt.getTime() + minutes * 60_000),
    } })
    await order(1, 'closed'); await order(2, 'pending'); await order(3, 'refunded')
    await order(24*60-1); await order(24*60+1); await order(7*24*60+1)
    const guestAt = new Date('2026-10-02T16:10:00Z')
    const guest = signRecommendationList(12, 'guest', [item(target.id)], key, guestAt)!
    await recordRecommendationEvents(batch(guest, 'click', target.id), undefined, guestAt)
    await prisma.trafficDailyVisitor.createMany({ data: [
      { day: new Date('2026-10-02T00:00:00Z'), page: '/product/10', visitorId: randomUUID(), pv: 5 },
      { day: new Date('2026-10-02T00:00:00Z'), page: '/', visitorId: randomUUID(), pv: 99 },
    ] })
    const report = await calculateRecommendationReport({ range: '30d', groupBy: 'tier' }, new Date('2026-10-14T12:00:00Z'))
    expect(report.coverage).toMatchObject({ lists: 3, detailPageViews: 5, rate: 0.6, averageVisibleItems: 1, trendOnly: true })
    const beforeMidnight = report.rows.find(row => row.date === '2026-10-02')!
    expect(beforeMidnight).toMatchObject({ impressions: 1, clickedImpressions: 1, clicks: 0, ctr: 1, exposureNetOrders: 0 })
    const member = report.rows.find(row => row.date === '2026-10-03' && row.audience === 'member')!
    expect(member).toMatchObject({ clicks: 2, eligibleClicks: 2, convertedClicks: 1, conversionRate: 0.5,
      rawOrders: 4, netOrders: 3, rawPoints: 400, netPoints: 300,
      rawOrders7d: 5, netOrders7d: 4, convertedClicks7d: 1, exposureNetOrders: 3,
      insufficientSample: true, immature: { ctr: false, conversion: false, ordersPerThousand: false, reference7d: false } })
    expect(report.rows.find(row => row.audience === 'guest')).toMatchObject({ guestClicks: 1, eligibleClicks: 0, netOrders: 0, conversionRate: null })
    const immature = await calculateRecommendationReport({ range: '7d', groupBy: 'position' }, new Date(secondAt.getTime()+3600_000))
    expect(immature.rows.every(row => row.immature.conversion)).toBe(true)
  })

  it('guards admin reports and deletes expired raw data at the Beijing 90-day boundary', async () => {
    await api.get('/api/admin/reports/recommendations').expect(401)
    await createTestUser('buyer@test.local', 'pass123')
    const buyer = await loginAs('buyer@test.local', 'pass123')
    await api.get('/api/admin/reports/recommendations').set(authHeader(buyer.accessToken)).expect(403)
    await createTestUser('admin@test.local', 'pass123', 'admin')
    const admin = await loginAs('admin@test.local', 'pass123')
    await api.get('/api/admin/reports/recommendations').query({ groupBy: 'seller', range: '7d' }).set(authHeader(admin.accessToken)).expect(200)
    config.recommendationEventHmacKey = key
    const old = new Date('2026-07-16T15:59:59Z')
    const fresh = new Date('2026-07-16T16:00:00Z')
    for (const at of [old, fresh]) {
      const token = signRecommendationList(1, 'guest', [item(5)], key, at)!
      await recordRecommendationEvents(batch(token, 'click'), undefined, at)
    }
    await cleanupRecommendationEvents(new Date('2026-10-14T12:00:00Z'))
    expect(await prisma.recommendationClick.count()).toBe(1)
    expect(await prisma.recommendationImpression.count()).toBe(1)
  })
})
