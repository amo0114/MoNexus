import { useCallback, useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { getShopProducts, type ShopProfile } from '../api/shops'
import type { ProductSummary as Product } from '../types/product'
import { AuthSessionChangedError } from '../auth/sessionContext'
import { captureException } from '../lib/errorReporter'
import { useAuthSessionKey } from './useProductRecommendations'

export type ShopMoreStatus = 'idle' | 'loading' | 'error' | 'expired'

export type ShopProductsState =
  | { status: 'loading' }
  | { status: 'not_found' }
  | { status: 'error' }
  | {
      status: 'ready'
      shop: ShopProfile
      items: Product[]
      nextCursor: string | null
      hasMore: boolean
      more: ShopMoreStatus
    }

const LOADING: ShopProductsState = { status: 'loading' }

function httpStatus(err: unknown) {
  return axios.isAxiosError(err) ? err.response?.status : undefined
}

/** Expected client/session outcomes are not incidents; only server/network failures are reported. */
function shouldReport(err: unknown): boolean {
  if (err instanceof AuthSessionChangedError || axios.isCancel(err)) return false
  if (axios.isAxiosError(err)) return !err.response || err.response.status >= 500
  return true
}

/**
 * One shop listing keyed by merchant + applied search + auth session. Only state for
 * the current key renders, so another shop or account never flashes stale products;
 * a reload (retry or expired cursor) bumps the key and starts again from page one.
 */
export function useShopProducts(merchantId: number, query: string) {
  const sessionKey = useAuthSessionKey()
  const [reload, setReload] = useState(0)
  const key = `${merchantId}\u0000${query}\u0000${sessionKey}\u0000${reload}`
  const [state, setState] = useState<{ key: string; value: ShopProductsState } | null>(null)
  const keyRef = useRef(key)
  const moreRef = useRef<AbortController | null>(null)
  keyRef.current = key

  useEffect(() => {
    const controller = new AbortController()
    let current = true
    getShopProducts(merchantId, { q: query }, controller.signal)
      .then((page) => {
        if (!current) return
        setState({ key, value: { status: 'ready', ...page, more: 'idle' } })
      })
      .catch((err: unknown) => {
        if (!current) return
        if (httpStatus(err) === 404) {
          setState({ key, value: { status: 'not_found' } })
          return
        }
        if (shouldReport(err)) captureException(err, { scope: 'shop-products', merchantId })
        setState({ key, value: { status: 'error' } })
      })
    return () => {
      current = false
      controller.abort()
      moreRef.current?.abort()
      moreRef.current = null
    }
  }, [merchantId, query, key])

  const value = state?.key === key ? state.value : LOADING

  const loadMore = useCallback(() => {
    if (value.status !== 'ready' || !value.hasMore || !value.nextCursor || value.more === 'loading') return
    const requestKey = key
    const cursor = value.nextCursor
    const controller = new AbortController()
    moreRef.current = controller
    const update = (fn: (ready: Extract<ShopProductsState, { status: 'ready' }>) => ShopProductsState) =>
      setState((prev) => {
        if (keyRef.current !== requestKey || prev?.key !== requestKey || prev.value.status !== 'ready') return prev
        return { key: requestKey, value: fn(prev.value) }
      })
    update(ready => ({ ...ready, more: 'loading' }))
    getShopProducts(merchantId, { q: query, cursor }, controller.signal)
      .then((page) => update((ready) => {
        const seen = new Set(ready.items.map(item => item.id))
        return {
          ...ready,
          items: [...ready.items, ...page.items.filter(item => !seen.has(item.id))],
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
          more: 'idle',
        }
      }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        const status = httpStatus(err)
        if (status === 404) {
          update(() => ({ status: 'not_found' }))
          return
        }
        if (shouldReport(err)) captureException(err, { scope: 'shop-products-more', merchantId })
        update(ready => ({ ...ready, more: status === 409 ? 'expired' : 'error' }))
      })
      .finally(() => {
        if (moreRef.current === controller) moreRef.current = null
      })
  }, [key, merchantId, query, value])

  const retry = useCallback(() => setReload(n => n + 1), [])

  return { state: value, loadMore, retry }
}
