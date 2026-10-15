import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ProductExchangeSummary from './ProductExchangeSummary'

describe('ProductExchangeSummary', () => {
  it('shows the pending status instead of inferring 库存不限 from an unknown external offer', () => {
    render(
      <ProductExchangeSummary
        offer={{ id: 1, name: '外部月付', price: 100, deliveryMode: 'manual_service', stockMode: 'unlimited', stock: 0 }}
        stockTitle="可售状态"
        stockLabel="待确认"
      />,
    )
    expect(screen.getByText('可售状态：待确认')).toBeInTheDocument()
    expect(screen.queryByText('库存不限')).toBeNull()
  })
})
