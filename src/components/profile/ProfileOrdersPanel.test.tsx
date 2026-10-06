import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ProfileOrdersPanel, { type OrderFilter } from './ProfileOrdersPanel'
import type { UserOrderListItem } from '../../types/order'

function makeOrder(id: number, status: string, name: string): UserOrderListItem {
  return {
    id,
    price: 100 + id,
    status,
    deliveryMode: 'auto',
    createdAt: '2025-01-01T00:00:00.000Z',
    merchant: { id: 1, name: '测试商家' },
    product: {
      id,
      name,
      type: 'card',
      icon: 'box',
      imageUrl: null,
      deliveryMode: 'auto',
    },
    delivery: null,
  }
}

const orders: UserOrderListItem[] = [
  makeOrder(1, 'completed', '已交付商品'),
  makeOrder(2, 'pending', '待履约商品'),
]

const baseProps = {
  orders,
  listsLoading: false,
  loadingOrderId: null as number | null,
  onOpenOrderDetail: () => {},
}

describe('ProfileOrdersPanel', () => {
  it('keeps the filter selection in the parent so it survives a remount', () => {
    const onOrderFilterChange = vi.fn()

    // 受控组件：父层持有 orderFilter，模拟「切换 Tab 后回来」的卸载/重挂载。
    function Harness() {
      const [filter, setFilter] = useState<OrderFilter>('all')
      const [mounted, setMounted] = useState(true)
      return (
        <>
          <button type="button" onClick={() => setMounted((v) => !v)}>
            切换标签
          </button>
          {mounted && (
            <ProfileOrdersPanel
              {...baseProps}
              orderFilter={filter}
              onOrderFilterChange={(next) => {
                onOrderFilterChange(next)
                setFilter(next)
              }}
            />
          )}
        </>
      )
    }

    render(
      <MemoryRouter>
        <Harness />
      </MemoryRouter>
    )

    expect(screen.getByText('已交付商品')).toBeInTheDocument()
    expect(screen.getByText('待履约商品')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '已交付 (1)' }))
    expect(onOrderFilterChange).toHaveBeenCalledWith('completed')
    expect(screen.getByText('已交付商品')).toBeInTheDocument()
    expect(screen.queryByText('待履约商品')).not.toBeInTheDocument()

    // 卸载再挂载后筛选值仍由父层提供，列表保持过滤结果。
    fireEvent.click(screen.getByRole('button', { name: '切换标签' }))
    expect(screen.queryByTestId('profile-orders-entry')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '切换标签' }))
    expect(screen.getByText('已交付商品')).toBeInTheDocument()
    expect(screen.queryByText('待履约商品')).not.toBeInTheDocument()
  })

  it('routes each order to the detail callback and disables the row being loaded', () => {
    const onOpenOrderDetail = vi.fn()
    render(
      <MemoryRouter>
        <ProfileOrdersPanel
          {...baseProps}
          orderFilter="all"
          onOrderFilterChange={() => {}}
          loadingOrderId={2}
          onOpenOrderDetail={onOpenOrderDetail}
        />
      </MemoryRouter>
    )

    const buttons = screen.getAllByRole('button', { name: /查看发货内容/ })
    expect(buttons).toHaveLength(2)
    expect(buttons[1]).toBeDisabled()

    fireEvent.click(buttons[0])
    expect(onOpenOrderDetail).toHaveBeenCalledWith(1)
    expect(onOpenOrderDetail).toHaveBeenCalledTimes(1)
  })
})
