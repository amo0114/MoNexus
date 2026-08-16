// Component tests for BadgeMark (T-MERCH-FE-001).
// AC-MERCH-023 (fixed order, max 3), AC-MERCH-024 (unknown ignored),
// text-not-color-only semantics (D-MERCH-15) and a11y.

import { render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import { describe, expect, it } from 'vitest'
import { DISPLAY_LABEL, type BadgeSpec } from '../../types/merchandising'
import BadgeMark from './BadgeMark'

const allBadges: BadgeSpec[] = [
  { code: 'platform_owned', label: DISPLAY_LABEL.PLATFORM_OWNED },
  { code: 'platform_pick', label: DISPLAY_LABEL.PLATFORM_PICK },
  { code: 'hot', label: DISPLAY_LABEL.HOT },
]

describe('BadgeMark', () => {
  it('renders nothing when there are no badges', () => {
    const { container } = render(<BadgeMark badges={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders badges as visible DOM text in the frozen order (AC-MERCH-023)', () => {
    render(<BadgeMark badges={[allBadges[2], allBadges[0], allBadges[1]]} />)
    const items = screen.getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual([
      DISPLAY_LABEL.PLATFORM_OWNED,
      DISPLAY_LABEL.PLATFORM_PICK,
      DISPLAY_LABEL.HOT,
    ])
  })

  it('caps the rendered badge strip at three (AC-MERCH-023)', () => {
    render(<BadgeMark badges={[...allBadges, { code: 'hot', label: DISPLAY_LABEL.HOT }]} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('ignores unknown codes without a certification fallback (AC-MERCH-024)', () => {
    render(
      <BadgeMark
        badges={[
          { code: 'platform_verified' as never, label: '平台认证' as never },
          { code: 'hot', label: DISPLAY_LABEL.HOT },
        ]}
      />,
    )
    const text = screen.getByRole('list').textContent ?? ''
    expect(text).toBe(DISPLAY_LABEL.HOT)
    expect(text).not.toContain('认证')
  })

  it('shows the label text (not color/icon only) and keeps icons decorative', () => {
    render(<BadgeMark badges={allBadges} />)
    expect(screen.getByText(DISPLAY_LABEL.PLATFORM_OWNED)).toBeInTheDocument()
    expect(screen.getByText(DISPLAY_LABEL.PLATFORM_PICK)).toBeInTheDocument()
    expect(screen.getByText(DISPLAY_LABEL.HOT)).toBeInTheDocument()
    // All svg icons must be aria-hidden (decorative only).
    const icons = document.querySelectorAll('svg')
    expect(icons.length).toBeGreaterThan(0)
    icons.forEach((icon) => expect(icon).toHaveAttribute('aria-hidden', 'true'))
  })

  it('exposes the badge strip to assistive tech with a labelled list', async () => {
    const { container } = render(<BadgeMark badges={allBadges} />)
    const list = screen.getByRole('list')
    expect(list).toHaveAttribute('aria-label', '商品标识')
    expect(await axe(container, { rules: { 'color-contrast': { enabled: false } } })).toHaveNoViolations()
  })
})
