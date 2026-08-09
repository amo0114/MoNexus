// Component tests for MerchantPartnerMark (T-MERCH-FE-001).
// AC-MERCH-021 (nothing when not a partner), frozen non-guarantee tooltip
// (CHK-ID-004), keyboard/touch/pointer access, forbidden-word absence.

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'vitest-axe'
import { describe, expect, it } from 'vitest'
import { DISPLAY_LABEL, type MerchantPartnerProjection } from '../../types/merchandising'
import MerchantPartnerMark, { isPartnerEntitlementActive, PARTNER_TOOLTIP } from './MerchantPartnerMark'

// Far-future fixture so the frozen render/label/tooltip/a11y tests never
// depend on wall-clock drift (AC-MERCH-021 expiry is now explicit).
const partner: MerchantPartnerProjection = { label: '平台合作伙伴', validUntil: '2099-12-31T23:59:59.000Z' }

describe('MerchantPartnerMark', () => {
  it('renders nothing when not an active partner (AC-MERCH-021)', () => {
    const { container } = render(<MerchantPartnerMark merchantPartner={null} />)
    expect(container.firstChild).toBeNull()
    const { container: c2 } = render(<MerchantPartnerMark merchantPartner={undefined} />)
    expect(c2.firstChild).toBeNull()
  })

  it('renders nothing when the entitlement is in the past (AC-MERCH-021 expiry)', () => {
    const { container } = render(
      <MerchantPartnerMark merchantPartner={{ label: '平台合作伙伴', validUntil: '2020-01-01T00:00:00.000Z' }} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when validUntil is invalid (fail-closed)', () => {
    const { container } = render(
      <MerchantPartnerMark merchantPartner={{ label: '平台合作伙伴', validUntil: 'not-a-date' }} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders when the entitlement is strictly in the future (AC-MERCH-021)', () => {
    const { container } = render(
      <MerchantPartnerMark merchantPartner={{ label: '平台合作伙伴', validUntil: '2099-12-31T23:59:59.000Z' }} />,
    )
    expect(container.firstChild).not.toBeNull()
    expect(screen.getByText(DISPLAY_LABEL.PARTNER)).toBeInTheDocument()
  })

  it('renders the frozen 平台合作伙伴 label as visible text', () => {
    render(<MerchantPartnerMark merchantPartner={partner} />)
    expect(screen.getByText(DISPLAY_LABEL.PARTNER)).toBeInTheDocument()
  })

  it('exposes the frozen non-guarantee tooltip with the expected text', () => {
    render(<MerchantPartnerMark merchantPartner={partner} />)
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent(PARTNER_TOOLTIP)
    expect(tooltip.textContent).toContain('不代表平台对商品质量作保证')
  })

  it('does not use certification/guarantee words (CHK-ID-004 forbidden words)', () => {
    render(<MerchantPartnerMark merchantPartner={partner} />)
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('平台认证')
    expect(text).not.toContain('官方认证')
    expect(text).not.toContain('平台担保')
    expect(text).not.toContain('质量保证')
  })

  it('links the tooltip to the focusable trigger via aria-describedby', () => {
    render(<MerchantPartnerMark merchantPartner={partner} />)
    const trigger = screen.getByRole('button')
    const tooltip = screen.getByRole('tooltip')
    expect(trigger).toHaveAttribute('aria-describedby', tooltip.id)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens on keyboard focus (focus) and announces via aria-expanded', async () => {
    const user = userEvent.setup()
    render(<MerchantPartnerMark merchantPartner={partner} />)
    const trigger = screen.getByRole('button')
    await user.tab()
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('shows on click for pointer/touch users and hides on blur', async () => {
    const user = userEvent.setup()
    render(<MerchantPartnerMark merchantPartner={partner} />)
    const trigger = screen.getByRole('button')
    await user.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await user.tab()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('is accessible with no axe violations', async () => {
    const { container } = render(<MerchantPartnerMark merchantPartner={partner} />)
    expect(await axe(container, { rules: { 'color-contrast': { enabled: false } } })).toHaveNoViolations()
  })
})

describe('isPartnerEntitlementActive (AC-MERCH-021 fail-closed boundary)', () => {
  // Fixed instant so past/equal/future/invalid are exact and deterministic.
  const NOW = Date.parse('2026-08-09T00:00:00.000Z')
  const past = { label: '平台合作伙伴' as const, validUntil: '2026-08-08T23:59:59.000Z' }
  const equal = { label: '平台合作伙伴' as const, validUntil: '2026-08-09T00:00:00.000Z' }
  const future = { label: '平台合作伙伴' as const, validUntil: '2026-08-09T00:00:01.000Z' }
  const invalid = { label: '平台合作伙伴' as const, validUntil: 'not-a-date' }

  it('is inactive for a past validUntil', () => {
    expect(isPartnerEntitlementActive(past, NOW)).toBe(false)
  })

  it('is inactive when validUntil equals now (expires exactly at now)', () => {
    expect(isPartnerEntitlementActive(equal, NOW)).toBe(false)
  })

  it('is active only for a strictly-future validUntil', () => {
    expect(isPartnerEntitlementActive(future, NOW)).toBe(true)
  })

  it('is inactive for an invalid/unparseable validUntil', () => {
    expect(isPartnerEntitlementActive(invalid, NOW)).toBe(false)
  })

  it('is inactive when the projection is null/undefined', () => {
    expect(isPartnerEntitlementActive(null, NOW)).toBe(false)
    expect(isPartnerEntitlementActive(undefined, NOW)).toBe(false)
  })
})
