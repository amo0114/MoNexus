import { useEffect } from 'react'
import type { PurchaseBoundaryProps } from '../registry'
import { useXboardPurchaseExtension } from './useXboardPurchaseExtension'

export default function XboardPurchaseBoundary({ context, onEffectiveQuery, children }: PurchaseBoundaryProps) {
  const state = useXboardPurchaseExtension(context)
  const query = state.effectiveQuery ? JSON.stringify(state.effectiveQuery) : ''
  useEffect(() => {
    if (query) onEffectiveQuery?.(JSON.parse(query))
  }, [query, onEffectiveQuery])
  return children(state)
}
