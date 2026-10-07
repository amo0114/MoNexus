import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  availabilityItem,
  draftBatch,
  draftIssue,
  draftItem,
  fulfillmentItem,
  group,
  httpError,
  networkError,
  urgentResponse,
} from '../test/workbenchFixtures'
import type { DraftBatchResponse, ItemResult, UrgentResponse, WorkbenchGroup } from '../api/merchant/workbench'

const api = vi.hoisted(() => ({
  fetchWorkbenchUrgent: vi.fn<() => Promise<UrgentResponse>>(),
  fetchWorkbenchAvailability: vi.fn<() => Promise<WorkbenchGroup>>(),
  fetchWorkbenchDrafts: vi.fn<(before?: number | null) => Promise<DraftBatchResponse>>(),
  fetchWorkbenchItem: vi.fn<(rule: string, id: number) => Promise<ItemResult>>(),
}))
vi.mock('../api/merchant/workbench', () => api)

import {
  FOCUS_REFRESH_MS,
  draftItems,
  hasUncheckedGroups,
  isStale,
  isVerifiedEmpty,
  mergeGroup,
  normalAvailabilityItems,
  urgentItems,
  useMerchantWorkbenchStore,
} from './merchantWorkbench'

const store = () => useMerchantWorkbenchStore.getState()
const T0 = 1_000_000

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function mockHealthy() {
  api.fetchWorkbenchUrgent.mockResolvedValue(urgentResponse([fulfillmentItem(501)], [availabilityItem(42, 0)]))
  api.fetchWorkbenchAvailability.mockResolvedValue(group([availabilityItem(42, 0), availabilityItem(43, 2)]))
  api.fetchWorkbenchDrafts.mockResolvedValue(draftBatch([draftItem(30)]))
}

beforeEach(() => {
  Object.values(api).forEach(fn => fn.mockReset())
  store().reset('epoch:1:session-a')
})

describe('collection probe', () => {
  it('200 enables the module and loads every group on first entry', async () => {
    mockHealthy()
    await store().enter()
    expect(store().availability).toBe('enabled')
    expect(api.fetchWorkbenchUrgent).toHaveBeenCalledTimes(1)
    expect(api.fetchWorkbenchAvailability).toHaveBeenCalledTimes(1)
    expect(api.fetchWorkbenchDrafts).toHaveBeenCalledTimes(1)
    expect(api.fetchWorkbenchDrafts).toHaveBeenCalledWith(null)
    expect(urgentItems(store()).map(item => item.key)).toEqual(['fulfillment_due:501', 'low_availability:42'])
  })

  it('collection 404 hides the module and stops the round', async () => {
    api.fetchWorkbenchUrgent.mockRejectedValue(httpError(404))
    await store().enter()
    expect(store().availability).toBe('disabled')
    expect(api.fetchWorkbenchAvailability).not.toHaveBeenCalled()
    expect(api.fetchWorkbenchDrafts).not.toHaveBeenCalled()
    await store().tick()
    expect(api.fetchWorkbenchUrgent).toHaveBeenCalledTimes(1)
  })

  it('403 is treated as no access, not as a failure banner', async () => {
    api.fetchWorkbenchUrgent.mockRejectedValue(httpError(403))
    await store().enter()
    expect(store().availability).toBe('forbidden')
    expect(hasUncheckedGroups(store())).toBe(false)
  })

  it.each([
    ['5xx', () => httpError(503)],
    ['network', networkError],
  ])('%s keeps the module visible as an unchecked error', async (_label, makeError) => {
    api.fetchWorkbenchUrgent.mockRejectedValue(makeError())
    await store().enter()
    expect(store().availability).toBe('error')
    expect(store().urgentRequestFailed).toBe(true)
    expect(hasUncheckedGroups(store())).toBe(true)
    expect(isVerifiedEmpty(store())).toBe(false)

    mockHealthy()
    await store().refreshAll()
    expect(store().availability).toBe('enabled')
    expect(store().urgentRequestFailed).toBe(false)
  })

  it('does not cache disabled forever: focus re-probes after 30 s, not before', async () => {
    api.fetchWorkbenchUrgent.mockRejectedValue(httpError(404))
    await store().enter()
    const probedAt = store().urgentRequestedAt!
    await store().focus(probedAt + FOCUS_REFRESH_MS - 1)
    expect(api.fetchWorkbenchUrgent).toHaveBeenCalledTimes(1)

    mockHealthy()
    await store().focus(probedAt + FOCUS_REFRESH_MS + 1)
    expect(api.fetchWorkbenchUrgent).toHaveBeenCalledTimes(2)
    expect(store().availability).toBe('enabled')
    expect(api.fetchWorkbenchAvailability).toHaveBeenCalledTimes(1)
    expect(api.fetchWorkbenchDrafts).toHaveBeenCalledTimes(1)
  })

  it('a later entry re-probes a disabled module', async () => {
    api.fetchWorkbenchUrgent.mockRejectedValueOnce(httpError(404))
    await store().enter()
    mockHealthy()
    await store().enter()
    expect(store().availability).toBe('enabled')
  })
})

