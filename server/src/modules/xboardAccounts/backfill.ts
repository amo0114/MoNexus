import { grantForOrderInTx } from '../trafficReset/benefits.js'
import { prisma } from '../../lib/prisma.js'
import { acquireCronLeaseWithHeartbeat } from '../../lib/cronLease.js'
import { accountSettings, unavailable } from './settings.js'
import { recoverAccount, type RecoveryResult, type PreviewOwnership } from './recovery.js'
import { requireReadCapabilities } from './bridgeQueries.js'

export async function runAccountBackfill(input: { apply?: boolean; limit?: number; afterUserId?: number; afterTaskId?: number } = {}) {
  const apply = input.apply ?? false, limit = input.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1..100')
  for (const value of [input.afterUserId, input.afterTaskId]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error('invalid cursor')
  if (apply && (input.afterUserId !== undefined || input.afterTaskId !== undefined)) throw new Error('apply resumes the persisted checkpoint; cursor override is preview-only')
  const { instanceId, origin } = accountSettings()
  const lease = apply ? await acquireCronLeaseWithHeartbeat(`xboard-account-backfill:${instanceId}`, 1000) : null
  if (apply && !lease) return { skipped: true as const }
  try {
    const existing = await prisma.xboardInstance.findUnique({ where: { id: instanceId } })
    if (existing && existing.origin !== origin) throw unavailable()
    await requireReadCapabilities(instanceId)
    if (apply) await prisma.$transaction(async tx => {
      await tx.$executeRaw`INSERT INTO "XboardInstance" ("id", "origin") VALUES (${instanceId}, ${origin}) ON CONFLICT ("id") DO NOTHING`
      const instance = await tx.xboardInstance.findUniqueOrThrow({ where: { id: instanceId } })
      if (instance.origin !== origin) throw unavailable()
      await tx.$executeRaw`INSERT INTO "XboardAccountBackfillState" ("instanceId") VALUES (${instanceId}) ON CONFLICT ("instanceId") DO NOTHING`
    })
    const state = await prisma.xboardAccountBackfillState.findUnique({ where: { instanceId } })
    const userId = input.afterUserId ?? (apply ? state?.cursorUserId ?? 0 : 0)
    const taskId = input.afterTaskId ?? (apply ? state?.cursorTaskId ?? 0 : 0)
    const rows = await prisma.fakaBridgeTask.findMany({ where: { OR: [
      { order: { userId: { gt: userId } } }, { order: { userId }, id: { gt: taskId } },
    ] }, select: { id: true, order: { select: { userId: true, id: true } } }, orderBy: [{ order: { userId: 'asc' } }, { id: 'asc' }], take: limit })
    const counts: Partial<Record<RecoveryResult, number>> = {}
    const previewOwners: PreviewOwnership = new Map()
    const anomalies: Array<{ taskId: number; reason: RecoveryResult }> = []
    let cursorUserId = userId, cursorTaskId = taskId
    for (const row of rows) {
      const outcome = await recoverAccount(row.id, apply, apply ? undefined : previewOwners)
      counts[outcome] = (counts[outcome] ?? 0) + 1
      if (outcome !== 'linked' && outcome !== 'existing') anomalies.push({ taskId: row.id, reason: outcome })
      // Do not advance past transport outages. Repeated runs can retry the
      // same source; successful link/evidence writes are independently idempotent.
      if (outcome === 'remote_unavailable') break
      if (apply) await prisma.$transaction(async tx => {
        if (outcome === 'linked' || outcome === 'existing') await grantForOrderInTx(tx, row.order.id)
        await tx.$executeRaw`INSERT INTO "XboardInstance" ("id", "origin") VALUES (${instanceId}, ${origin}) ON CONFLICT ("id") DO NOTHING`
        const current = await tx.xboardInstance.findUniqueOrThrow({ where: { id: instanceId } })
        if (current.origin !== origin) throw unavailable()
        const updated = await tx.xboardAccountBackfillState.updateMany({
          where: { instanceId, cursorUserId, cursorTaskId, cycle: state?.cycle ?? 0 },
          data: { cursorUserId: row.order.userId, cursorTaskId: row.id } })
        if (updated.count !== 1) throw new Error('backfill checkpoint changed')
      })
      cursorUserId = row.order.userId; cursorTaskId = row.id
    }
    if (apply && rows.length === 0 && state) await prisma.xboardAccountBackfillState.updateMany({
      where: { instanceId, cursorUserId, cursorTaskId, cycle: state.cycle },
      data: { cursorUserId: 0, cursorTaskId: 0, cycle: { increment: 1 } } })
    const checkpoint = apply ? await prisma.xboardAccountBackfillState.findUnique({ where: { instanceId },
      select: { cursorUserId: true, cursorTaskId: true, cycle: true } }) : null
    return { skipped: false as const, apply, scanned: Object.values(counts).reduce((a, b) => a + (b ?? 0), 0), counts, anomalies,
      previewNext: rows.length ? { userId: cursorUserId, taskId: cursorTaskId } : null, checkpoint }
  } catch (error) {
    await lease?.releaseForRetry()
    throw error
  } finally { lease?.release() }
}
