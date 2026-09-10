import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import DeliveryContent, {
  type DeliveryContentProps,
} from './DeliveryContent'
import type { StructuredDeliveryContent } from '../types/merchant'
import { useAppStore } from '../stores/appStore'

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
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [] })
  })

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

  it('renders the file card when file metadata is present and passes orderStatus', () => {
    render(
      <DeliveryContent
        orderId={42}
        orderStatus="delivered"
        file={{ fileName: '交付包.zip', size: 2048 }}
        content="optional-caption"
        contentType="text"
      />,
    )

    const card = screen.getByTestId('file-delivery-card')
    expect(card).toBeInTheDocument()
    expect(card).toHaveTextContent('交付包.zip')
    expect(screen.getByTestId('file-delivery-download')).toBeEnabled()
  })

  it('disables file download button when orderStatus is disputed or refunded', () => {
    const { rerender } = render(
      <DeliveryContent
        orderId={42}
        orderStatus="disputed"
        file={{ fileName: '交付包.zip', size: 2048 }}
      />,
    )

    expect(screen.getByTestId('file-delivery-download')).toBeDisabled()
    expect(screen.getByTestId('file-delivery-disputed-notice')).toHaveTextContent('争议处理中，文件下载已暂停')

    rerender(
      <DeliveryContent
        orderId={42}
        orderStatus="refunded"
        file={{ fileName: '交付包.zip', size: 2048 }}
      />,
    )

    expect(screen.getByTestId('file-delivery-download')).toBeDisabled()
    expect(screen.getByTestId('file-delivery-refunded-notice')).toHaveTextContent('订单已全额退款，文件下载授权已关闭')
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

  it('accurately formats subscription expiry without misleading storage text', () => {
    const { rerender } = render(
      <DeliveryContent
        content="sub-key"
        expiresAt="2026-12-31T23:59:59.000Z"
        expired={false}
        isSubscription={true}
      />,
    )

    const expiryRow = screen.getByTestId('subscription-expiry')
    expect(expiryRow).toHaveTextContent(/订阅有效期至/)
    expect(screen.queryByText(/超过安全存储期/)).not.toBeInTheDocument()

    // Expired state
    rerender(
      <DeliveryContent
        content="sub-key"
        expiresAt="2026-12-31T23:59:59.000Z"
        expired={true}
        isSubscription={true}
      />,
    )

    expect(screen.getByTestId('subscription-expired-badge')).toHaveTextContent('已过期')
    expect(screen.getByTestId('subscription-expiry')).toHaveTextContent(/订阅已于.*到期/)
    expect(screen.queryByText(/超过安全存储期/)).not.toBeInTheDocument()
  })

  it('accurately formats non-subscription expiry (voucher/account) without subscription wording', () => {
    const { rerender } = render(
      <DeliveryContent
        content="card-pin"
        expiresAt="2026-12-31T23:59:59.000Z"
        expired={false}
        isSubscription={false}
      />,
    )

    expect(screen.getByTestId('subscription-expiry')).toHaveTextContent(/^有效期至/)
    expect(screen.queryByText(/订阅有效期/)).not.toBeInTheDocument()

    // Expired state
    rerender(
      <DeliveryContent
        content="card-pin"
        expiresAt="2026-12-31T23:59:59.000Z"
        expired={true}
        isSubscription={false}
      />,
    )

    expect(screen.getByTestId('subscription-expired-badge')).toHaveTextContent('已过期')
    expect(screen.getByTestId('subscription-expiry')).toHaveTextContent(/^已过期已于.*到期/)
  })

  it('renders provisionPending without unpromised auto-fallback text', () => {
    render(<DeliveryContent provisionPending={true} />)

    const card = screen.getByTestId('delivery-provision-pending')
    expect(card).toBeInTheDocument()
    expect(card).toHaveTextContent('自动开通中，请稍候…')
    // Strictly must not promise auto fallback to manual
    expect(screen.queryByText(/失败将自动转为人工交付/)).not.toBeInTheDocument()
    expect(screen.queryByText(/若开通失败/)).not.toBeInTheDocument()
  })

  it('renders masked delivery placeholder with decoupled copy based on isSubscription and expired', () => {
    // 1. Non-subscription, not expired (default)
    const { rerender } = render(<DeliveryContent contentMasked={true} />)
    expect(screen.getByTestId('delivery-masked')).toHaveTextContent('敏感交付内容已由系统安全遮蔽')

    // 2. Non-subscription, expired
    rerender(<DeliveryContent contentMasked={true} isSubscription={false} expired={true} />)
    expect(screen.getByTestId('delivery-masked')).toHaveTextContent('凭证已到期，敏感交付内容已由系统安全遮蔽')

    // 3. Subscription, not expired
    rerender(<DeliveryContent contentMasked={true} isSubscription={true} expired={false} />)
    expect(screen.getByTestId('delivery-masked')).toHaveTextContent('订阅凭据已由系统安全遮蔽')

    // 4. Subscription, expired
    rerender(<DeliveryContent contentMasked={true} isSubscription={true} expired={true} />)
    expect(screen.getByTestId('delivery-masked')).toHaveTextContent('订阅已过期。续费将生成新订单，内容在新订单中查看')
  })

  it('passes file.status to FileDeliveryCard and handles revoked file status in delivered order', () => {
    render(
      <DeliveryContent
        orderId={105}
        orderStatus="delivered"
        file={{
          fileName: 'revoked_package.zip',
          size: 1048576,
          status: 'revoked',
        }}
      />,
    )

    const downloadBtn = screen.getByTestId('file-delivery-download')
    expect(downloadBtn).toBeDisabled()
    expect(downloadBtn).toHaveTextContent('下载已作废')
    expect(screen.getByTestId('file-delivery-revoked-notice')).toHaveTextContent('文件下载已作废，授权已失效。如有疑问请联系平台处理。')
  })

  it('renders URL delivery as external link card with clipboard copy feedback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    render(
      <DeliveryContent
        content="https://activation.service.local/key/998877"
        contentType="url"
        urlTestId="custom-url-test"
      />,
    )

    const link = screen.getByTestId('custom-url-test')
    expect(link).toHaveAttribute('href', 'https://activation.service.local/key/998877')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')

    const copyBtn = screen.getByTestId('delivery-copy-url')
    expect(copyBtn).toHaveTextContent('复制链接')

    fireEvent.click(copyBtn)
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('https://activation.service.local/key/998877')
    })
    expect(copyBtn).toHaveTextContent('已复制')
  })

  it('renders text delivery with monospace box and clipboard copy feedback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    render(
      <DeliveryContent
        content="LICENSE-KEY-ABC-123-XYZ"
        contentType="text"
      />,
    )

    const textBox = screen.getByTestId('delivery-text-content')
    expect(textBox).toHaveTextContent('LICENSE-KEY-ABC-123-XYZ')

    const copyBtn = screen.getByTestId('delivery-copy-text')
    expect(copyBtn).toHaveTextContent('复制文本')

    fireEvent.click(copyBtn)
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('LICENSE-KEY-ABC-123-XYZ')
    })
    expect(copyBtn).toHaveTextContent('已复制')
  })
})
