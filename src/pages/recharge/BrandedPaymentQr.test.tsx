import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import BrandedPaymentQr from './BrandedPaymentQr'
import { QR_VISUAL_SIZE_PX } from './paymentBrands'

const BASE = {
  content: 'wxp://pay/example',
  display: 'text' as const,
  payableAmountMinor: '1001',
  currency: 'CNY',
  actionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  orderExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  orderStatus: 'pending_payment',
}

describe('BrandedPaymentQr', () => {
  it('shows the payable amount above a WeChat QR with a center mark and no channel chrome', () => {
    const { container } = render(
      <BrandedPaymentQr {...BASE} provider="vmqfox" paymentMethod="wechat" />,
    )
    expect(screen.getByTestId('recharge-qr-amount')).toHaveTextContent('¥10.01')
    expect(screen.getByRole('img', { name: '微信支付二维码' })).toBeInTheDocument()
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    expect(svg).toHaveAttribute('width', String(QR_VISUAL_SIZE_PX))
    expect(container.querySelector('image')).toBeTruthy()
    expect(container.querySelector('image')?.getAttribute('href') ?? '').toMatch(/wechat-pay-zh/)
    expect(screen.queryByText('VMQFox')).not.toBeInTheDocument()
    expect(screen.queryByText(/wechat|alipay/i)).not.toBeInTheDocument()
    expect(screen.queryByText('请使用对应 App 扫码完成支付')).not.toBeInTheDocument()
  })

  it('renders an Alipay QR with the official circular center mark', () => {
    const { container } = render(
      <BrandedPaymentQr
        {...BASE}
        content="https://qr.alipay.com/fkx0123456789abcdef"
        provider="vmqfox"
        paymentMethod="alipay"
      />,
    )
    expect(screen.getByTestId('recharge-qr-amount')).toHaveTextContent('¥10.01')
    expect(screen.getByRole('img', { name: '支付宝支付二维码' })).toBeInTheDocument()
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    expect(svg).toHaveAttribute('width', String(QR_VISUAL_SIZE_PX))
    expect(container.querySelector('image')).toBeTruthy()
    expect(container.querySelector('image')?.getAttribute('href') ?? '').toMatch(/alipay-logo-circular/)
    expect(screen.queryByText('VMQFox')).not.toBeInTheDocument()
    expect(screen.queryByText(/wechat|alipay/i)).not.toBeInTheDocument()
  })

  it('hides the QR when the action is expired', () => {
    render(
      <BrandedPaymentQr
        {...BASE}
        provider="vmqfox"
        paymentMethod="wechat"
        actionExpiresAt={new Date(Date.now() - 1000).toISOString()}
      />,
    )
    expect(screen.queryByTestId('recharge-qr')).not.toBeInTheDocument()
  })

  it('hides the QR when the order is terminal', () => {
    render(
      <BrandedPaymentQr
        {...BASE}
        provider="vmqfox"
        paymentMethod="wechat"
        orderStatus="credited"
      />,
    )
    expect(screen.queryByTestId('recharge-qr')).not.toBeInTheDocument()
  })
})
