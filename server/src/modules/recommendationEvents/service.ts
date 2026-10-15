import client from 'prom-client'
import { registry } from '../../lib/metrics.js'
import { prisma } from '../../lib/prisma.js'
import { businessDateString, addCalendarDays, businessDayStartUtc } from '../../lib/businessTime.js'
import { verifyRecommendationList } from './token.js'
import type { EventBatch } from './schema.js'

const discarded = new client.Counter({
  name: 'monexus_recommendation_events_discarded_total', help: 'Discarded recommendation events by fixed reason',
  labelNames: ['reason'] as const, registers: [registry],
})

export async function recordRecommendationEvents(input: EventBatch, userId?: number, now = new Date()) {
  const verified = verifyRecommendationList(input.listToken, undefined, now)
  if ('reason' in verified) { discarded.inc({ reason: verified.reason }, input.events.length); return }
  const { list } = verified
  const items = new Map(list.items.map(item => [item.id, item]))
  const impressions = new Map<number, boolean>()
  const clicks = new Set<number>()
  for (const event of input.events) {
    if (!items.has(event.productId)) { discarded.inc({ reason: 'not_listed' }); continue }
    if (event.type === 'click') {
      clicks.add(event.productId)
      if (!impressions.has(event.productId)) impressions.set(event.productId, true)
    } else impressions.set(event.productId, false)
  }
  const data = (productId: number) => {
    const item = items.get(productId)!
    return {
      listId: list.listId, productId, sourceProductId: list.src, position: item.pos, tier: item.tier,
      sameSeller: item.same, platformSeller: item.platform, strategyVersion: list.sv, audience: list.aud,
      visitorId: input.visitorId, userId: userId ?? null, receivedAt: now,
    }
  }
  const sorted = [...impressions.keys()].sort((a, b) => a - b)
  if (!sorted.length) return
  await prisma.$transaction(async tx => {
    await tx.recommendationImpression.createMany({
      data: sorted.map(id => ({ ...data(id), implied: impressions.get(id)! })), skipDuplicates: true,
    })
    const real = sorted.filter(id => !impressions.get(id))
    if (real.length) await tx.recommendationImpression.updateMany({
      where: { listId: list.listId, productId: { in: real }, implied: true }, data: { implied: false },
    })
    if (clicks.size) await tx.recommendationClick.createMany({
      data: [...clicks].sort((a,b) => a-b).map(data), skipDuplicates: true,
    })
  })
}

export async function cleanupRecommendationEvents(now = new Date()) {
  const oldest = businessDayStartUtc(addCalendarDays(businessDateString(now), 1 - 90))
  return prisma.$transaction([
    prisma.recommendationClick.deleteMany({ where: { receivedAt: { lt: oldest } } }),
    prisma.recommendationImpression.deleteMany({ where: { receivedAt: { lt: oldest } } }),
  ])
}
