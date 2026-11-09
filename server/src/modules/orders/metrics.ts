import client from 'prom-client'
import { registry } from '../../lib/metrics.js'
import { prisma } from '../../lib/prisma.js'
import type { Prisma } from '@prisma/client'

const OUTCOMES = ['processed', 'error', 'refunded', 'delivered', 'retry', 'reconcile', 'skipped',
  'stale', 'failure_recorded', 'succeeded_after_refund', 'escalated', 'remedy_accepted'] as const
type Operation = 'accept_timeout' | 'dispute_timer' | 'auto_close' | 'fulfillment'
export const lifecycleEvents = new client.Counter({
  name: 'monexus_order_lifecycle_events_total', help: 'Order background outcomes using code-owned labels',
  labelNames: ['operation', 'outcome'] as const, registers: [registry],
})
export function recordLifecycle(operation: Operation, outcome: string) {
  lifecycleEvents.inc({ operation, outcome: OUTCOMES.includes(outcome as typeof OUTCOMES[number]) ? outcome : 'error' })
}

let collectedAt = 0
let collecting: Promise<void> | undefined
export async function refreshLifecycleMetrics(force = false) {
  if (collecting) return collecting
  if (!force && Date.now() - collectedAt < 15_000) return
  collecting = (async () => {
    const now = new Date()
    const states: Array<{ state: string; where: Prisma.OrderWhereInput; clock: 'createdAt' | 'cancelRequestedAt' | 'acceptBy' | 'remedyRespondBy' }> = [
      { state: 'cancel_pending', where: { status: { in: ['pending', 'processing'] }, cancelRequestedAt: { not: null } }, clock: 'cancelRequestedAt' },
      { state: 'fulfillment_reconcile', where: { status: { in: ['pending', 'processing'] }, fulfillmentJob: { status: 'needs_reconcile' } }, clock: 'createdAt' },
      { state: 'faka_revoke_failed', where: { fakaBridgeTask: { revokeStatus: 'failed' } }, clock: 'createdAt' },
      { state: 'accept_due', where: { status: 'pending', acceptBy: { lte: now }, cancelRequestedAt: null }, clock: 'acceptBy' },
      { state: 'dispute_due', where: { status: 'disputed', disputeEscalatedAt: null, OR: [{ disputeRespondBy: { lte: now } }, { remedyRespondBy: { lte: now } }] }, clock: 'createdAt' },
      { state: 'legacy_pending', where: { status: 'pending', acceptBy: null }, clock: 'createdAt' },
    ]
    const values = await Promise.all(states.map(async ({ state, where, clock }) => {
      const [count, oldest] = await Promise.all([
        prisma.order.count({ where }),
        prisma.order.findFirst({ where, orderBy: { [clock]: 'asc' }, select: { createdAt: true, cancelRequestedAt: true, acceptBy: true, remedyRespondBy: true } }),
      ])
      const date = oldest?.[clock] ?? oldest?.createdAt
      return { state, count, age: date ? Math.max(0, (now.getTime() - date.getTime()) / 1000) : 0 }
    }))
    for (const value of values) {
      lifecycleBacklog.set({ state: value.state }, value.count)
      lifecycleOldestAge.set({ state: value.state }, value.age)
    }
    collectedAt = Date.now()
  })().finally(() => { collecting = undefined })
  return collecting
}
export const lifecycleBacklog = new client.Gauge({
  name: 'monexus_order_lifecycle_backlog', help: 'Shared database backlog; use max across application replicas',
  labelNames: ['state'] as const, registers: [registry],
  async collect() { await refreshLifecycleMetrics() },
})
export const lifecycleOldestAge = new client.Gauge({
  name: 'monexus_order_lifecycle_oldest_age_seconds', help: 'Age of oldest order awaiting lifecycle handling',
  labelNames: ['state'] as const, registers: [registry],
  async collect() { await refreshLifecycleMetrics() },
})
