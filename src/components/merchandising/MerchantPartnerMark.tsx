// T-MERCH-FE-001 — MerchantPartnerMark: partner decoration in the merchant
// identity area.
//
// Only signals a commercial collaboration, never certification. The frozen
// label 平台合作伙伴 is rendered as visible DOM text next to a decorative
// handshake icon, and the non-guarantee tooltip (SPEC-MERCH-001 §8.3) is
// always in the DOM and reachable by mouse, keyboard (focus) and screen
// reader (aria-describedby). Forbidden words (平台认证/官方认证/平台担保/
// 质量保证) are deliberately absent.
//
// The mark renders nothing when the merchant is not an active partner
// (AC-MERCH-021 expiry), and it is NOT part of the product badge strip
// (D-MERCH-19).

import { useState, type MouseEvent, type FocusEvent, type KeyboardEvent } from 'react'
import { useId } from 'react'
import { Handshake } from 'lucide-react'
import type { MerchantPartnerProjection } from '../../types/merchandising'
import './merchandising.css'

/** Frozen non-guarantee tooltip (SPEC-MERCH-001 §8.3). */
export const PARTNER_TOOLTIP = '该商家当前参与平台商业合作计划；不代表平台对商品质量作保证。'

export interface MerchantPartnerMarkProps {
  /** Active partner projection, or null/undefined when not a partner. */
  merchantPartner: MerchantPartnerProjection | null | undefined
  className?: string
}

export default function MerchantPartnerMark({ merchantPartner, className = '' }: MerchantPartnerMarkProps) {
  const tooltipId = useId()
  const [open, setOpen] = useState(false)

  if (!merchantPartner) return null

  const show = () => setOpen(true)
  const hide = () => setOpen(false)
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') hide()
  }

  return (
    <span className={`merch-partner ${className}`.trim()} data-testid="merch-partner-mark">
      <button
        type="button"
        className="merch-partner-trigger"
        aria-describedby={tooltipId}
        aria-expanded={open}
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          event.stopPropagation()
          show()
        }}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={(event: FocusEvent<HTMLButtonElement>) => {
          event.stopPropagation()
          show()
        }}
        onBlur={hide}
        onKeyDown={onKeyDown}
      >
        <Handshake className="merch-partner-icon" aria-hidden="true" />
        <span>{merchantPartner.label}</span>
      </button>
      <span role="tooltip" id={tooltipId} className="merch-partner-tooltip">
        {PARTNER_TOOLTIP}
      </span>
    </span>
  )
}
