export interface StorePageCache {
  feedItems: unknown[]
  seenIds: number[]
  category: string
  searchQuery: string
  nextCursor: string | null
  hasMore: boolean
  scrollY: number
  audience: 'guest' | 'member'
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
