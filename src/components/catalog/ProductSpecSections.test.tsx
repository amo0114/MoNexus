import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ProductSpecSections, {
  mergeProductOfferAttributes,
  listVisibleSpecSections,
} from './ProductSpecSections'
import { EMPTY_PRODUCT_DETAILS } from '../../types/catalog'

describe('mergeProductOfferAttributes', () => {
  it('annotates same-named keys with 商品 / 套餐 source labels', () => {
    const rows = mergeProductOfferAttributes(
      { region: '全球', serviceName: 'Steam' },
      { region: '美区', unitLabel: '月卡' },
      {
        productOrder: ['serviceName', 'region'],
        offerOrder: ['unitLabel', 'region'],
        titles: { region: '适用地区', serviceName: '适用产品', unitLabel: '销售单位' },
      },
    )

    expect(rows).toEqual([
      { key: 'serviceName', label: '适用产品', value: 'Steam', source: null },
      { key: 'region', label: '适用地区', value: '全球', source: 'product' },
      { key: 'region', label: '适用地区', value: '美区', source: 'offer' },
      { key: 'unitLabel', label: '销售单位', value: '月卡', source: null },
    ])
  })

  it('falls back to the attribute key when no registry title exists', () => {
    const rows = mergeProductOfferAttributes({ customField: '值' }, {})
    expect(rows).toEqual([{ key: 'customField', label: 'customField', value: '值', source: null }])
  })

  it('skips empty strings and empty arrays', () => {
    const rows = mergeProductOfferAttributes(
      { serviceName: 'Steam', region: '', tags: [] },
      { unitLabel: '' },
    )
    expect(rows).toEqual([{ key: 'serviceName', label: 'serviceName', value: 'Steam', source: null }])
  })
})

describe('ProductSpecSections', () => {
  it('renders overlapping keys with 商品 / 套餐 labels and skips empty optional blocks', () => {
    render(
      <ProductSpecSections
        productAttributes={{ region: '全球', serviceName: 'Steam' }}
        offerAttributes={{ region: '美区', unitLabel: '月卡' }}
        productOrder={['serviceName', 'region']}
        offerOrder={['unitLabel', 'region']}
        titles={{ region: '适用地区', serviceName: '适用产品', unitLabel: '销售单位' }}
        details={{
          ...EMPTY_PRODUCT_DETAILS,
          purchaseNotes: '确认适用地区后再兑换。',
          faq: [{ question: '', answer: '' }],
        }}
      />,
    )

    const rows = screen.getAllByTestId('product-spec-row')
    expect(rows).toHaveLength(4)
    expect(rows[1]).toHaveAttribute('data-key', 'region')
    expect(rows[1]).toHaveAttribute('data-source', 'product')
    expect(rows[1]).toHaveTextContent('商品')
    expect(rows[2]).toHaveAttribute('data-source', 'offer')
    expect(rows[2]).toHaveTextContent('套餐')
    expect(screen.getByTestId('product-section-purchase-notes')).toHaveTextContent('确认适用地区后再兑换。')
    expect(screen.queryByTestId('product-section-usage')).not.toBeInTheDocument()
    expect(screen.queryByTestId('product-section-after-sales')).not.toBeInTheDocument()
    expect(screen.queryByTestId('product-section-faq')).not.toBeInTheDocument()
  })

  it('lists only sections that have content', () => {
    const specRows = mergeProductOfferAttributes({ serviceName: 'Steam' }, {})
    expect(
      listVisibleSpecSections({
        specRows,
        details: EMPTY_PRODUCT_DETAILS,
        assurance: null,
      }),
    ).toEqual([{ id: 'product-section-parameters', label: '参数' }])
  })
})
