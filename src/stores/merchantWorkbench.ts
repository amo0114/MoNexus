import { create } from 'zustand'
import {
  fetchWorkbenchAvailability,
  fetchWorkbenchDrafts,
  fetchWorkbenchItem,
  fetchWorkbenchUrgent,
  type DraftBatchResponse,
  type ItemResult,
  type WorkbenchAction,
  type WorkbenchGroup,
  type WorkbenchItem,
} from '../api/merchant/workbench'

// SPEC-MERCHANT-WORKBENCH-001 §3.2 / §12. One page-level store shared by the
// summary and the full list: requests are de-duplicated per group, responses
// from an old session or an older request of the same group are dropped, and
// a failed or truncated group never removes cards it could not re-confirm.

/** Collection-endpoint verdict. Only a collection 404 means the module is off. */
export type WorkbenchAvailability = 'unknown' | 'enabled' | 'disabled' | 'forbidden' | 'error'

export type GroupState = {
  items: WorkbenchItem[]
  /** Keys kept from an earlier response that the latest response could not re-confirm. */
  staleKeys: string[]
  matchedTotal: number | null
  truncated: boolean
  evaluatedAt: string | null
  status: 'idle' | 'complete' | 'failed'
  loading: boolean
  /** Client clock of the last request start; drives the 30 s focus gate. */
  requestedAt: number | null
}

export type DraftEntry = { productId: number; item: WorkbenchItem | null; stale: boolean }

export type DraftState = {
  /** Accumulated results of the current round, keyed by product id. */
  entries: Record<number, DraftEntry>
  scannedCount: number
  checkedCount: number
  failedProductIds: number[]
  hasMore: boolean
  nextBeforeProductId: number | null
  evaluatedAt: string | null
  status: 'idle' | 'complete' | 'failed'
  loading: boolean
  requestedAt: number | null
}

type PendingReturn = { action: WorkbenchAction }

type State = {
  sessionKey: string | null
  availability: WorkbenchAvailability
  /** The last urgent request failed (network/5xx) — show "部分事项暂未检查". */
  urgentRequestFailed: boolean
  fulfillment: GroupState
  soldOut: GroupState
  urgentTotal: number | null
  urgentKnownCount: number
  availabilityGroup: GroupState
  drafts: DraftState
  pendingReturn: PendingReturn | null
  /** Start of the last /urgent request (also the availability probe); gates focus re-probes. */
  urgentRequestedAt: number | null
}

type Actions = {
  reset: (sessionKey: string | null) => void
  /** Page entry: always probes /urgent; loads other groups once enabled. */
  enter: (now?: number) => Promise<void>
  /** 60 s visible-and-focused tick: /urgent only, never drafts. */
  tick: () => Promise<void>
  /** Focus regained: each group refreshes only if its last request is older than 30 s. */
  focus: (now?: number) => Promise<void>
  /** Manual refresh: every group, drafts restart from the first batch. */
  refreshAll: () => Promise<void>
  continueDrafts: () => Promise<void>
  recheckDraft: (productId: number) => Promise<void>
  /** A successful availability write on this page (deep-link dialog). */
  afterAvailabilityChange: () => Promise<void>
  rememberNavigation: (action: WorkbenchAction) => void
}

export const FOCUS_REFRESH_MS = 30_000
export const POLL_INTERVAL_MS = 60_000

function emptyGroup(): GroupState {
  return { items: [], staleKeys: [], matchedTotal: null, truncated: false, evaluatedAt: null, status: 'idle', loading: false, requestedAt: null }
}

function emptyDrafts(): DraftState {
  return {
    entries: {}, scannedCount: 0, checkedCount: 0, failedProductIds: [], hasMore: false,
    nextBeforeProductId: null, evaluatedAt: null, status: 'idle', loading: false, requestedAt: null,
  }
}

function initialState(sessionKey: string | null): State {
  return {
    sessionKey,
    availability: 'unknown',
    urgentRequestFailed: false,
    fulfillment: emptyGroup(),
    soldOut: emptyGroup(),
    urgentTotal: null,
    urgentKnownCount: 0,
    availabilityGroup: emptyGroup(),
    drafts: emptyDrafts(),
    pendingReturn: null,
    urgentRequestedAt: null,
  }
}