describe('refresh cadence', () => {
  it('repeated 60 s ticks call only /urgent', async () => {
    mockHealthy()
    await store().enter()
    for (let i = 0; i < 3; i++) await store().tick()
    expect(api.fetchWorkbenchUrgent).toHaveBeenCalledTimes(4)
    expect(api.fetchWorkbenchAvailability).toHaveBeenCalledTimes(1)
    expect(api.fetchWorkbenchDrafts).toHaveBeenCalledTimes(1)
  })

  it('focus refreshes each group only past its own 30 s gate and drafts restart at batch one', async () => {
    mockHealthy()
    await store().enter()
    const started = Date.now()
    await store().focus(started + 1000)
    expect(api.fetchWorkbenchUrgent).toHaveBeenCalledTimes(1)
    expect(api.fetchWorkbenchAvailability).toHaveBeenCalledTimes(1)
    expect(api.fetchWorkbenchDrafts).toHaveBeenCalledTimes(1)

    await store().focus(started + FOCUS_REFRESH_MS + 1000)
    expect(api.fetchWorkbenchUrgent).toHaveBeenCalledTimes(2)
    expect(api.fetchWorkbenchAvailability).toHaveBeenCalledTimes(2)
    expect(api.fetchWorkbenchDrafts).toHaveBeenCalledTimes(2)
    expect(api.fetchWorkbenchDrafts).toHaveBeenLastCalledWith(null)
  })

  it('manual refresh reloads every group and restarts drafts', async () => {
    mockHealthy()
    api.fetchWorkbenchDrafts.mockResolvedValueOnce(draftBatch([draftItem(30)], { hasMore: true, nextBeforeProductId: 30 }))
    await store().enter()
    api.fetchWorkbenchDrafts.mockResolvedValueOnce(draftBatch([draftItem(20)]))
    await store().continueDrafts()
    expect(draftItems(store()).map(item => item.targetId)).toEqual([30, 20])

    api.fetchWorkbenchDrafts.mockResolvedValueOnce(draftBatch([draftItem(30)]))
    await store().refreshAll()
    expect(api.fetchWorkbenchUrgent).toHaveBeenCalledTimes(2)
    expect(api.fetchWorkbenchAvailability).toHaveBeenCalledTimes(2)
    expect(api.fetchWorkbenchDrafts).toHaveBeenLastCalledWith(null)
    expect(draftItems(store()).map(item => item.targetId)).toEqual([30])
  })

  it('continue requests only the next draft batch and accumulates coverage', async () => {
    mockHealthy()
    api.fetchWorkbenchDrafts.mockResolvedValueOnce(draftBatch([draftItem(30)], { scannedCount: 50, checkedCount: 49, failedProductIds: [29], hasMore: true, nextBeforeProductId: 25 }))
    await store().enter()
    api.fetchWorkbenchDrafts.mockResolvedValueOnce(draftBatch([draftItem(20)], { scannedCount: 10, checkedCount: 10 }))
    await store().continueDrafts()
    expect(api.fetchWorkbenchDrafts).toHaveBeenLastCalledWith(25)
    expect(api.fetchWorkbenchUrgent).toHaveBeenCalledTimes(1)
    expect(api.fetchWorkbenchAvailability).toHaveBeenCalledTimes(1)
    const drafts = store().drafts
    expect(drafts.scannedCount).toBe(60)
    expect(drafts.checkedCount).toBe(59)
    expect(drafts.failedProductIds).toEqual([29])
    expect(drafts.hasMore).toBe(false)

    await store().continueDrafts()
    expect(api.fetchWorkbenchDrafts).toHaveBeenCalledTimes(2)
  })

  it('returning from the editor rechecks only the target draft', async () => {
    mockHealthy()
    api.fetchWorkbenchDrafts.mockResolvedValue(draftBatch([draftItem(30), draftItem(31)]))
    await store().enter()
    store().rememberNavigation({ kind: 'edit_product', productId: 30, focus: 'images', offerId: null })
    api.fetchWorkbenchItem.mockResolvedValue({ targetId: 30, state: 'clear' })
    await store().enter(Date.now() + FOCUS_REFRESH_MS * 10)
    expect(api.fetchWorkbenchItem).toHaveBeenCalledWith('draft_incomplete', 30)
    expect(api.fetchWorkbenchDrafts).toHaveBeenCalledTimes(1)
    expect(api.fetchWorkbenchUrgent).toHaveBeenCalledTimes(2)
    expect(draftItems(store()).map(item => item.targetId)).toEqual([31])
    expect(store().pendingReturn).toBeNull()
  })

  it('returning from availability management refreshes urgent and availability', async () => {
    mockHealthy()
    await store().enter()
    store().rememberNavigation({ kind: 'manage_availability', productId: 7, offerId: 43 })
    await store().enter()
    expect(api.fetchWorkbenchUrgent).toHaveBeenCalledTimes(2)
    expect(api.fetchWorkbenchAvailability).toHaveBeenCalledTimes(2)
    expect(api.fetchWorkbenchDrafts).toHaveBeenCalledTimes(1)

    await store().afterAvailabilityChange()
    expect(api.fetchWorkbenchUrgent).toHaveBeenCalledTimes(3)
    expect(api.fetchWorkbenchAvailability).toHaveBeenCalledTimes(3)
    expect(api.fetchWorkbenchDrafts).toHaveBeenCalledTimes(1)
  })

  it('concurrent consumers share one request per group', async () => {
    mockHealthy()
    await Promise.all([store().enter(), store().enter()])
    expect(api.fetchWorkbenchUrgent).toHaveBeenCalledTimes(1)
    expect(api.fetchWorkbenchAvailability).toHaveBeenCalledTimes(1)
    expect(api.fetchWorkbenchDrafts).toHaveBeenCalledTimes(1)
  })
})

