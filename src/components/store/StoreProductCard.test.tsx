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

  it('derives xboard faka availability from the remaining quota', () => {
    const { container: soldOut } = render(
      <StoreProductCard
        product={makeProduct({
          id: 7,
          fakaCapacity: { remaining: 0, capacityLimit: 10, sellable: true, source: 'xboard' },
        })}
        onOpen={vi.fn()}
      />,
    )
    expect(screen.getByTestId('store-stock-7').textContent).toBe('剩余名额 0/10')
    expect(soldOut.firstChild).toHaveClass('opacity-60', 'grayscale')

    const { container: available } = render(
      <StoreProductCard
        product={makeProduct({
          id: 8,
          fakaCapacity: { remaining: 3, capacityLimit: 10, sellable: true, source: 'xboard' },
        })}
        onOpen={vi.fn()}
      />,
    )
    expect(screen.getByTestId('store-stock-8').textContent).toBe('剩余名额 3/10')
    expect(available.firstChild).not.toHaveClass('opacity-60')

    // Xboard reports a quota left but marks the offer unsellable: the card must
    // still render as sold out (the sellable flag outranks the remaining count).
    const { container: unsellable } = render(
      <StoreProductCard
        product={makeProduct({
          id: 10,
          fakaCapacity: { remaining: 5, capacityLimit: 10, sellable: false, source: 'xboard' },
        })}
        onOpen={vi.fn()}
      />,
    )
    expect(unsellable.firstChild).toHaveClass('opacity-60', 'grayscale')

    // No quota reported at all -> 不限, and an absent capacityLimit must not
    // render as "null".
    render(
      <StoreProductCard
        product={makeProduct({
          id: 11,
          fakaCapacity: { remaining: null, capacityLimit: null, sellable: true, source: 'xboard' },
        })}
        onOpen={vi.fn()}
      />,
    )
    expect(screen.getByTestId('store-stock-11').textContent).toBe('剩余名额 不限')
  })

  it('falls back to stock/stockMode when faka is unavailable', () => {
    render(
      <StoreProductCard product={makeProduct({ id: 9, stock: 0, stockMode: 'limited' })} onOpen={vi.fn()} />,
    )
    expect(screen.getByTestId('store-stock-9').textContent).toBe('库存 0')
  })
})
