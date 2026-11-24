import { describe, expect, it } from 'vitest'
import {
  methodLabel,
  paymentChannelLabel,
  paymentQrAriaLabel,
  providerLabel,
} from './status'

describe('paymentChannelLabel', () => {
  it('maps VMQFox WeChat/Alipay to buyer payment brands without the channel name', () => {
    expect(paymentChannelLabel('vmqfox', 'wechat', 'user')).toBe('微信支付')
    expect(paymentChannelLabel('vmqfox', 'alipay', 'user')).toBe('支付宝支付')
    expect(paymentChannelLabel('vmqfox', 'wechat', 'user')).not.toMatch(/VMQFox|vmqfox/i)
    expect(paymentChannelLabel('vmqfox', 'alipay', 'user')).not.toMatch(/VMQFox|vmqfox/i)
  })

  it('keeps the VMQFox implementation name on admin surfaces', () => {
    expect(paymentChannelLabel('vmqfox', 'wechat', 'admin')).toBe('微信支付（VMQFox）')
    expect(paymentChannelLabel('vmqfox', 'alipay', 'admin')).toBe('支付宝支付（VMQFox）')
  })

  it('falls back to the existing provider · method concatenation for unknown pairs', () => {
    expect(paymentChannelLabel('simulator', 'card', 'user')).toBe('模拟支付 · 银行卡')
    expect(paymentChannelLabel('alipay', 'form_post', 'user')).toBe('支付宝 · 表单支付')
    expect(paymentChannelLabel('paypal', 'redirect', 'admin')).toBe('PayPal · 跳转支付')
  })

  it('does not expose vmqfox to buyers for unknown methods', () => {
    expect(paymentChannelLabel('vmqfox', 'card', 'user')).toBe('银行卡')
    expect(paymentChannelLabel('vmqfox', 'mystery', 'user')).toBe('扫码支付')
    expect(paymentChannelLabel('vmqfox', 'card', 'admin')).toBe('VMQFox · 银行卡')
  })
})

describe('paymentQrAriaLabel', () => {
  it('names WeChat and Alipay QR codes without reading bearer content', () => {
    expect(paymentQrAriaLabel('vmqfox', 'wechat')).toBe('微信支付二维码')
    expect(paymentQrAriaLabel('vmqfox', 'alipay')).toBe('支付宝支付二维码')
    expect(paymentQrAriaLabel('simulator', 'qr_code')).toBe('支付二维码')
  })
})

describe('providerLabel / methodLabel', () => {
  it('keeps persisted raw ids out of the label tables except as keys', () => {
    expect(providerLabel('vmqfox')).toBe('VMQFox')
    expect(methodLabel('wechat')).toBe('wechat')
    expect(methodLabel('alipay')).toBe('alipay')
  })
})
