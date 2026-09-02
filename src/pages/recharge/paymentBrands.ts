/**
 * Bundled payment marks. Do not load brand URLs at runtime.
 *
 * WeChat Pay mark: official RGB 中文标识, viewBox crop of the stacked lockup.
 * Provenance: src/assets/payment-brands/THIRD_PARTY_NOTICES.md
 * Retrieved 2026-09-02 from https://pay.weixin.qq.com/material/brand.shtml
 * Original: brand/品牌基础物料/04微信支付logo源文件/线上RGB模式/微信支付中文标识.png
 *
 * Alipay: no standalone official payment mark verified; QR ships without a center image.
 */
import wechatPayZh from '../../assets/payment-brands/wechat-pay-zh.png'

export const QR_VISUAL_SIZE_PX = 232
export const QR_MIN_SIZE_PX = 200
export const QR_MARK_MAX_FRACTION = 0.16

/** Intrinsic pixels of wechat-pay-zh.png (stacked lockup crop). */
export const WECHAT_PAY_MARK_INTRINSIC = { width: 115, height: 145 } as const

export type PaymentQrCenterMark = {
  src: string
  width: number
  height: number
}

export function scaleMarkToQr(
  intrinsic: { width: number; height: number },
  qrSize: number,
  maxFraction = QR_MARK_MAX_FRACTION,
): { width: number; height: number } {
  const max = qrSize * maxFraction
  const scale = Math.min(max / intrinsic.width, max / intrinsic.height, 1)
  return {
    width: Math.max(1, Math.round(intrinsic.width * scale)),
    height: Math.max(1, Math.round(intrinsic.height * scale)),
  }
}

export function paymentQrCenterMark(provider: string, method: string): PaymentQrCenterMark | null {
  if (provider === 'vmqfox' && method === 'wechat') {
    const size = scaleMarkToQr(WECHAT_PAY_MARK_INTRINSIC, QR_VISUAL_SIZE_PX)
    return { src: wechatPayZh, ...size }
  }
  return null
}
