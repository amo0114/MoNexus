import { useEffect, useState, type ComponentType, type ReactNode } from 'react'
import type { PurchaseExtensionContext, PurchaseExtensionState } from './purchase'
import { IDLE_PURCHASE_EXTENSION } from './purchase'

export type PurchaseBoundaryProps = {
  context: PurchaseExtensionContext
  onEffectiveQuery?: (query: Record<string, string>) => void
  children(state: PurchaseExtensionState): ReactNode
}

const unavailable: PurchaseExtensionState = { ready: false, busy: false }
const loading: PurchaseExtensionState = { ready: false, busy: true }

export function PurchaseExtensionBoundary(props: PurchaseBoundaryProps) {
  const isXboard = props.context.preview?.fulfillmentProvider === 'faka_bridge'
  const [Extension, setExtension] = useState<ComponentType<PurchaseBoundaryProps> | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!isXboard || Extension || failed) return
    let live = true
    void import('./xboard/XboardPurchaseBoundary').then(
      module => { if (live) setExtension(() => module.default) },
      () => { if (live) setFailed(true) },
    )
    return () => { live = false }
  }, [isXboard, Extension, failed])

  // Keep provider-local state during the brief null preview of a requote.
  if (Extension && (isXboard || !props.context.preview)) return <Extension {...props} />
  if (isXboard) return props.children(failed ? unavailable : loading)
  return props.children(IDLE_PURCHASE_EXTENSION)
}
