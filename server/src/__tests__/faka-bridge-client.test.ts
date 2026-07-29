import { describe, expect, it, vi } from 'vitest'
import {
  buildFakaExternalOrderNo,
  callFakaOrderPaid,
  callFakaOrderStatus,
  isFakaBridgeConfigured,
} from '../lib/fakaBridge/client.js'
import { signFakaParams } from '../lib/fakaBridge/sign.js'
import { FAKA_ERROR } from '../lib/fakaBridge/errors.js'
import type { FakaTransport } from '../lib/fakaBridge/types.js'

const SECRET = 'unit-test-faka-secret-at-least-32-chars!!'
const PAID_URL = 'https://v.uuwu.de/plugin/faka-bridge/order-paid'
const STATUS_URL = 'https://v.uuwu.de/plugin/faka-bridge/order-status'

describe('buildFakaExternalOrderNo', () => {
  it('uses MN-{id} form', () => {
    expect(buildFakaExternalOrderNo(42)).toBe('MN-42')
  })
})

describe('isFakaBridgeConfigured', () => {
  it('is true only when both url and secret are provided via overrides', () => {
    expect(isFakaBridgeConfigured({ url: PAID_URL, secret: SECRET })).toBe(true)
    // Explicit empty clears env-backed config for the override path.
    expect(isFakaBridgeConfigured({ url: PAID_URL, secret: '' })).toBe(false)
    expect(isFakaBridgeConfigured({ url: '', secret: SECRET })).toBe(false)
  })
})

describe('callFakaOrderPaid', () => {
  it('POSTs a signed JSON body and parses success', async () => {
    const transport = vi.fn<FakaTransport>(async ({ method, url, body, headers }) => {
      expect(method).toBe('POST')
      expect(url).toBe(PAID_URL)
      expect(headers['Content-Type']).toBe('application/json')
      const parsed = JSON.parse(body!) as Record<string, string | number>
      expect(parsed.order_no).toBe('MN-99')
      expect(parsed.email).toBe('user@example.com')
      expect(parsed.sku).toBe('aster-basic-monthly')
      expect(parsed.period).toBe('monthly')
      expect(typeof parsed.paid_at).toBe('number')
      const expectedSign = signFakaParams(
        {
          order_no: parsed.order_no,
          email: parsed.email,
          sku: parsed.sku,
          period: parsed.period,
          paid_at: parsed.paid_at,
        },
        SECRET
      )
      expect(parsed.sign).toBe(expectedSign)
      return {
        status: 200,
        text: JSON.stringify({
          success: true,
          trade_no: '2026072913073040537586615',
          order_no: 'MN-99',
          status: 'completed',
          message: 'ok',
        }),
      }
    })

    const result = await callFakaOrderPaid(
      {
        order_no: 'MN-99',
        email: 'User@Example.com',
        sku: 'aster-basic-monthly',
        paid_at: 1_785_301_890,
      },
      { url: PAID_URL, secret: SECRET, transport }
    )

    expect(result.ok).toBe(true)
    expect(result.httpStatus).toBe(200)
    expect(result.body).toMatchObject({
      success: true,
      trade_no: '2026072913073040537586615',
      status: 'completed',
    })
    expect(transport).toHaveBeenCalledOnce()
  })

  it('returns SIGN_FAILED / non-ok on 400 signature error body', async () => {
    const transport: FakaTransport = async () => ({
      status: 400,
      text: JSON.stringify({ success: false, error: '签名验证失败' }),
    })

    const result = await callFakaOrderPaid(
      {
        order_no: 'MN-1',
        email: 'a@b.c',
        sku: 'aster-basic-monthly',
        paid_at: 100,
      },
      { url: PAID_URL, secret: SECRET, transport }
    )

    expect(result.ok).toBe(false)
    expect(result.code).toBe(FAKA_ERROR.SIGN_FAILED)
    expect(result.body).toMatchObject({ success: false })
  })

  it('classifies transport timeout', async () => {
    const transport: FakaTransport = async () => {
      throw new Error('FakaBridge request timeout')
    }

    const result = await callFakaOrderPaid(
      {
        order_no: 'MN-1',
        email: 'a@b.c',
        sku: 'aster-basic-monthly',
        paid_at: 100,
      },
      { url: PAID_URL, secret: SECRET, transport }
    )

    expect(result.ok).toBe(false)
    expect(result.code).toBe(FAKA_ERROR.TIMEOUT)
  })

  it('returns NOT_CONFIGURED without url/secret', async () => {
    const result = await callFakaOrderPaid(
      {
        order_no: 'MN-1',
        email: 'a@b.c',
        sku: 'x',
        paid_at: 1,
      },
      { url: '', secret: '' }
    )
    expect(result.ok).toBe(false)
    expect(result.code).toBe(FAKA_ERROR.NOT_CONFIGURED)
  })
})

describe('callFakaOrderStatus', () => {
  it('GETs with signed query string', async () => {
    let seenUrl = ''
    let seenMethod = ''
    const transport: FakaTransport = async ({ method, url }) => {
      seenMethod = method
      seenUrl = url
      return {
        status: 200,
        text: JSON.stringify({
          success: true,
          order_no: 'MN-7',
          status: 'completed',
          trade_no: 'T1',
        }),
      }
    }

    const result = await callFakaOrderStatus('MN-7', {
      url: PAID_URL,
      statusUrl: STATUS_URL,
      secret: SECRET,
      transport,
    })

    expect(result.ok).toBe(true)
    expect(result.body).toMatchObject({ trade_no: 'T1', status: 'completed' })
    expect(seenMethod).toBe('GET')
    const u = new URL(seenUrl)
    expect(`${u.origin}${u.pathname}`).toBe(STATUS_URL)
    expect(u.searchParams.get('order_no')).toBe('MN-7')
    expect(u.searchParams.get('sign')).toBe(signFakaParams({ order_no: 'MN-7' }, SECRET))
  })
})