describe('single items', () => {
  it('an item 404 removes only that card and never disables the module', async () => {
    mockHealthy()
    api.fetchWorkbenchDrafts.mockResolvedValue(draftBatch([draftItem(30), draftItem(31)], { failedProductIds: [] }))
    await store().enter()
    api.fetchWorkbenchItem.mockRejectedValue(httpError(404))
    await store().recheckDraft(30)
    expect(store().availability).toBe('enabled')
    expect(draftItems(store()).map(item => item.targetId)).toEqual([31])
  })

  it('failed retry keeps the card marked stale; a successful retry clears the failure', async () => {
    mockHealthy()
    api.fetchWorkbenchDrafts.mockResolvedValue(draftBatch([draftItem(30)], {
      results: [{ targetId: 30, state: 'match', item: draftItem(30) }, { targetId: 29, state: 'unknown' }],
      failedProductIds: [29],
    }))
    await store().enter()
    expect(store().drafts.failedProductIds).toEqual([29])

    api.fetchWorkbenchItem.mockRejectedValueOnce(httpError(503))
    await store().recheckDraft(30)
    expect(isStale(store(), draftItem(30))).toBe(true)

    api.fetchWorkbenchItem.mockResolvedValueOnce({ targetId: 29, state: 'match', item: draftItem(29) })
    await store().recheckDraft(29)
    expect(store().drafts.failedProductIds).toEqual([])
    expect(draftItems(store()).map(item => item.targetId)).toEqual([30, 29])
  })
})

describe('stale responses and session isolation', () => {
  it('drops a response that arrives after the account switched', async () => {
    const pending = deferred<UrgentResponse>()
    api.fetchWorkbenchUrgent.mockReturnValueOnce(pending.promise)
    const entering = store().enter()
    store().reset('epoch:2:session-b')
    pending.resolve(urgentResponse([fulfillmentItem(501)]))
    await entering
    expect(store().sessionKey).toBe('epoch:2:session-b')
    expect(store().availability).toBe('unknown')
    expect(store().fulfillment.items).toEqual([])
    expect(api.fetchWorkbenchAvailability).not.toHaveBeenCalled()
  })

  it('reset clears every fact of the previous account', async () => {
    mockHealthy()
    await store().enter()
    store().reset(null)
    const state = store()
    expect(state.availability).toBe('unknown')
    expect(urgentItems(state)).toEqual([])
    expect(normalAvailabilityItems(state)).toEqual([])
    expect(draftItems(state)).toEqual([])
  })

  it('an older draft response cannot overwrite a newer round', async () => {
    mockHealthy()
    await store().enter()
    const older = deferred<DraftBatchResponse>()
    api.fetchWorkbenchDrafts.mockResolvedValueOnce(draftBatch([draftItem(30)], { hasMore: true, nextBeforeProductId: 30 }))
    await store().refreshAll()
    api.fetchWorkbenchDrafts.mockReturnValueOnce(older.promise)
    const continuing = store().continueDrafts()
    api.fetchWorkbenchDrafts.mockResolvedValueOnce(draftBatch([draftItem(40)]))
    // Manual refresh starts a new round; the old continue response must be ignored.
    await store().refreshAll()
    older.resolve(draftBatch([draftItem(10)]))
    await continuing
    expect(draftItems(store()).map(item => item.targetId)).toEqual([40])
  })
})

