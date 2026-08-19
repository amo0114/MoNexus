import { describe, expect, it } from 'vitest'
import { HttpError } from '../../../lib/httpError.js'
import { assertStructuredFormPost, FORM_POST_MAX_FIELDS, FORM_POST_MAX_TOTAL_BYTES } from './formPost.js'

const allowlist = { hosts: ['pay.simulator.test'] }

describe('assertStructuredFormPost', () => {
  it('accepts a structured HTTPS allowlisted action', () => {
    const fields = assertStructuredFormPost({
      actionUrl: 'https://pay.simulator.test/checkout',
      method: 'POST',
      fields: { out_trade_no: 'sim_1', total_amount: '10.00' },
    }, allowlist)
    expect(fields).toEqual({ out_trade_no: 'sim_1', total_amount: '10.00' })
  })

  it('rejects http, unknown hosts, HTML, and oversized payloads', () => {
    expect(() => assertStructuredFormPost({
      actionUrl: 'http://pay.simulator.test/checkout',
      method: 'POST',
      fields: { a: '1' },
    }, allowlist)).toThrow(HttpError)

    expect(() => assertStructuredFormPost({
      actionUrl: 'https://evil.example/checkout',
      method: 'POST',
      fields: { a: '1' },
    }, allowlist)).toThrow(/allowlisted/)

    expect(() => assertStructuredFormPost({
      actionUrl: 'https://pay.simulator.test/checkout',
      method: 'POST',
      fields: { html: '<script>alert(1)</script>' },
    }, allowlist)).toThrow(/HTML/)

    expect(() => assertStructuredFormPost({
      actionUrl: '<form action="https://pay.simulator.test/x"></form>',
      method: 'POST',
      fields: { a: '1' },
    }, allowlist)).toThrow(/HTML/)

    const tooMany: Record<string, string> = {}
    for (let i = 0; i < FORM_POST_MAX_FIELDS + 1; i += 1) tooMany[`k${i}`] = 'v'
    expect(() => assertStructuredFormPost({
      actionUrl: 'https://pay.simulator.test/checkout',
      method: 'POST',
      fields: tooMany,
    }, allowlist)).toThrow(/too many/)

    expect(() => assertStructuredFormPost({
      actionUrl: 'https://pay.simulator.test/checkout',
      method: 'POST',
      fields: { payload: 'x'.repeat(FORM_POST_MAX_TOTAL_BYTES) },
    }, allowlist)).toThrow(/size/)
  })
})
