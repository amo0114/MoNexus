import { describe, expect, it } from 'vitest'
import {
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

  it('omits an Alipay center mark when no standalone official payment mark is verified (BLOCKED_CONCERN)', () => {
    expect(paymentQrCenterMark('vmqfox', 'alipay')).toBeNull()
    expect(paymentQrCenterMark('alipay', 'form_post')).toBeNull()
  })
})

describe('scaleMarkToQr', () => {
  it('never stretches and never exceeds the fraction cap', () => {
    expect(scaleMarkToQr({ width: 100, height: 50 }, 200, 0.16)).toEqual({ width: 32, height: 16 })
  })
})
