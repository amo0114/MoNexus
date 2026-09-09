import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import DeliveryContent, {
  type DeliveryContentProps,
} from './DeliveryContent'
import type { StructuredDeliveryContent } from '../types/merchant'

const ACCOUNT_FIELDS: StructuredDeliveryContent = {
  fields: [
    { key: 'account', label: '账号', sensitive: false },
    { key: 'password', label: '密码', sensitive: true },
  ],
  values: {
    account: 'alice@example.com',
    password: 's3cret',
  },
}

describe('DeliveryContent', () => {
  it('lets structured fields win over raw text', () => {
    render(
      <DeliveryContent
        content="RAW-TEXT-SHOULD-HIDE"
        contentType="text"
        structuredContent={ACCOUNT_FIELDS}
      />,
    )

    expect(screen.getByTestId('structured-delivery')).toBeInTheDocument()
    expect(screen.getByTestId('structured-field-account')).toHaveTextContent('alice@example.com')
    expect(screen.queryByText('RAW-TEXT-SHOULD-HIDE')).not.toBeInTheDocument()
  })

  it('renders the file card when file metadata is present', () => {
    render(
      <DeliveryContent
        orderId={42}
        file={{ fileName: '交付包.zip', size: 2048 }}
        content="optional-caption"
        contentType="text"
      />,
    )

    const card = screen.getByTestId('file-delivery-card')
    expect(card).toBeInTheDocument()
    expect(card).toHaveTextContent('交付包.zip')
  })

  it('does not accept or render current product attributes', () => {
    type AssertNever<T extends never> = T
    type NoProductFields = AssertNever<
      Extract<keyof DeliveryContentProps, 'product' | 'attributes' | 'fixedContent' | 'deliveryMode'>
    >
    const _typeCheck: NoProductFields | null = null
    expect(_typeCheck).toBeNull()

    const leaked = {
      content: 'ORDER-SECRET',
      contentType: 'text' as const,
      product: { fixedContent: 'PRODUCT-LEAK', attributes: { password: 'ATTR-LEAK' } },
      attributes: { code: 'ATTR-LEAK' },
      fixedContent: 'PRODUCT-LEAK',
      deliveryMode: 'instant_fixed',
    }
    render(<DeliveryContent {...(leaked as DeliveryContentProps)} />)

    expect(screen.getByText('ORDER-SECRET')).toBeInTheDocument()
    expect(screen.queryByText('PRODUCT-LEAK')).not.toBeInTheDocument()
    expect(screen.queryByText('ATTR-LEAK')).not.toBeInTheDocument()
  })

  it('labels bookingDate as 期望服务日期', () => {
    render(<DeliveryContent bookingDate="2026-08-01T00:00:00.000Z" />)

    const row = screen.getByTestId('order-booking-date')
    expect(row).toHaveTextContent('期望服务日期')
    expect(row).toHaveTextContent('2026-08-01')
    expect(screen.queryByText(/核销|二维码|时段|slot/i)).not.toBeInTheDocument()
  })

  it('does not invent expiry copy when expiresAt is missing', () => {
    render(<DeliveryContent content="card-01" contentType="text" />)

    expect(screen.queryByTestId('subscription-expiry')).not.toBeInTheDocument()
    expect(screen.queryByText(/有效期/)).not.toBeInTheDocument()
  })
})
