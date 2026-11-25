import { registerIdentityScopedMetadataCleanup } from '../stores/authStore'

export interface StorePageCache {
  feedItems: unknown[]
  seenIds: number[]
  category: string
  searchQuery: string
  /** Server-side sort/filter toggles the cached feed was fetched with. */
  listOptions?: unknown
  nextCursor: string | null
  hasMore: boolean
  scrollY: number
  audience: 'guest' | 'member'
  /** Opaque session scope; never reused for another member or login session. */
  identityKey: string
  lastProductId?: number | null
}

let storePageCache: StorePageCache | null = null

export function getStorePageCache<T extends StorePageCache>() {
  return storePageCache as T | null
}

export function setStorePageCache(cache: StorePageCache | null) {
  storePageCache = cache
}

export function clearStorePageCache() {
  storePageCache = null
}

registerIdentityScopedMetadataCleanup(clearStorePageCache)
