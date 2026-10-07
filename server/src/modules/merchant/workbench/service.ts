import { HttpError, notFound } from '../../../lib/httpError.js'
import { getSystemConfigValue } from '../../../lib/systemConfig.js'
import { availabilityItem, fulfillmentItem, type ItemResult, type WorkbenchItem } from './dto.js'
import { deadlineBand, DRAFT_BATCH_SIZE, DRAFT_CONCURRENCY } from './rules.js'
import type { WorkbenchRule } from './schema.js'
import * as repository from './repository.js'
import { observeRead, scannedDrafts, truncatedGroups } from './metrics.js'

export type WorkbenchGroup = {
  items: WorkbenchItem[]; matchedTotal: number | null; truncated: boolean;
  evaluatedAt: string; status: 'complete' | 'failed';
}

async function group(rule: WorkbenchRule, now: Date, read: () => Promise<{ items: WorkbenchItem[]; matchedTotal: number }>): Promise<WorkbenchGroup> {
  try {
    const result = await observeRead(rule, read)
    if (result.matchedTotal > result.items.length) truncatedGroups.inc({ rule })
    return { ...result, truncated: result.matchedTotal > result.items.length, evaluatedAt: now.toISOString(), status: 'complete' }
  } catch {
    // No upstream error text or partial payload is exposed; counts are unknown, not zero.
    return { items: [], matchedTotal: null, truncated: false, evaluatedAt: now.toISOString(), status: 'failed' }
  }
}

export async function getUrgent(merchantId: number, now = new Date()) {
  const [fulfillment, soldOut] = await Promise.all([
    group('fulfillment_due', now, async () => {
      const result = await repository.readSnapshot(db => repository.queryFulfillment(db, merchantId, now))
      return { items: result.items.map(row => fulfillmentItem(row, now)), matchedTotal: result.matchedTotal }
    }),
    group('low_availability', now, async () => {
      const threshold = await getSystemConfigValue('lowStockThreshold')
      const result = await repository.readSnapshot(db => repository.queryAvailability(db, merchantId, 0))
      return { items: result.items.map(row => availabilityItem(row, threshold, now)), matchedTotal: result.matchedTotal }
    }),
  ])
  if (fulfillment.status === 'failed' && soldOut.status === 'failed') {
    throw new HttpError(503, 'INTERNAL_SERVER_ERROR', '事项暂未检查，请稍后重试')
  }
  const urgentKnownCount = (fulfillment.matchedTotal ?? 0) + (soldOut.matchedTotal ?? 0)
  return { fulfillment, soldOut, urgentKnownCount,
    urgentTotal: fulfillment.status === 'complete' && soldOut.status === 'complete' ? urgentKnownCount : null }
}

export async function getAvailability(merchantId: number, now = new Date()) {
  const result = await group('low_availability', now, async () => {
    const threshold = await getSystemConfigValue('lowStockThreshold')
    const rows = await repository.readSnapshot(db => repository.queryAvailability(db, merchantId, threshold))
    return { items: rows.items.map(row => availabilityItem(row, threshold, now)), matchedTotal: rows.matchedTotal }
  })
  if (result.status === 'failed') throw new HttpError(503, 'INTERNAL_SERVER_ERROR', '库存事项暂未检查，请稍后重试')
  return result
}

export async function getItem(merchantId: number, rule: WorkbenchRule, targetId: number, now = new Date()): Promise<ItemResult> {
  return observeRead(rule, async () => {
    if (rule === 'draft_incomplete') return repository.queryDraftTarget(merchantId, targetId, now)
    if (rule === 'low_availability') {
      const threshold = await getSystemConfigValue('lowStockThreshold')
      const row = await repository.readSnapshot(db => repository.queryAvailabilityTarget(db, merchantId, targetId))
      if (!row) return { targetId, state: 'ineligible' }
      return row.available > threshold ? { targetId, state: 'clear' }
        : { targetId, state: 'match', item: availabilityItem(row, threshold, now) }
    }
    return repository.readSnapshot(async db => {
      const row = await db.order.findFirst({ where: { id: targetId, merchantId },
        select: { ...repository.fulfillmentSelect, deliveryModeSnapshot: true } })
      if (!row) throw notFound()
      if (!['pending', 'processing'].includes(row.status) || row.deliveryModeSnapshot !== 'manual_service' || !row.fulfillmentDeadline) {
        return { targetId, state: 'ineligible' }
      }
      return deadlineBand(row.fulfillmentDeadline, now)
        ? { targetId, state: 'match', item: fulfillmentItem(row, now) } : { targetId, state: 'clear' }
    })
  })
}

export async function getDrafts(merchantId: number, beforeProductId?: number, now = new Date()) {
  const candidates = await observeRead('draft_incomplete', () => repository.queryDraftIds(merchantId, beforeProductId))
  const batch = candidates.slice(0, DRAFT_BATCH_SIZE)
  const results: ItemResult[] = new Array(batch.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(DRAFT_CONCURRENCY, batch.length) }, async () => {
    while (next < batch.length) {
      const index = next++
      const targetId = batch[index].id
      try {
        results[index] = await getItem(merchantId, 'draft_incomplete', targetId, now)
      } catch (error) {
        // A candidate deleted/transferred after enumeration is no longer eligible.
        // A direct single-item HTTP request still returns 404 for both cases.
        results[index] = { targetId, state: error instanceof HttpError && error.status === 404 ? 'ineligible' : 'unknown' }
      }
    }
  }))
  scannedDrafts.inc(batch.length)
  const failedProductIds = results.filter(result => result.state === 'unknown').map(result => result.targetId)
  const hasMore = candidates.length > DRAFT_BATCH_SIZE
  return { results, scannedCount: batch.length, checkedCount: batch.length - failedProductIds.length, failedProductIds,
    hasMore, nextBeforeProductId: hasMore ? batch[batch.length - 1].id : null, evaluatedAt: now.toISOString() }
}