type FailureKind = 'disabled' | 'forbidden' | 'unauthenticated' | 'failed'

function classify(error: unknown): FailureKind {
  const status = (error as { response?: { status?: number } } | undefined)?.response?.status
  if (status === 404) return 'disabled'
  if (status === 403) return 'forbidden'
  if (status === 401) return 'unauthenticated'
  return 'failed'
}

/**
 * Merge a fresh group into the previous one. Only a complete, untruncated
 * response may drop cards that disappeared; otherwise unseen cards stay and
 * are marked stale ("待刷新") instead of being treated as resolved.
 */
export function mergeGroup(previous: GroupState, next: WorkbenchGroup, requestedAt: number): GroupState {
  const base = { evaluatedAt: next.evaluatedAt, loading: false, requestedAt }
  if (next.status === 'failed') {
    return { ...previous, ...base, status: 'failed', staleKeys: previous.items.map(item => item.key) }
  }
  if (!next.truncated) {
    return { ...base, items: next.items, staleKeys: [], matchedTotal: next.matchedTotal, truncated: false, status: 'complete' }
  }
  const seen = new Set(next.items.map(item => item.key))
  const kept = previous.items.filter(item => !seen.has(item.key))
  return {
    ...base,
    items: [...next.items, ...kept],
    staleKeys: kept.map(item => item.key),
    matchedTotal: next.matchedTotal,
    truncated: true,
    status: 'complete',
  }
}

function markGroupFailed(previous: GroupState, requestedAt: number): GroupState {
  // Keep the last known cards but flag them; the group is not "checked" now.
  return { ...previous, loading: false, requestedAt, status: 'failed', staleKeys: previous.items.map(item => item.key) }
}

function applyDraftResult(entries: Record<number, DraftEntry>, result: ItemResult): Record<number, DraftEntry> {
  const next = { ...entries }
  if (result.state === 'match') {
    next[result.targetId] = { productId: result.targetId, item: result.item, stale: false }
  } else if (result.state === 'unknown') {
    // Keep whatever we showed before, flagged; never treat a failed check as cleared.
    const previous = next[result.targetId]
    next[result.targetId] = { productId: result.targetId, item: previous?.item ?? null, stale: true }
  } else {
    delete next[result.targetId]
  }
  return next
}

function withId(ids: number[], id: number) {
  return ids.includes(id) ? ids : [...ids, id]
}

// Per-group request generations and in-flight de-duplication (module level,
// shared by every component on the page). `epoch` is bumped on a session
// reset and whenever a collection says the module is unavailable, so every
// request started before that point is ignored when it settles.
const generation = { urgent: 0, availability: 0, drafts: 0, epoch: 0 }
const inflight: { urgent: Promise<void> | null; availability: Promise<void> | null; draftReset: Promise<void> | null } = {
  urgent: null, availability: null, draftReset: null,
}
// Draft results come from batches and single-item rechecks. Every draft
// request takes a sequence number; per product, only a result from a request
// started no earlier than the last applied one may land. A reset round also
// supersedes every recheck started before it.
const draftOrder = { seq: 0, lastReset: 0, product: new Map<number, number>() }

function invalidateRequests() {
  generation.epoch += 1
  inflight.urgent = null
  inflight.availability = null
  inflight.draftReset = null
  draftOrder.product.clear()
}

