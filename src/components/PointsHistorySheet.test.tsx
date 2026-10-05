import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import PointsHistorySheet, { type PointsHistoryItem } from './PointsHistorySheet'

const history: PointsHistoryItem[] = [
  { id: 2, orderId: 42, type: 'out', amount: 200, balanceAfter: 800, reason: 'Xboard 开通成功扣款', createdAt: '2026-10-02T10:01:00Z' },
  { id: 1, orderId: 42, type: 'hold', amount: 200, balanceAfter: 800, reason: '下单冻结', createdAt: '2026-10-02T10:00:00Z' },
]

function OrderDestination() {
  const location = useLocation()
  return <p data-testid="order-destination">{location.pathname}{location.search}</p>
}

describe('points history event semantics', () => {
  it('keeps hold and out as separate historical events and links to the actual order state', () => {
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<PointsHistorySheet open loading={false} items={history} onOpenChange={vi.fn()} />} />
          <Route path="/orders" element={<OrderDestination />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(within(screen.getByTestId('points-history-row-1')).getByText('积分冻结')).toBeInTheDocument()
    expect(within(screen.getByTestId('points-history-row-2')).getByText('支付扣款')).toBeInTheDocument()
    expect(screen.queryByText('待支付')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('points-history-row-1'))
    expect(screen.getByTestId('points-history-detail')).toHaveTextContent('这是下单时的历史冻结记录')
    fireEvent.click(screen.getByTestId('points-history-open-order'))
    expect(screen.getByTestId('order-destination')).toHaveTextContent('/orders?focus=42')
  })
})
