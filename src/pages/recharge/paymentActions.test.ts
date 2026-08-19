import { afterEach, describe, expect, it } from 'vitest'
import { assertSafeHttpUrl, buildFormPostForm, UnsafePaymentUrlError } from './paymentActions'

describe('payment actions', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('builds Alipay form_post from structured actionUrl/method/fields without HTML injection', () => {
    const form = buildFormPostForm({
      type: 'form_post',
      actionUrl: 'https://openapi.alipay.com/gateway.do',
      method: 'POST',
      fields: {
        out_trade_no: 'ord-1',
        biz_content: '{"amount":"1.00"}',
        payload: '<script>alert(1)</script>',
      },
    })
    expect(form.method.toLowerCase()).toBe('post')
    expect(form.action).toBe('https://openapi.alipay.com/gateway.do')
    const values = [...form.querySelectorAll('input')].map((input) => ({
      name: input.name,
      value: input.value,
      type: input.type,
    }))
    expect(values).toEqual([
      { name: 'out_trade_no', value: 'ord-1', type: 'hidden' },
      { name: 'biz_content', value: '{"amount":"1.00"}', type: 'hidden' },
      { name: 'payload', value: '<script>alert(1)</script>', type: 'hidden' },
    ])
    expect(form.querySelector('script')).toBeNull()
    expect(form.querySelectorAll('input')).toHaveLength(3)
  })

  it('rejects executable payment URLs', () => {
    expect(() => assertSafeHttpUrl('javascript:alert(1)')).toThrow(UnsafePaymentUrlError)
    expect(() => assertSafeHttpUrl('data:text/html,<form></form>')).toThrow(UnsafePaymentUrlError)
  })

  it('allows only HTTPS redirect and form_post action URLs', () => {
    expect(() => assertSafeHttpUrl('http://pay.example.com/checkout')).toThrow(UnsafePaymentUrlError)
    expect(() =>
      buildFormPostForm({
        type: 'form_post',
        actionUrl: 'http://openapi.alipay.com/gateway.do',
        method: 'POST',
        fields: { out_trade_no: 'ord-1' },
      }),
    ).toThrow(UnsafePaymentUrlError)
    expect(assertSafeHttpUrl('https://www.paypal.com/checkoutnow')).toContain('https://')
  })
})
