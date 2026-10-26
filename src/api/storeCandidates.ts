import api from './client'
import { useAuthStore } from '../stores/authStore'
import { AuthSessionChangedError, readAccessTokenIdentity } from '../auth/sessionContext'
import type { ProductSummary } from '../types/product'

export interface StoreCandidateResponse {
  version: 1
  generatedAt: string
  sponsored: Array<{
    productId: number
    product: ProductSummary
    disclosure: { code: 'sponsored'; label: '推广' }
  }>
  editorial: Array<{
    productId: number
    product: ProductSummary
    publicReason: string | null
    label: '精选'
  }>
}

type Candidates = Pick<StoreCandidateResponse, 'sponsored' | 'editorial'>
interface PendingCandidates {
  controller: AbortController
  consumers: Set<symbol>
  promise: Promise<Candidates>
  settled: boolean
}

// Share only in-flight work. Persisting complete cards needs a revocation
// protocol first: a fresh query must recheck removed campaigns and visibility.
const pending = new Map<string, PendingCandidates>()

function currentIdentity(): string {
  const state = useAuthStore.getState()
  const token = readAccessTokenIdentity(state.accessToken)
  return JSON.stringify([state.isLoggedIn, state.user?.id ?? null,
    token?.sessionId ?? state.sessionId, state.authEpoch])
}

function aborted() { return new DOMException('Candidate request cancelled', 'AbortError') }

export function loadStoreCandidates(categoryCode?: string, signal?: AbortSignal): Promise<Candidates> {
  if (signal?.aborted) return Promise.reject(aborted())
  const identity = currentIdentity()
  const key = JSON.stringify([1, identity, categoryCode ?? null])
  let entry = pending.get(key)
  if (!entry) {
    const controller = new AbortController()
    function finish() {
      created.settled = true
      if (pending.get(key) === created) pending.delete(key)
    }
    const created: PendingCandidates = {
      controller, consumers: new Set(), settled: false,
      promise: Promise.resolve().then(async () => {
        if (!created.consumers.size || controller.signal.aborted) throw aborted()
        const { data } = await api.get<StoreCandidateResponse>('/storefront/candidates', {
          params: categoryCode ? { categoryCode } : {}, signal: controller.signal,
        })
        if (controller.signal.aborted) throw aborted()
        if (identity !== currentIdentity()) throw new AuthSessionChangedError()
        if (data.version !== 1) throw new Error('Unsupported storefront candidate version')
        return { sponsored: data.sponsored, editorial: data.editorial }
      }).then(value => { finish(); return value }, error => { finish(); throw error }),
    }
    pending.set(key, created)
    entry = created
  }
  const shared = entry
  const consumer = Symbol()
  shared.consumers.add(consumer)
  return new Promise((resolve, reject) => {
    let finished = false
    const release = () => {
      signal?.removeEventListener('abort', cancel)
      shared.consumers.delete(consumer)
      if (!shared.settled && !shared.consumers.size) {
        // StrictMode cleanup/setup can reattach before this microtask. One
        // cancelled consumer must never abort another consumer's transport.
        queueMicrotask(() => {
          if (!shared.settled && !shared.consumers.size) {
            shared.controller.abort()
            if (pending.get(key) === shared) pending.delete(key)
          }
        })
      }
    }
    const cancel = () => {
      if (finished) return
      finished = true
      release()
      reject(aborted())
    }
    signal?.addEventListener('abort', cancel, { once: true })
    shared.promise.then(value => {
      if (finished) return
      finished = true
      release()
      resolve(value)
    }, error => {
      if (finished) return
      finished = true
      release()
      reject(error)
    })
  })
}
