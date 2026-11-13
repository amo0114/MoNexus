import client from 'prom-client'
import { registry } from '../../lib/metrics.js'
import { prisma } from '../../lib/prisma.js'
let collectedAt = 0
let pending: Promise<void> | undefined
const startedAt = Date.now() / 1000
export async function refreshGovernanceMetrics(force = false) {
  if (pending) return pending
  if (!force && Date.now() - collectedAt < 15000) return
  pending = (async () => {
    const now = Date.now()
    const [refunds, exportQueued, exportFailed, issues, last, first] = await Promise.all([
      prisma.rechargeRefund.aggregate({
        where: { status: 'manual_review' },
        _count: { id: true },
        _min: { createdAt: true },
      }),
      prisma.adminExportJob.aggregate({
        where: { status: { in: ['queued', 'running'] } },
        _count: { id: true },
        _min: { createdAt: true },
      }),
      prisma.adminExportJob.count({ where: { status: 'failed' } }),
      prisma.walletIntegrityIssue.count({ where: { status: 'open' } }),
      prisma.walletIntegrityScanRun.aggregate({
        where: { status: 'succeeded' },
        _max: { completedAt: true },
      }),
      prisma.walletIntegrityScanRun.aggregate({ _min: { startedAt: true } }),
    ])
    for (const [state, count, date] of [
      ['refund_manual', refunds._count.id, refunds._min.createdAt],
      ['export_pending', exportQueued._count.id, exportQueued._min.createdAt],
      ['export_failed', exportFailed, null],
      ['wallet_issue', issues, null],
    ] as const) {
      governanceBacklog.set({ state }, count)
      governanceOldestAge.set({ state }, date ? Math.max(0, (now - date.getTime()) / 1000) : 0)
    }
    integrityLastSuccess.set(
      (last._max.completedAt?.getTime() ?? first._min.startedAt?.getTime() ?? startedAt * 1000) /
        1000,
    )
    collectedAt = now
  })().finally(() => {
    pending = undefined
  })
  return pending
}
export const governanceBacklog = new client.Gauge({
  name: 'monexus_governance_backlog',
  help: 'Governance queues from the shared database; max across replicas',
  labelNames: ['state'] as const,
  registers: [registry],
  async collect() {
    await refreshGovernanceMetrics()
  },
})
export const governanceOldestAge = new client.Gauge({
  name: 'monexus_governance_oldest_age_seconds',
  help: 'Oldest governance queue entry age',
  labelNames: ['state'] as const,
  registers: [registry],
  async collect() {
    await refreshGovernanceMetrics()
  },
})
export const integrityLastSuccess = new client.Gauge({
  name: 'monexus_wallet_integrity_last_success_timestamp_seconds',
  help: 'Last completed scan, or initial scan/deployment baseline before its first completion',
  registers: [registry],
  async collect() {
    await refreshGovernanceMetrics()
  },
})
