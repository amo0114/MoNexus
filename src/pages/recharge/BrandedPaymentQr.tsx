import { QRCodeSVG } from 'qrcode.react'
import { formatCurrencyAmount } from './money'
import { isHttpsImageUrl } from './paymentActions'
import {
  paymentQrCenterMark,
  QR_MIN_SIZE_PX,
  QR_VISUAL_SIZE_PX,
} from './paymentBrands'
import { isTerminalOrderStatus, paymentQrAriaLabel } from './status'

function isPast(iso?: string | null): boolean {
  if (!iso) return false
  const t = Date.parse(iso)
  return Number.isFinite(t) && t <= Date.now()
}

export type BrandedPaymentQrProps = {
  content: string
  display?: 'text' | 'image_url'
  payableAmountMinor: string
  currency: string
  provider: string
  paymentMethod: string
  actionExpiresAt?: string
  orderExpiresAt?: string
  orderStatus: string
}

export default function BrandedPaymentQr({
  content,
  display = 'text',
  payableAmountMinor,
  currency,
  provider,
  paymentMethod,
  actionExpiresAt,
  orderExpiresAt,
  orderStatus,
}: BrandedPaymentQrProps) {
  if (isTerminalOrderStatus(orderStatus)) return null
  if (isPast(actionExpiresAt) || isPast(orderExpiresAt)) return null

  const amount = formatCurrencyAmount(payableAmountMinor, currency)
  const ariaLabel = paymentQrAriaLabel(provider, paymentMethod)
  const mark = display === 'text' ? paymentQrCenterMark(provider, paymentMethod) : null

  return (
    <div className="flex flex-col items-center gap-3" data-testid="recharge-qr">
      <p
        className="font-heading text-2xl font-bold text-[var(--color-text)]"
        data-testid="recharge-qr-amount"
      >
        {amount}
      </p>
      {display === 'image_url' && isHttpsImageUrl(content) ? (
        <img
          src={content}
          alt={ariaLabel}
          className="h-auto w-full min-w-[200px] max-w-[232px] bg-white object-contain p-2"
        />
      ) : (
        <div
          className="w-full min-w-[200px] max-w-[232px] bg-white"
          role="img"
          aria-label={ariaLabel}
          data-testid="recharge-qr-code"
        >
          <QRCodeSVG
            value={content}
            size={QR_VISUAL_SIZE_PX}
            level="H"
            marginSize={4}
            bgColor="#ffffff"
            fgColor="#000000"
            aria-hidden="true"
            className="h-auto w-full"
            style={{ minWidth: QR_MIN_SIZE_PX }}
            imageSettings={mark
              ? {
                  src: mark.src,
                  width: mark.width,
                  height: mark.height,
                  excavate: true,
                }
              : undefined}
          />
        </div>
      )}
    </div>
  )
}
