// Component tests for EditorialShelf (T-MERCH-FE-001).
// AC-MERCH-018 (independent 平台精选 shelf/label), publicReason display,
// safe loading/error/empty states, and a11y.

import { render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import { describe, expect, it } from 'vitest'
import { DISPLAY_LABEL } from '../../types/merchandising'
import EditorialShelf, { type EditorialShelfItem } from './EditorialShelf'

const items: EditorialShelfItem[] = [
  { id: 11, platformPick: { label: '平台精选', publicReason: '本周上新' } },
  { id: 12, platformPick: { label: '平台精选', publicReason: null } },
]

function renderItem(item: EditorialShelfItem) {
  return <div data-testid={`editorial-card-${item.id}`}>精选商品 {item.id}</div>
}

describe('EditorialShelf', () => {
  it('renders an independent shelf with the frozen 平台精选 label (AC-MERCH-018)', () => {
    render(<EditorialShelf items={items} renderItem={renderItem} />)
    expect(screen.getByRole('heading', { name: DISPLAY_LABEL.PLATFORM_PICK })).toBeInTheDocument()
    expect(screen.getByLabelText(DISPLAY_LABEL.PLATFORM_PICK)).toBeInTheDocument()
  })

  it('renders host card content and the optional publicReason', () => {
    render(<EditorialShelf items={items} renderItem={renderItem} />)
    expect(screen.getByTestId('editorial-card-11')).toBeInTheDocument()
    expect(screen.getByTestId('editorial-card-12')).toBeInTheDocument()
    expect(screen.getByText('本周上新')).toBeInTheDocument()
  })

  it('does not render a publicReason caption when it is null', () => {
    render(<EditorialShelf items={[items[1]]} renderItem={renderItem} />)
    expect(screen.queryByText('本周上新')).not.toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('renders skeleton placeholders while loading', () => {
    render(<EditorialShelf items={null} loading renderItem={renderItem} />)
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByTestId('merch-editorial-grid')).not.toBeInTheDocument()
  })

  it('renders safe empty states for error and no data', () => {
    const { unmount } = render(<EditorialShelf items={items} error renderItem={renderItem} />)
    expect(screen.getByText('精选内容暂不可用，请稍后再试')).toBeInTheDocument()
    expect(screen.queryAllByTestId(/editorial-card/)).toHaveLength(0)
    unmount()
    render(<EditorialShelf items={[]} renderItem={renderItem} />)
    expect(screen.getByText('暂无精选内容')).toBeInTheDocument()
  })

  it('is accessible with no axe violations', async () => {
    const { container } = render(<EditorialShelf items={items} renderItem={renderItem} />)
    expect(await axe(container, { rules: { 'color-contrast': { enabled: false } } })).toHaveNoViolations()
  })
})