export const useMerchantWorkbenchStore = create<State & Actions>()((set, get) => {
  /** A collection reported 404/403: drop all facts and every in-flight request; only a new probe re-enables. */
  function markUnavailable(kind: 'disabled' | 'forbidden') {
    const { sessionKey, urgentRequestedAt } = get()
    invalidateRequests()
    set({ ...initialState(sessionKey), availability: kind, urgentRequestedAt })
  }

  function loadUrgent(): Promise<void> {
    if (inflight.urgent) return inflight.urgent
    const session = generation.epoch
    const seq = ++generation.urgent
    const requestedAt = Date.now()
    set(state => ({ urgentRequestedAt: requestedAt, fulfillment: { ...state.fulfillment, loading: true }, soldOut: { ...state.soldOut, loading: true } }))
    const request = (async () => {
      try {
        const data = await fetchWorkbenchUrgent()
        if (session !== generation.epoch || seq !== generation.urgent) return
        set(state => ({
          availability: 'enabled',
          urgentRequestFailed: false,
          fulfillment: mergeGroup(state.fulfillment, data.fulfillment, requestedAt),
          soldOut: mergeGroup(state.soldOut, data.soldOut, requestedAt),
          urgentTotal: data.urgentTotal,
          urgentKnownCount: data.urgentKnownCount,
        }))
      } catch (error) {
        if (session !== generation.epoch || seq !== generation.urgent) return
        const kind = classify(error)
        if (kind === 'disabled' || kind === 'forbidden') {
          // Module off (or merchant no longer active): stop this round and clear facts.
          markUnavailable(kind)
          return
        }
        set(state => ({
          // 401 is handled by the shared client/session; anything else is a retryable failure.
          availability: state.availability === 'enabled' ? 'enabled' : kind === 'failed' ? 'error' : state.availability,
          urgentRequestFailed: kind === 'failed',
          fulfillment: markGroupFailed(state.fulfillment, requestedAt),
          soldOut: markGroupFailed(state.soldOut, requestedAt),
          urgentTotal: null,
        }))
      }
    })()
    inflight.urgent = request
    // The body never rejects; clear the de-dup slot once this request settles.
    void request.finally(() => { if (inflight.urgent === request) inflight.urgent = null })
    return request
  }

  function loadAvailability(): Promise<void> {
    if (inflight.availability) return inflight.availability
    const session = generation.epoch
    const seq = ++generation.availability
    const requestedAt = Date.now()
    set(state => ({ availabilityGroup: { ...state.availabilityGroup, loading: true } }))
    const request = (async () => {
      try {
        const data = await fetchWorkbenchAvailability()
        if (session !== generation.epoch || seq !== generation.availability) return
        set(state => ({ availabilityGroup: mergeGroup(state.availabilityGroup, data, requestedAt) }))
      } catch (error) {
        if (session !== generation.epoch || seq !== generation.availability) return
        const kind = classify(error)
        if (kind === 'disabled' || kind === 'forbidden') {
          markUnavailable(kind)
          return
        }
        set(state => ({ availabilityGroup: markGroupFailed(state.availabilityGroup, requestedAt) }))
      }
    })()
    inflight.availability = request
    void request.finally(() => { if (inflight.availability === request) inflight.availability = null })
    return request
  }

  /** `reset` starts a new round from the first batch; otherwise continue with the cursor. */
  function loadDrafts(mode: 'reset' | 'next'): Promise<void> {
    if (mode === 'reset') {
      // Two consumers entering together share one first-batch request.
      if (inflight.draftReset) return inflight.draftReset
      const request = runDrafts('reset').finally(() => {
        if (inflight.draftReset === request) inflight.draftReset = null
      })
      inflight.draftReset = request
      return request
    }
    return runDrafts('next')
  }

  async function runDrafts(mode: 'reset' | 'next'): Promise<void> {
    const current = get().drafts
    if (mode === 'next' && (current.loading || !current.hasMore || current.nextBeforeProductId == null)) return
    const session = generation.epoch
    const seq = ++generation.drafts
    const order = ++draftOrder.seq
    if (mode === 'reset') draftOrder.lastReset = order
    const requestedAt = Date.now()
    const cursor = mode === 'next' ? current.nextBeforeProductId : null
    set(state => ({ drafts: { ...state.drafts, loading: true, requestedAt: mode === 'reset' ? requestedAt : state.drafts.requestedAt } }))
    try {
      const data: DraftBatchResponse = await fetchWorkbenchDrafts(cursor)
      if (session !== generation.epoch || seq !== generation.drafts) return
      // A recheck started after this batch owns its product's result.
      const newer = (productId: number) => (draftOrder.product.get(productId) ?? 0) > order
      const state = get().drafts
      // A reset round starts empty, except for results of rechecks newer than it.
      let entries: Record<number, DraftEntry> = mode === 'reset'
        ? Object.fromEntries(Object.entries(state.entries).filter(([id]) => newer(Number(id))))
        : state.entries
      const covered = new Set<number>()
      for (const result of data.results) {
        if (newer(result.targetId)) continue
        covered.add(result.targetId)
        draftOrder.product.set(result.targetId, order)
        // A reset round keeps previous cards for products that this batch reports as unknown.
        if (mode === 'reset' && result.state === 'unknown' && state.entries[result.targetId]) {
          entries = { ...entries, [result.targetId]: { ...state.entries[result.targetId], stale: true } }
        } else {
          entries = applyDraftResult(entries, result)
        }
      }
      const kept = state.failedProductIds.filter(id => (mode === 'reset' ? newer(id) : !covered.has(id)))
      const failed = data.failedProductIds.filter(id => !newer(id)).reduce(withId, kept)
      set({
        drafts: {
          entries,
          scannedCount: (mode === 'reset' ? 0 : state.scannedCount) + data.scannedCount,
          checkedCount: (mode === 'reset' ? 0 : state.checkedCount) + data.checkedCount,
          failedProductIds: failed,
          hasMore: data.hasMore,
          nextBeforeProductId: data.nextBeforeProductId,
          evaluatedAt: data.evaluatedAt,
          status: 'complete',
          loading: false,
          requestedAt: mode === 'reset' ? requestedAt : state.requestedAt,
        },
      })
    } catch (error) {
      if (session !== generation.epoch || seq !== generation.drafts) return
      const kind = classify(error)
      if (kind === 'disabled' || kind === 'forbidden') {
        markUnavailable(kind)
        return
      }
      set(state => ({
        drafts: {
          ...state.drafts,
          loading: false,
          status: 'failed',
          entries: Object.fromEntries(Object.entries(state.drafts.entries).map(([id, entry]) => [id, { ...entry, stale: true }])),
        },
      }))
    }
  }

  async function recheckDraft(productId: number): Promise<void> {
    if (get().availability !== 'enabled') return
    const session = generation.epoch
    const order = ++draftOrder.seq
    draftOrder.product.set(productId, order)
    // Superseded by a newer batch/recheck of this product, a newer round, or a reset/unavailable epoch.
    const current = () => session === generation.epoch && order > draftOrder.lastReset && draftOrder.product.get(productId) === order
    let result: ItemResult
    try {
      result = await fetchWorkbenchItem('draft_incomplete', productId)
    } catch (error) {
      if (!current()) return
      const status = (error as { response?: { status?: number } } | undefined)?.response?.status
      // A single-resource 404 only means this product is gone/not ours: drop
      // its card, never switch the whole module off.
      if (status === 404) {
        set(state => {
          const entries = { ...state.drafts.entries }
          delete entries[productId]
          return { drafts: { ...state.drafts, entries, failedProductIds: state.drafts.failedProductIds.filter(id => id !== productId) } }
        })
        return
      }
      result = { targetId: productId, state: 'unknown' }
    }
    if (!current()) return
    set(state => ({
      drafts: {
        ...state.drafts,
        entries: applyDraftResult(state.drafts.entries, result),
        // A failed check stays listed (banner + retry) until a later check settles it.
        failedProductIds: result.state === 'unknown'
          ? withId(state.drafts.failedProductIds, productId)
          : state.drafts.failedProductIds.filter(id => id !== productId),
      },
    }))
  }

  function stale(requestedAt: number | null, now: number) {
    return requestedAt == null || now - requestedAt > FOCUS_REFRESH_MS
  }

  return {
    ...initialState(null),

    reset(sessionKey) {
      invalidateRequests()
      set(initialState(sessionKey))
    },

    async enter(now = Date.now()) {
      const pending = get().pendingReturn
      set({ pendingReturn: null })
      await loadUrgent()
      if (get().availability !== 'enabled') return
      const tasks: Array<Promise<void>> = []
      const availabilityTouched = pending?.action.kind === 'manage_availability'
      if (availabilityTouched || stale(get().availabilityGroup.requestedAt, now)) tasks.push(loadAvailability())
      if (pending?.action.kind === 'edit_product') {
        // Returning from the editor: re-check only that product, never rescan the batch.
        tasks.push(recheckDraft(pending.action.productId))
      } else if (stale(get().drafts.requestedAt, now)) {
        tasks.push(loadDrafts('reset'))
      }
      await Promise.all(tasks)
    },

    async tick() {
      if (get().availability !== 'enabled') return
      await loadUrgent()
    },

    async focus(now = Date.now()) {
      // Each group has its own 30 s gate. A disabled/failed module is re-probed
      // through /urgent under the same gate, never by the 60 s timer.
      if (stale(get().urgentRequestedAt, now)) await loadUrgent()
      if (get().availability !== 'enabled') return
      const tasks: Array<Promise<void>> = []
      if (stale(get().availabilityGroup.requestedAt, now)) tasks.push(loadAvailability())
      if (stale(get().drafts.requestedAt, now)) tasks.push(loadDrafts('reset'))
      await Promise.all(tasks)
    },

    async refreshAll() {
      await loadUrgent()
      if (get().availability !== 'enabled') return
      await Promise.all([loadAvailability(), loadDrafts('reset')])
    },

    continueDrafts: () => loadDrafts('next'),
    recheckDraft,

    async afterAvailabilityChange() {
      if (get().availability !== 'enabled') return
      await Promise.all([loadUrgent(), loadAvailability()])
    },

    rememberNavigation(action) {
      set({ pendingReturn: { action } })
    },
  }
})

