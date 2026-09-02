import { describe, expect, it } from 'vitest'
import {
  ALIPAY_LOGO_CIRCULAR_INTRINSIC,
  paymentQrCenterMark,
  QR_MARK_MAX_FRACTION,
  QR_VISUAL_SIZE_PX,
  scaleMarkToQr,
  WECHAT_PAY_MARK_INTRINSIC,
} from './paymentBrands'

describe('paymentQrCenterMark', () => {
  it('supplies a WeChat Pay mark that stays within ~16% of the QR visual size', () => {
    const mark = paymentQrCenterMark('vmqfox', 'wechat')
    expect(mark).not.toBeNull()
    expect(mark?.src).toMatch(/wechat-pay-zh/)
    expect(mark!.width).toBeLessThanOrEqual(Math.ceil(QR_VISUAL_SIZE_PX * QR_MARK_MAX_FRACTION))
    expect(mark!.height).toBeLessThanOrEqual(Math.ceil(QR_VISUAL_SIZE_PX * QR_MARK_MAX_FRACTION))
    const ratio = mark!.width / mark!.height
    const intrinsic = WECHAT_PAY_MARK_INTRINSIC.width / WECHAT_PAY_MARK_INTRINSIC.height
    expect(ratio).toBeCloseTo(intrinsic, 1)
  })

  it('supplies the official Alipay circular mark within ~16% of the QR visual size', () => {
    const mark = paymentQrCenterMark('vmqfox', 'alipay')
    expect(mark).not.toBeNull()
    expect(mark?.src).toMatch(/alipay-logo-circular/)
    expect(mark!.width).toBeLessThanOrEqual(Math.ceil(QR_VISUAL_SIZE_PX * QR_MARK_MAX_FRACTION))
    expect(mark!.height).toBeLessThanOrEqual(Math.ceil(QR_VISUAL_SIZE_PX * QR_MARK_MAX_FRACTION))
    expect(mark!.width).toBe(mark!.height)
    const ratio = mark!.width / mark!.height
    const intrinsic = ALIPAY_LOGO_CIRCULAR_INTRINSIC.width / ALIPAY_LOGO_CIRCULAR_INTRINSIC.height
    expect(ratio).toBeCloseTo(intrinsic, 1)
    expect(ratio).toBeCloseTo(1, 5)
  })

  it('does not attach a center mark to non-QR Alipay checkout', () => {
    expect(paymentQrCenterMark('alipay', 'form_post')).toBeNull()
  })
})

describe('scaleMarkToQr', () => {
  it('never stretches and never exceeds the fraction cap', () => {
    expect(scaleMarkToQr({ width: 100, height: 50 }, 200, 0.16)).toEqual({ width: 32, height: 16 })
  })
})
