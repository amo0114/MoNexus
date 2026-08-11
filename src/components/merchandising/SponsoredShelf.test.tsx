// Component tests for SponsoredShelf (T-MERCH-FE-001).
// AC-MERCH-016 (every sponsored card shows the 推广 disclosure as visible DOM
// text), CHK-PUBLIC-003 (not color/icon only), safe loading/error/empty
// states, and a11y.

import { render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import { describe, expect, it } from 'vitest'
import type { SponsoredShelfItem } from '../../types/merchandising'
import SponsoredShelf from './SponsoredShelf'

const items: SponsoredShelfItem[] = [
  { productId: 1, disclosure: { code: 'sponsored', label: '推广' } },
  { productId: 2, disclosure: { code: 'sponsored', label: '推广' } },
]

function renderItem(item: SponsoredShelfItem) {
  return <div data-testid={`card-${item.productId}`}>商品 {item.productId}</div>
}

describe('SponsoredShelf', () => {
  it('renders a forced 推广 disclosure for every card as visible DOM text (AC-MERCH-016)', () => {
    render(<SponsoredShelf items={items} renderItem={renderItem} />)
    const disclosures = screen.getAllByTestId('merch-sponsored-disclosure')
    expect(disclosures).toHaveLength(2)
    disclosures.forEach((d) => {
      expect(d.textContent).toBe('推广')
    })
    // The disclosure text must be part of the accessibility tree (not icon-only).
    expect(screen.getAllByText('推广')).toHaveLength(2)
  })

  it('keeps disclosure icons decorative and renders host card content', () => {
    render(<SponsoredShelf items={items} renderItem={renderItem} />)
    expect(screen.getByTestId('card-1')).toBeInTheDocument()
    expect(screen.getByTestId('card-2')).toBeInTheDocument()
    document.querySelectorAll('svg').forEach((icon) => expect(icon).toHaveAttribute('aria-hidden', 'true'))
  })

  it('renders skeleton placeholders while loading, with no cards', () => {
    render(<SponsoredShelf items={null} loading renderItem={renderItem} />)
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByTestId('merch-sponsored-grid')).not.toBeInTheDocument()
    expect(screen.queryAllByTestId('merch-sponsored-disclosure')).toHaveLength(0)
  })

  it('renders a safe empty state on error without any sponsored item (no undisclosed card)', () => {
    render(<SponsoredShelf items={items} error renderItem={renderItem} />)
    expect(screen.getByText('推广内容暂不可用，请稍后再试')).toBeInTheDocument()
    expect(screen.queryAllByTestId('merch-sponsored-disclosure')).toHaveLength(0)
    expect(screen.queryByTestId('card-1')).not.toBeInTheDocument()
  })

  it('renders a safe empty state when there is no sponsored data', () => {
    render(<SponsoredShelf items={[]} renderItem={renderItem} />)
    expect(screen.getByText('暂无推广内容')).toBeInTheDocument()
    expect(screen.queryAllByTestId('merch-sponsored-disclosure')).toHaveLength(0)
  })

  it('renders null/undefined items as safe empty state', () => {
    render(<SponsoredShelf items={null} renderItem={renderItem} />)
    expect(screen.getByText('暂无推广内容')).toBeInTheDocument()
  })

  it('is keyboard/screen-reader accessible (labelled region, no axe violations)', async () => {
    const { container } = render(<SponsoredShelf items={items} renderItem={renderItem} title="推广位" />)
    const region = screen.getByLabelText('推广内容')
    expect(region).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '推广位' })).toBeInTheDocument()
    expect(await axe(container, { rules: { 'color-contrast': { enabled: false } } })).toHaveNoViolations()
  })
})