// ---------------------------------------------------------------------------
// Derived views (pure; shared by the summary and the full list).

export function urgentItems(state: Pick<State, 'fulfillment' | 'soldOut'>): WorkbenchItem[] {
  // Server order inside each group: overdue → due soon (deadline asc); sold out by offer.
  return [...state.fulfillment.items, ...state.soldOut.items]
}

/**
 * Normal low-stock cards: availability items that are not urgent. A spec
 * that the latest urgent poll reports as sold out moves to the urgent area;
 * a sold-out item only seen in the (older) availability group is not shown
 * as a normal card — it waits for that group's next refresh.
 */
export function normalAvailabilityItems(state: Pick<State, 'soldOut' | 'availabilityGroup'>): WorkbenchItem[] {
  const urgentKeys = new Set(state.soldOut.items.map(item => item.key))
  return state.availabilityGroup.items.filter(item => item.priority === 'normal' && !urgentKeys.has(item.key))
}

export function draftItems(state: Pick<State, 'drafts'>): WorkbenchItem[] {
  return Object.values(state.drafts.entries)
    .filter((entry): entry is DraftEntry & { item: WorkbenchItem } => entry.item != null)
    .map(entry => entry.item)
    .sort((a, b) => {
      const issues = (item: WorkbenchItem) => item.evidence.kind === 'draft' ? item.evidence.issues.length : 0
      return issues(a) - issues(b) || b.targetId - a.targetId
    })
}