describe('group merging', () => {
  const previous = mergeGroup(
    { items: [], staleKeys: [], matchedTotal: null, truncated: false, evaluatedAt: null, status: 'idle', loading: false, requestedAt: null },
    group([availabilityItem(42, 1), availabilityItem(43, 2)]),
    T0,
  )

  it('a failed group keeps old cards marked stale', () => {
    const next = mergeGroup(previous, group([], { status: 'failed', matchedTotal: null }), T0 + 1)
    expect(next.status).toBe('failed')
    expect(next.items.map(item => item.key)).toEqual(['low_availability:42', 'low_availability:43'])
    expect(next.staleKeys).toEqual(['low_availability:42', 'low_availability:43'])
  })

  it('a truncated group keeps unseen old cards as stale', () => {
    const next = mergeGroup(previous, group([availabilityItem(42, 1)], { truncated: true, matchedTotal: 250 }), T0 + 1)
    expect(next.items.map(item => item.key)).toEqual(['low_availability:42', 'low_availability:43'])
    expect(next.staleKeys).toEqual(['low_availability:43'])
    expect(next.matchedTotal).toBe(250)
  })

  it('a complete untruncated group drops resolved cards', () => {
    const next = mergeGroup(previous, group([availabilityItem(42, 1)]), T0 + 1)
    expect(next.items.map(item => item.key)).toEqual(['low_availability:42'])
    expect(next.staleKeys).toEqual([])
  })

  it('a failed /urgent keeps the previous urgent cards marked stale', async () => {
    mockHealthy()
    await store().enter()
    api.fetchWorkbenchUrgent.mockRejectedValueOnce(httpError(503))
    await store().tick()
    expect(store().availability).toBe('enabled')
    expect(store().urgentTotal).toBeNull()
    expect(isStale(store(), fulfillmentItem(501))).toBe(true)
    expect(hasUncheckedGroups(store())).toBe(true)
  })
})

describe('derived views', () => {
  it('sold-out offers move to urgent and are not duplicated as normal cards', async () => {
    mockHealthy()
    await store().enter()
    expect(urgentItems(store()).map(item => item.key)).toContain('low_availability:42')
    expect(normalAvailabilityItems(store()).map(item => item.key)).toEqual(['low_availability:43'])
  })

  it('drafts sort by fewest issues, then newest product', async () => {
    mockHealthy()
    api.fetchWorkbenchDrafts.mockResolvedValue(draftBatch([
      draftItem(10),
      draftItem(12, [draftIssue('COVER_REQUIRED', {}, 12), draftIssue('PURCHASE_NOTES_REQUIRED', {}, 12)]),
      draftItem(11),
    ]))
    await store().enter()
    expect(draftItems(store()).map(item => item.targetId)).toEqual([11, 10, 12])
  })

  it('verified empty requires every group complete with no failures or more drafts', async () => {
    api.fetchWorkbenchUrgent.mockResolvedValue(urgentResponse())
    api.fetchWorkbenchAvailability.mockResolvedValue(group([]))
    api.fetchWorkbenchDrafts.mockResolvedValueOnce(draftBatch([], { hasMore: true, nextBeforeProductId: 5, scannedCount: 50 }))
    await store().enter()
    expect(isVerifiedEmpty(store())).toBe(false)

    api.fetchWorkbenchDrafts.mockResolvedValueOnce(draftBatch([], { failedProductIds: [3] }))
    await store().refreshAll()
    expect(isVerifiedEmpty(store())).toBe(false)

    api.fetchWorkbenchDrafts.mockResolvedValueOnce(draftBatch([]))
    await store().refreshAll()
    expect(isVerifiedEmpty(store())).toBe(true)
  })
})
