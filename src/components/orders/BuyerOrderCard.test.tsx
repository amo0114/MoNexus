import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import BuyerOrderCard from './BuyerOrderCard'
import type { UserOrderListItem } from '../../types/order'

const BASE_ORDER: UserOrderListItem = {
  id: 101,
  price: 50,
  status: 'delivered',
  deliveryMode: 'instant_fixed',
  createdAt: '2026-10-05T12:30:00.000Z',
  merchant: { id: 1, name: '优质服务商' },
  product: {
    id: 10,
    name: 'ChatGPT Plus 会员 30天独享账号',
    type: '网络节点',
    icon: 'box',
    imageUrl: 'https://example.com/chatgpt.png',
    deliveryMode: 'instant_fixed',
  },
  delivery: {
    status: 'delivered',
  },
}

describe('BuyerOrderCard', () => {
  it('renders order metadata, thumbnail, status pill, price and view button', () => {
    const onOpen = vi.fn()
    render(<BuyerOrderCard order={BASE_ORDER} onOpen={onOpen} />)

    // Status pill
    const statusWrapper = screen.getByTestId('buyer-order-status-101')
    expect(statusWrapper).toHaveAttribute('data-order-status', 'delivered')

    // Order ID
    expect(screen.getByText('#101')).toBeInTheDocument()

    // Price
    expect(screen.getByText(/50/)).toBeInTheDocument()

    // Product Title
    expect(screen.getByText('ChatGPT Plus 会员 30天独享账号')).toBeInTheDocument()

    // Merchant name
    expect(screen.getByText('优质服务商')).toBeInTheDocument()

    // Thumbnail image
    const img = screen.getByRole('img', { name: 'ChatGPT Plus 会员 30天独享账号' })
    expect(img).toHaveAttribute('src', 'https://example.com/chatgpt.png')

    // Open detail button
    const button = screen.getByRole('button', { name: '查看订单详情' })
    expect(button).toHaveAttribute('data-testid', 'open-order-detail-101')

    // Clicking button triggers onOpen with order.id
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledWith(101)
  })

  it('renders expired tag when order is expired', () => {
    const expiredOrder: UserOrderListItem = {
      ...BASE_ORDER,
      id: 102,
      expiresAt: '2020-01-01T00:00:00.000Z',
    }
    render(<BuyerOrderCard order={expiredOrder} onOpen={vi.fn()} />)
    expect(screen.getByTestId('order-expired-tag-102')).toHaveTextContent('已过期')
  })

  it('renders booking tag when bookingDate is set', () => {
    const bookingOrder: UserOrderListItem = {
      ...BASE_ORDER,
      id: 103,
      bookingDate: '2026-10-15',
    }
    render(<BuyerOrderCard order={bookingOrder} onOpen={vi.fn()} />)
    const bookingTag = screen.getByTestId('order-booking-tag-103')
    expect(bookingTag).toHaveTextContent(/预约 2026-10-15/)
  })

  it('renders offer snapshot if not 默认规格', () => {
    const skuOrder: UserOrderListItem = {
      ...BASE_ORDER,
      id: 104,
      offerNameSnapshot: '年卡高级版',
    }
    render(<BuyerOrderCard order={skuOrder} onOpen={vi.fn()} />)
    expect(screen.getByText('年卡高级版')).toBeInTheDocument()
  })

  it('clicking card opens detail', () => {
    const onOpen = vi.fn()
    render(<BuyerOrderCard order={BASE_ORDER} onOpen={onOpen} />)
    const card = screen.getByTestId('buyer-order-card-101')
    fireEvent.click(card)
    expect(onOpen).toHaveBeenCalledWith(101)
  })
})
