import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { EMPTY_PRODUCT_DETAILS, type ProductDetails } from '../../types/catalog'
import ProductDetailsFields from './ProductDetailsFields'

const FILLED_DETAILS: ProductDetails = {
  highlights: ['参数清晰', '订单内交付'],
  usageInstructions: '兑换后在订单详情查看。',
  purchaseNotes: '兑换前请确认适用地区。',
  afterSalesInstructions: '订单问题请提交售后工单。',
  faq: [{ question: '如何兑换？', answer: '在订单页查看卡密。' }],
}

function Harness({
  initial = EMPTY_PRODUCT_DETAILS,
  mode = 'draft',
  onChange,
}: {
  initial?: ProductDetails
  mode?: 'draft' | 'publish'
  onChange?: (next: ProductDetails) => void
}) {
  const [value, setValue] = useState<ProductDetails>(initial)
  return (
    <ProductDetailsFields
      value={value}
      mode={mode}
      onChange={(next) => {
        setValue(next)
        onChange?.(next)
      }}
    />
  )
}

describe('ProductDetailsFields', () => {
  it('renders the empty ProductDetails baseline', () => {
    render(<ProductDetailsFields value={EMPTY_PRODUCT_DETAILS} onChange={vi.fn()} />)

    expect(screen.getByTestId('product-details-fields')).toHaveAttribute('data-mode', 'draft')
    expect(screen.getByTestId('product-details-usageInstructions')).toHaveValue('')
    expect(screen.getByTestId('product-details-purchaseNotes')).toHaveValue('')
    expect(screen.getByTestId('product-details-afterSalesInstructions')).toHaveValue('')
    expect(screen.queryByTestId('product-details-highlight-0')).not.toBeInTheDocument()
    expect(screen.queryByTestId('product-details-faq-0')).not.toBeInTheDocument()
    expect(screen.queryByTestId('product-details-purchaseNotes-required-hint')).not.toBeInTheDocument()
  })

  it('loads filled details into every control', () => {
    render(<ProductDetailsFields value={FILLED_DETAILS} onChange={vi.fn()} />)

    expect(screen.getByTestId('product-details-highlight-0')).toHaveValue('参数清晰')
    expect(screen.getByTestId('product-details-highlight-1')).toHaveValue('订单内交付')
    expect(screen.getByTestId('product-details-usageInstructions')).toHaveValue('兑换后在订单详情查看。')
    expect(screen.getByTestId('product-details-purchaseNotes')).toHaveValue('兑换前请确认适用地区。')
    expect(screen.getByTestId('product-details-afterSalesInstructions')).toHaveValue('订单问题请提交售后工单。')
    expect(screen.getByTestId('product-details-faq-question-0')).toHaveValue('如何兑换？')
    expect(screen.getByTestId('product-details-faq-answer-0')).toHaveValue('在订单页查看卡密。')
  })

  it('keeps a complete ProductDetails object and allows empty strings in draft', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    fireEvent.change(screen.getByTestId('product-details-usageInstructions'), { target: { value: '说明' } })
    fireEvent.change(screen.getByTestId('product-details-usageInstructions'), { target: { value: '' } })
    fireEvent.change(screen.getByTestId('product-details-purchaseNotes'), { target: { value: '' } })

    const last = onChange.mock.calls.at(-1)?.[0] as ProductDetails
    expect(last).toEqual(EMPTY_PRODUCT_DETAILS)
    expect(Object.keys(last).sort()).toEqual(
      ['afterSalesInstructions', 'faq', 'highlights', 'purchaseNotes', 'usageInstructions'].sort(),
    )
  })

  it('adds and removes highlights, omitting empty strings', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    fireEvent.click(screen.getByTestId('product-details-highlight-add'))
    fireEvent.change(screen.getByTestId('product-details-highlight-blank-0'), { target: { value: '支持售后' } })
    expect(onChange).toHaveBeenLastCalledWith({
      ...EMPTY_PRODUCT_DETAILS,
      highlights: ['支持售后'],
    })

    fireEvent.change(screen.getByTestId('product-details-highlight-0'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith(EMPTY_PRODUCT_DETAILS)
  })

  it('adds and removes FAQ rows, keeping empty strings in draft', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    fireEvent.click(screen.getByTestId('product-details-faq-add'))
    expect(onChange).toHaveBeenLastCalledWith({
      ...EMPTY_PRODUCT_DETAILS,
      faq: [{ question: '', answer: '' }],
    })

    fireEvent.change(screen.getByTestId('product-details-faq-question-0'), { target: { value: '有效期？' } })
    fireEvent.change(screen.getByTestId('product-details-faq-answer-0'), { target: { value: '以商品说明为准。' } })
    expect(onChange).toHaveBeenLastCalledWith({
      ...EMPTY_PRODUCT_DETAILS,
      faq: [{ question: '有效期？', answer: '以商品说明为准。' }],
    })

    fireEvent.click(screen.getByTestId('product-details-faq-remove-0'))
    expect(onChange).toHaveBeenLastCalledWith(EMPTY_PRODUCT_DETAILS)
  })

  it('shows first-publish required hints without blocking draft empty strings', () => {
    const { rerender } = render(
      <ProductDetailsFields value={EMPTY_PRODUCT_DETAILS} onChange={vi.fn()} mode="draft" />,
    )
    expect(screen.queryByTestId('product-details-purchaseNotes-required-hint')).not.toBeInTheDocument()
    expect(screen.queryByTestId('product-details-afterSalesInstructions-required-hint')).not.toBeInTheDocument()

    rerender(<ProductDetailsFields value={EMPTY_PRODUCT_DETAILS} onChange={vi.fn()} mode="publish" />)
    expect(screen.getByTestId('product-details-purchaseNotes-required-hint')).toHaveTextContent('首次发布必填')
    expect(screen.getByTestId('product-details-afterSalesInstructions-required-hint')).toHaveTextContent('首次发布必填')
    expect(screen.getByLabelText(/购买须知/)).toHaveValue('')
    expect(screen.getByLabelText(/售后说明/)).toHaveValue('')
  })
})
