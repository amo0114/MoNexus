import { useEffect, useState } from 'react'
import axios from 'axios'
import { getProductRecommendations, type RecommendedProduct } from '../api/productRecommendations'
import { AuthSessionChangedError, getAuthSessionContext } from '../auth/sessionContext'
import { captureException } from '../lib/errorReporter'
import { useAuthStore } from '../stores/authStore'

export type ProductRecommendationsState =
  | { status: 'idle' | 'loading' | 'error'; items: [] }
  | { status: 'ready'; items: RecommendedProduct[]; tracking?: { listToken: string } }

const IDLE: ProductRecommendationsState = { status: 'idle', items: [] }
const LOADING: ProductRecommendationsState = { status: 'loading', items: [] }

export function useAuthSessionKey(): string {
  return useAuthStore((state) => {
    const context = getAuthSessionContext(state)
    return context ? `${context.userId}:${context.sessionId}:${context.authEpoch}` : 'guest'
  })
}

/** Expected client/session outcomes are not incidents; only server/network failures are reported. */
function shouldReport(err: unknown): boolean {
  if (err instanceof AuthSessionChangedError || axios.isCancel(err)) return false
  if (axios.isAxiosError(err)) return !err.response || err.response.status >= 500
  return true
}

/**
 * Related products for one detail page. Keyed by route product id + auth session
 * only (not the loaded product or selected offer), and results are only returned
 * while their key is current, so stale cards never render for another product or
 * account — not even for the frame before the effect re-runs.
 */
export function useProductRecommendations(productId: number | null, enabled: boolean): ProductRecommendationsState {
  const sessionKey = useAuthSessionKey()
  const key = `${productId}:${sessionKey}`
  const [state, setState] = useState<{ key: string; value: ProductRecommendationsState } | null>(null)

  useEffect(() => {
    if (!enabled || productId == null) return
    const controller = new AbortController()
    let current = true
    setState({ key, value: LOADING })
    getProductRecommendations(productId, controller.signal)
      .then((data) => {
        if (!current) return
        if (data.productId !== productId) {
          captureException(new Error('product recommendations returned for another product'), {
            requestedProductId: productId,
            responseProductId: data.productId,
          })
          setState({ key, value: { status: 'error', items: [] } })
          return
        }
        setState({ key, value: { status: 'ready', items: data.items, tracking: data.tracking } })
      })
      .catch((err: unknown) => {
        if (!current) return
        if (shouldReport(err)) captureException(err, { scope: 'product-recommendations', productId })
        setState({ key, value: { status: 'error', items: [] } })
      })
    return () => {
      current = false
      controller.abort()
    }
  }, [enabled, productId, key])

  if (!enabled || productId == null) return IDLE
  return state?.key === key ? state.value : LOADING
}
