import { useState, useSyncExternalStore } from 'react'
import { useAppStore } from '../stores/appStore'

export const PRODUCT_FAVORITES_KEY = 'monexus:favorites'
const CHANGE_EVENT = 'monexus:favorites:change'
let fallback: string | null = null

function snapshot() {
  if (fallback !== null) return fallback
  try {
    return localStorage.getItem(PRODUCT_FAVORITES_KEY) ?? '[]'
  } catch {
    return '[]'
  }
}
function parse(value: string): number[] {
  try {
    const values: unknown = JSON.parse(value)
    return Array.isArray(values)
      ? [...new Set(values.filter((id): id is number => Number.isSafeInteger(id) && id > 0))]
      : []
  } catch {
    return []
  }
}
function subscribe(notify: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === PRODUCT_FAVORITES_KEY || event.key === null) {
      fallback = null
      notify()
    }
  }
  window.addEventListener('storage', storage)
  window.addEventListener(CHANGE_EVENT, notify)
  return () => {
    window.removeEventListener('storage', storage)
    window.removeEventListener(CHANGE_EVENT, notify)
  }
}

/** Preview favorites stay ephemeral; real favorites are local to this browser. */
export function useProductFavorite(productId: number, persist = true) {
  const value = useSyncExternalStore(subscribe, snapshot, () => '[]')
  const [previewFavorite, setPreviewFavorite] = useState(false)
  const persistent = persist && Number.isSafeInteger(productId) && productId > 0
  const favorite = persistent ? parse(value).includes(productId) : previewFavorite
  const toggle = () => {
    const nextFavorite = !favorite
    if (!persistent) {
      setPreviewFavorite((current) => !current)
      useAppStore.getState().triggerIslandActivity({
        kind: 'favorite',
        title: nextFavorite ? '已加入收藏' : '已取消收藏',
        payload: { favorite: nextFavorite },
        durationMs: 2500,
      })
      return
    }
    const ids = parse(snapshot())
    const next = JSON.stringify(
      ids.includes(productId) ? ids.filter((id) => id !== productId) : [...ids, productId]
    )
    try {
      localStorage.setItem(PRODUCT_FAVORITES_KEY, next)
      fallback = null
    } catch {
      fallback = next
    }
    window.dispatchEvent(new Event(CHANGE_EVENT))
    useAppStore.getState().triggerIslandActivity({
      kind: 'favorite',
      title: nextFavorite ? '已加入收藏' : '已取消收藏',
      payload: { favorite: nextFavorite },
      durationMs: 2500,
    })
  }
  return { favorite, toggle }
}
