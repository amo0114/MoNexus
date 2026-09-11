import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import ProductOfferSelector, { type OfferItem } from './ProductOfferSelector'

const mockOffers: OfferItem[] = [
  {
    id: 101,
    productId: 1,
    name: '标准包 · 50M Tokens',
    price: 199,
    originalPrice: 299,
    stock: 100,
    stockMode: 'standard',
    sortOrder: 0,
    validityDays: 90,
  },
  {
    id: 102,
    productId: 1,
    name: '高通量包 · 200M Tokens',
    price: 699,
    stock: 3,
    stockMode: 'standard',
    sortOrder: 1,
    validityDays: 180,
  },
  {
    id: 103,
    productId: 1,
    name: '售罄测试包',
    price: 99,
    stock: 0,
    stockMode: 'standard',
    sortOrder: 2,
    validityDays: 30,
  },
]

describe('ProductOfferSelector', () => {
  it('renders all offers with pricing and validity info', () => {
    const handleSelect = vi.fn()
    render(
      <ProductOfferSelector
        offers={mockOffers}
        selectedOfferId={101}
        onSelectOffer={handleSelect}
      />
    )

    expect(screen.getByTestId('sku-selector')).toBeDefined()
    expect(screen.getByText('标准包 · 50M Tokens')).toBeDefined()
    expect(screen.getByText('高通量包 · 200M Tokens')).toBeDefined()
    expect(screen.getByText('199')).toBeDefined()
    expect(screen.getByText('699')).toBeDefined()
    expect(screen.getByText('299 积分')).toBeDefined() // Strikethrough original price
    expect(screen.getByText('单单限购 1 个单位')).toBeDefined()
  })

  it('marks selected offer with aria-pressed=true and checkmark', () => {
    const handleSelect = vi.fn()
    render(
      <ProductOfferSelector
        offers={mockOffers}
        selectedOfferId={101}
        onSelectOffer={handleSelect}
      />
    )

    const option101 = screen.getByTestId('sku-option-101')
    const option102 = screen.getByTestId('sku-option-102')

    expect(option101.getAttribute('aria-pressed')).toBe('true')
    expect(option102.getAttribute('aria-pressed')).toBe('false')
  })

  it('calls onSelectOffer when an available offer is clicked without opening any modal', () => {
    const handleSelect = vi.fn()
    render(
      <ProductOfferSelector
        offers={mockOffers}
        selectedOfferId={101}
        onSelectOffer={handleSelect}
      />
    )

    fireEvent.click(screen.getByTestId('sku-option-102'))
    expect(handleSelect).toHaveBeenCalledWith(102)
  })

  it('disables sold out offer and prevents selection', () => {
    const handleSelect = vi.fn()
    render(
      <ProductOfferSelector
        offers={mockOffers}
        selectedOfferId={101}
        onSelectOffer={handleSelect}
      />
    )

    const soldOutOption = screen.getByTestId('sku-option-103')
    expect(soldOutOption.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('已售罄')).toBeDefined()

    fireEvent.click(soldOutOption)
    expect(handleSelect).not.toHaveBeenCalled()
  })

  it('displays low stock badge for items with stock <= 5', () => {
    render(
      <ProductOfferSelector
        offers={mockOffers}
        selectedOfferId={101}
        onSelectOffer={vi.fn()}
      />
    )

    expect(screen.getByText('仅剩 3 件')).toBeDefined()
  })

  it('strictly contains no quantity stepper elements', () => {
    const { container } = render(
      <ProductOfferSelector
        offers={mockOffers}
        selectedOfferId={101}
        onSelectOffer={vi.fn()}
      />
    )

    // Verify there are no quantity inputs, plus/minus buttons
    expect(container.querySelector('input[type="number"]')).toBeNull()
    expect(screen.queryByLabelText(/增加/)).toBeNull()
    expect(screen.queryByLabelText(/减少/)).toBeNull()
  })
})
