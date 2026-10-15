// StoreProductCard boundary tests (R10 extraction).
//
// The card is a verbatim move out of StorePage, so existing StorePage suites
// already cover its rendering, badges, disclosure and aria-label. Two things
// the extraction does expose and the page suites do NOT cover:
//   1. the `onOpen(product)` contract reached straight from the card root
//      (previously only exercised by e2e/store-pagination.spec.ts);
//   2. the card-exclusive faka/stock derivation that moved with it.

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import type { Product } from './types'
import StoreProductCard from './StoreProductCard'

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 1,
    name: '网络节点旗舰A',
    description: '节点描述',
    type: '充值卡密',
    icon: '',
    imageUrl: 'https://example.test/1.png',
    price: 100,
    stock: 5,
    sales: 7,
    ...overrides,
  }
}

describe('StoreProductCard', () => {
  it('opens the clicked product through onOpen exactly once', () => {
    const product = makeProduct({ id: 42, name: '目标商品' })
    const onOpen = vi.fn()
    render(<StoreProductCard product={product} onOpen={onOpen} />)

    fireEvent.click(screen.getByTestId('store-product-card-42'))

    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith(product)
  })

  const xboard = { remaining: 3, capacityLimit: 10, sellable: true, source: 'xboard' as const }

  it.each([
    ['available local product keeps its stock label', { availability: { status: 'available' as const }, stock: 5 }, '库存 5', false],
    ['available unlimited local product', { availability: { status: 'available' as const }, stockMode: 'unlimited' }, '库存 不限', false],
    ['available Faka product defers quota to the detail page', { availability: { status: 'available' as const }, fakaCapacity: xboard }, '查看套餐', false],
    ['unavailable product, even with a positive representative quota', { availability: { status: 'unavailable' as const }, fakaCapacity: xboard }, '暂不可售', true],
    ['unknown capacity is neither sold out nor a number', { availability: { status: 'unknown' as const }, stock: 0, fakaCapacity: { ...xboard, source: 'unavailable' as const, remaining: null } }, '状态待确认', false],
  ])('%s', (_label, overrides, text, greyed) => {
    const onOpen = vi.fn()
    const { container } = render(<StoreProductCard product={makeProduct({ id: 20, ...overrides })} onOpen={onOpen} />)
    expect(screen.getByTestId('store-stock-20').textContent).toBe(text)
    if (greyed) expect(container.firstChild).toHaveClass('opacity-60', 'grayscale')
    else expect(container.firstChild).not.toHaveClass('opacity-60')
    fireEvent.click(screen.getByTestId('store-product-card-20'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('falls back to legacy stock/Faka fields only when availability is absent', () => {
    render(
      <StoreProductCard
        product={makeProduct({ id: 21, fakaCapacity: { remaining: 5, capacityLimit: 10, sellable: false, source: 'xboard' } })}
        onOpen={vi.fn()}
      />,
    )
    expect(screen.getByTestId('store-stock-21').textContent).toBe('暂不可售')
  })

  it('renders a real link without nesting the partner button when href is given', () => {
    render(
      <MemoryRouter>
        <StoreProductCard
          product={makeProduct({
            id: 12,
            name: '推荐商品',
            merchandising: {
              rankingRunId: null,
              hot: null,
              platformOwned: false,
              platformPick: null,
              merchantPartner: { label: '平台合作伙伴', validUntil: '2999-01-01T00:00:00.000Z' },
            },
          })}
          href="/product/12"
          sellerLabel="同店"
        />
      </MemoryRouter>,
    )

    const link = screen.getByRole('link', { name: '推荐商品' })
    expect(link).toHaveAttribute('href', '/product/12')
    const partner = screen.getByRole('button', { name: /平台合作伙伴/ })
    expect(link.contains(partner)).toBe(false)
    expect(partner.closest('a')).toBeNull()
    const sellerChip = screen.getByText('同店').parentElement
    expect(sellerChip).toHaveClass('flex')
    expect(sellerChip).not.toHaveClass('hidden')
  })

  it('compact cards keep the real link and availability text but drop the seller chip and rating', () => {
    const { container } = render(
      <MemoryRouter>
        <StoreProductCard
          product={makeProduct({ id: 30, name: '店内商品', merchant: { id: 5, name: '某店' }, availability: { status: 'unknown' } })}
          href="/product/30"
          compact
        />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: '店内商品' })).toHaveAttribute('href', '/product/30')
    expect(screen.getByTestId('store-stock-30').textContent).toBe('状态待确认')
    expect(screen.queryByText('某店')).toBeNull()
    expect(screen.queryByText('暂无评分')).toBeNull()
    expect(screen.queryByText('节点描述')).toBeNull()
    expect(container.firstChild).toHaveClass('h-full')
    expect(container.firstChild).not.toHaveClass('h-[256px]')
  })
})