export function isStale(state: Pick<State, 'fulfillment' | 'soldOut' | 'availabilityGroup' | 'drafts'>, item: WorkbenchItem): boolean {
  if (item.rule === 'draft_incomplete') return state.drafts.entries[item.targetId]?.stale ?? false
  if (item.rule === 'fulfillment_due') return state.fulfillment.staleKeys.includes(item.key)
  return state.soldOut.staleKeys.includes(item.key) || state.availabilityGroup.staleKeys.includes(item.key)
}

/** True only when every group was checked completely and nothing needs attention. */
export function isVerifiedEmpty(state: State): boolean {
  const groupsComplete = [state.fulfillment, state.soldOut, state.availabilityGroup]
    .every(group => group.status === 'complete' && !group.truncated && group.staleKeys.length === 0)
  const draftsComplete = state.drafts.status === 'complete' && !state.drafts.hasMore && state.drafts.failedProductIds.length === 0
  const draftsSettled = Object.values(state.drafts.entries).every(entry => !entry.stale)
  return !state.urgentRequestFailed && groupsComplete && draftsComplete && draftsSettled
    && urgentItems(state).length === 0 && normalAvailabilityItems(state).length === 0 && draftItems(state).length === 0
}

/** Any group whose latest check failed or could not be completed. */
export function hasUncheckedGroups(state: State): boolean {
  return state.urgentRequestFailed
    || [state.fulfillment, state.soldOut, state.availabilityGroup].some(group => group.status === 'failed')
    || state.drafts.status === 'failed'
    || state.drafts.failedProductIds.length > 0
}

export type MerchantWorkbenchState = State
