import { createHash, randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { prisma } from '../../../../lib/prisma.js'
import { logger } from '../../../../lib/logger.js'
import { applyConfirmedPayment } from '../../events/applyConfirmedPayment.js'
import { hashNormalizedPayload, recordPaymentObservation } from '../../observations/record.js'
import { serializeAmountMinor } from '../../../recharge/money.js'
import { createTestUser } from '../../../../__tests__/helpers.js'
import { amountMinorToYuanString, yuanStringToAmountMinor } from './amount.js'
import {
  isAllowedCheckoutRedirect,
  parseVmqfoxBaseUrl,
  VMQFOX_CAPABILITY_VERSION,
  VMQFOX_ORIGIN_ALLOWLIST,
  VMQFOX_RECOMMENDED_ORIGIN,
  type VmqfoxAdapterConfig,
} from './config.js'
import { validateVmqfoxPayUrl } from './payUrl.js'
import {
  createSignV2,
  callbackSignV2,
  queryByPayIdSignV2,
  signaturesEqual,
} from './sign.js'
import { mapVmqfoxState } from './normalize.js'
import { verifyAndNormalizeNotify, VMQFOX_WEBHOOK_SUCCESS_BODY, vmqfoxPaidDedupeKey } from './webhook.js'
import { createVmqfoxProvider } from './provider.js'
import { type VmqfoxHttp, type VmqfoxHttpResponse } from './client.js'
import { createPaymentWebhookRouter } from '../../webhooks/routes.js'
import * as registry from '../registry.js'

const VECTOR_KEY = 'testkey123456'
const VECTOR_PAY_ID = 'TEST20260314001'
const VECTOR_TYPE = '1'
const VECTOR_PRICE = '1.00'
const VECTOR_REALLY_PRICE = '0.99'
const VECTOR_NOTIFY = 'https://shop.example.com/notify'
const VECTOR_RETURN = 'https://shop.example.com/return'
const VECTOR_TIMESTAMP = '1773500000000'
const VECTOR_CREATE = '729a6c529b4a2ffed215d124a7e4244ed5d4981ba1982d4cd6f9a53b28de9263'
const VECTOR_CALLBACK = '0f21b9366a12396a71437d336a21fd7c5fe20b292e9b56d25b6b612a144daa60'
const VECTOR_QUERY = '1bf791a356959d89bccc6227c97982d98b5625e96d0d24fdd6382421a7f12373'

const TOKEN = 'a'.repeat(64)
const ORDER_ID = '11111111-1111-1111-1111-111111111111'
const INTENT_ID = '22222222-2222-2222-2222-222222222222'
const ATTEMPT_ID = '33333333-3333-3333-3333-333333333333'
const RETURN_URL = `https://shop.example.com/recharge?order=${ORDER_ID}`
const NOTIFY_URL = 'https://shop.example.com/api/payment/webhooks/vmqfox'
const REDIRECT = `${VMQFOX_RECOMMENDED_ORIGIN}/#/payment/${TOKEN}`
const WXP_PAY_URL = 'wxp://f2f0abcdefghijklmnopqrstuvwxyz012345'
const ALIPAY_PAY_URL = 'https://qr.alipay.com/fkx0123456789abcdef'
const FROZEN_NOW = new Date('2026-09-01T00:00:00.000Z')
const QR_EXPIRES_AT = new Date(FROZEN_NOW.getTime() + 5 * 60 * 1000).toISOString()

const liveConfig: VmqfoxAdapterConfig = {
  mode: 'live',
  baseUrl: VMQFOX_RECOMMENDED_ORIGIN,
  origin: VMQFOX_RECOMMENDED_ORIGIN,
  allowedOrigins: VMQFOX_ORIGIN_ALLOWLIST,
  accountKey: 'vmqfox-primary',
  merchantKey: VECTOR_KEY,
  notifyUrl: NOTIFY_URL,
  maxAmountMinor: 100_000n,
  requestTimeoutMs: 5_000,
  protocolVersion: '2',
}

function envelope(data: unknown, code = 200, msg = '成功'): VmqfoxHttpResponse {
  return { status: 200, headers: {}, body: JSON.stringify({ code, msg, data }) }
}

function errorEnvelope(code: number, msg: string, status = 200): VmqfoxHttpResponse {
  return { status, headers: {}, body: JSON.stringify({ code, msg, data: null }) }
}

function createData(overrides: Record<string, unknown> = {}) {
  return {
    payId: ATTEMPT_ID,
    orderId: '20260901001',
    publicToken: TOKEN,
    payType: 1,
    price: '10.00',
    reallyPrice: '10.01',
    payUrl: WXP_PAY_URL,
    isAuto: 1,
    redirectUrl: REDIRECT,
    ...overrides,
  }
}

function queryData(overrides: Record<string, unknown> = {}) {
  return {
    status: 0,
    publicToken: TOKEN,
    type: 1,
    price: '10.00',
    reallyPrice: '10.01',
    ...overrides,
  }
}

function getOrderData(overrides: Record<string, unknown> = {}) {
  return {
    payId: ATTEMPT_ID,
    payType: 1,
    price: '10.00',
    reallyPrice: '10.01',
    state: 0,
    payUrl: WXP_PAY_URL,
    remainingSeconds: 300,
    ...overrides,
  }
}

function createInput(overrides: Partial<Parameters<ReturnType<typeof createVmqfoxProvider>['createPayment']>[0]> = {}) {
  return {
    orderId: ORDER_ID,
    paymentIntentId: INTENT_ID,
    paymentAttemptId: ATTEMPT_ID,
    amountMinor: 1000n,
    currency: 'CNY' as const,
    paymentMethod: 'wechat',
    providerAccountKey: 'vmqfox-primary',
    requestIdempotencyKey: 'idem-1',
    returnUrl: RETURN_URL,
    ...overrides,
  }
}

function signedCallback(fields: {
  payId: string
  param: string
  type: string
  price: string
  reallyPrice: string
}): Buffer {
  const sign = callbackSignV2(fields, VECTOR_KEY)
  return Buffer.from(new URLSearchParams({ ...fields, sign }).toString(), 'utf8')
}

describe('VMQFox amount conversion', () => {
  it('formats and parses exact two-decimal amounts without float', () => {
    expect(amountMinorToYuanString(1n)).toBe('0.01')
    expect(amountMinorToYuanString(10n)).toBe('0.10')
    expect(amountMinorToYuanString(1000n)).toBe('10.00')
    expect(amountMinorToYuanString(1001n)).toBe('10.01')
    expect(yuanStringToAmountMinor('10.00')).toBe(1000n)
    expect(yuanStringToAmountMinor('10.01')).toBe(1001n)
  })

  it('rejects non-canonical yuan strings', () => {
    expect(() => yuanStringToAmountMinor('10.0')).toThrow(/canonical/)
    expect(() => yuanStringToAmountMinor('10')).toThrow(/canonical/)
    expect(() => yuanStringToAmountMinor('10.001')).toThrow(/canonical/)
    expect(() => yuanStringToAmountMinor('1e2')).toThrow(/exponent/)
    expect(() => yuanStringToAmountMinor(10.01 as unknown as string)).toThrow(/string/)
  })
})

describe('VMQFox HMAC golden vectors', () => {
  it('matches official VMQFox v2 create and callback vectors', () => {
    expect(createSignV2({
      payId: VECTOR_PAY_ID,
      param: '',
      type: VECTOR_TYPE,
      price: VECTOR_PRICE,
      notifyUrl: VECTOR_NOTIFY,
      returnUrl: VECTOR_RETURN,
    }, VECTOR_KEY)).toBe(VECTOR_CREATE)
    expect(callbackSignV2({
      payId: VECTOR_PAY_ID,
      param: '',
      type: VECTOR_TYPE,
      price: VECTOR_PRICE,
      reallyPrice: VECTOR_REALLY_PRICE,
    }, VECTOR_KEY)).toBe(VECTOR_CALLBACK)
  })

  it('matches the MoNexus/PR-V0 query-by-pay-id contract vector', () => {
    expect(queryByPayIdSignV2({
      payId: VECTOR_PAY_ID,
      timestamp: VECTOR_TIMESTAMP,
    }, VECTOR_KEY)).toBe(VECTOR_QUERY)
  })

  it('fails when notifyUrl, returnUrl, price, or reallyPrice are tampered', () => {
    const createBase = createSignV2({
      payId: VECTOR_PAY_ID, param: '', type: VECTOR_TYPE, price: VECTOR_PRICE,
      notifyUrl: VECTOR_NOTIFY, returnUrl: VECTOR_RETURN,
    }, VECTOR_KEY)
    expect(createSignV2({
      payId: VECTOR_PAY_ID, param: '', type: VECTOR_TYPE, price: VECTOR_PRICE,
      notifyUrl: 'https://attacker.example/notify', returnUrl: VECTOR_RETURN,
    }, VECTOR_KEY)).not.toBe(createBase)
    expect(createSignV2({
      payId: VECTOR_PAY_ID, param: '', type: VECTOR_TYPE, price: VECTOR_PRICE,
      notifyUrl: VECTOR_NOTIFY, returnUrl: 'https://attacker.example/return',
    }, VECTOR_KEY)).not.toBe(createBase)

    const callbackBase = callbackSignV2({
      payId: VECTOR_PAY_ID, param: '', type: VECTOR_TYPE, price: VECTOR_PRICE, reallyPrice: VECTOR_REALLY_PRICE,
    }, VECTOR_KEY)
    expect(callbackSignV2({
      payId: VECTOR_PAY_ID, param: '', type: VECTOR_TYPE, price: '1.01', reallyPrice: VECTOR_REALLY_PRICE,
    }, VECTOR_KEY)).not.toBe(callbackBase)
    expect(callbackSignV2({
      payId: VECTOR_PAY_ID, param: '', type: VECTOR_TYPE, price: VECTOR_PRICE, reallyPrice: '1.00',
    }, VECTOR_KEY)).not.toBe(callbackBase)
    expect(signaturesEqual(callbackBase, VECTOR_CALLBACK)).toBe(true)
    const flipped = `${VECTOR_CALLBACK.slice(0, -1)}${VECTOR_CALLBACK.endsWith('a') ? 'b' : 'a'}`
    expect(signaturesEqual(callbackBase, flipped)).toBe(false)
  })

  it('does not sign URL-encoded values', () => {
    const raw = createSignV2({
      payId: VECTOR_PAY_ID, param: '', type: VECTOR_TYPE, price: VECTOR_PRICE,
      notifyUrl: VECTOR_NOTIFY, returnUrl: VECTOR_RETURN,
    }, VECTOR_KEY)
    const encoded = createSignV2({
      payId: VECTOR_PAY_ID, param: '', type: VECTOR_TYPE, price: VECTOR_PRICE,
      notifyUrl: encodeURIComponent(VECTOR_NOTIFY), returnUrl: encodeURIComponent(VECTOR_RETURN),
    }, VECTOR_KEY)
    expect(encoded).not.toBe(raw)
  })
})

describe('VMQFox origin allowlist', () => {
  it('accepts the recommended HTTPS origin and rejects userinfo/query/fragment/http', () => {
    expect(parseVmqfoxBaseUrl('https://pay.snowvictor.com', VMQFOX_ORIGIN_ALLOWLIST).origin).toBe(VMQFOX_RECOMMENDED_ORIGIN)
    expect(() => parseVmqfoxBaseUrl('http://pay.snowvictor.com', VMQFOX_ORIGIN_ALLOWLIST)).toThrow()
    expect(() => parseVmqfoxBaseUrl('https://user:pass@pay.snowvictor.com', VMQFOX_ORIGIN_ALLOWLIST)).toThrow()
    expect(() => parseVmqfoxBaseUrl('https://pay.snowvictor.com/?x=1', VMQFOX_ORIGIN_ALLOWLIST)).toThrow()
    expect(() => parseVmqfoxBaseUrl('https://pay.snowvictor.com/#/x', VMQFOX_ORIGIN_ALLOWLIST)).toThrow()
    expect(() => parseVmqfoxBaseUrl('https://evil.example', VMQFOX_ORIGIN_ALLOWLIST)).toThrow(/allowlisted/)
  })

  it('allows only same-origin /#/payment/<64 hex> checkout URLs', () => {
    expect(isAllowedCheckoutRedirect(REDIRECT, VMQFOX_ORIGIN_ALLOWLIST)).toBe(true)
    expect(isAllowedCheckoutRedirect(`https://evil.example/#/payment/${TOKEN}`, VMQFOX_ORIGIN_ALLOWLIST)).toBe(false)
    expect(isAllowedCheckoutRedirect(`${VMQFOX_RECOMMENDED_ORIGIN}/#/payment/zz`, VMQFOX_ORIGIN_ALLOWLIST)).toBe(false)
    expect(isAllowedCheckoutRedirect(`${VMQFOX_RECOMMENDED_ORIGIN}/payment/${TOKEN}`, VMQFOX_ORIGIN_ALLOWLIST)).toBe(false)
    expect(isAllowedCheckoutRedirect(`http://pay.snowvictor.com/#/payment/${TOKEN}`, VMQFOX_ORIGIN_ALLOWLIST)).toBe(false)
  })
})

describe('VMQFox payUrl allowlist', () => {
  const cases: Array<{ name: string; method: 'wechat' | 'alipay'; raw: string; ok: boolean }> = [
    { name: 'accepts wechat wxp production content', method: 'wechat', raw: WXP_PAY_URL, ok: true },
    { name: 'accepts alipay qr.alipay.com production content', method: 'alipay', raw: ALIPAY_PAY_URL, ok: true },
    { name: 'accepts alipay default https port 443', method: 'alipay', raw: 'https://qr.alipay.com:443/fkx1', ok: true },
    { name: 'accepts max-length wechat content', method: 'wechat', raw: `wxp:${'a'.repeat(2044)}`, ok: true },
    { name: 'rejects wechat uppercase prefix', method: 'wechat', raw: 'WXP://f2f0abc', ok: false },
    { name: 'rejects wechat mixed-case prefix', method: 'wechat', raw: 'Wxp://f2f0abc', ok: false },
    { name: 'rejects wechat weixin scheme', method: 'wechat', raw: 'weixin://wxpay', ok: false },
    { name: 'rejects wechat empty payload after prefix', method: 'wechat', raw: 'wxp:', ok: false },
    { name: 'rejects wechat leading space without trimming', method: 'wechat', raw: ` ${WXP_PAY_URL}`, ok: false },
    { name: 'rejects wechat trailing space without trimming', method: 'wechat', raw: `${WXP_PAY_URL} `, ok: false },
    { name: 'rejects wechat newline', method: 'wechat', raw: `${WXP_PAY_URL}\n`, ok: false },
    { name: 'rejects wechat NUL', method: 'wechat', raw: `${WXP_PAY_URL}\u0000`, ok: false },
    { name: 'rejects wechat tab', method: 'wechat', raw: 'wxp://f2f0abc\tmore', ok: false },
    { name: 'rejects wechat oversize content', method: 'wechat', raw: `wxp:${'a'.repeat(2045)}`, ok: false },
    { name: 'rejects alipay http scheme', method: 'alipay', raw: 'http://qr.alipay.com/fkx1', ok: false },
    { name: 'rejects alipay javascript scheme', method: 'alipay', raw: 'javascript:alert(1)', ok: false },
    { name: 'rejects alipay data scheme', method: 'alipay', raw: 'data:text/html,hi', ok: false },
    { name: 'rejects alipay userinfo', method: 'alipay', raw: 'https://user:pass@qr.alipay.com/fkx1', ok: false },
    { name: 'rejects alipay non-default port', method: 'alipay', raw: 'https://qr.alipay.com:8443/fkx1', ok: false },
    { name: 'rejects alipay fragment', method: 'alipay', raw: 'https://qr.alipay.com/fkx1#x', ok: false },
    { name: 'rejects alipay lookalike hostname', method: 'alipay', raw: 'https://qr.alipay.com.evil.com/fkx1', ok: false },
    { name: 'rejects alipay lookalike subdomain', method: 'alipay', raw: 'https://evil.qr.alipay.com/fkx1', ok: false },
    { name: 'rejects alipay hostname case', method: 'alipay', raw: 'https://QR.ALIPAY.COM/fkx1', ok: false },
    { name: 'rejects alipay snowvictor checkout', method: 'alipay', raw: REDIRECT, ok: false },
    { name: 'rejects alipay leading space without trimming', method: 'alipay', raw: ` ${ALIPAY_PAY_URL}`, ok: false },
    { name: 'rejects alipay newline', method: 'alipay', raw: `${ALIPAY_PAY_URL}\n`, ok: false },
    { name: 'rejects alipay oversize content', method: 'alipay', raw: `https://qr.alipay.com/${'a'.repeat(2048)}`, ok: false },
    { name: 'rejects wechat content for alipay', method: 'alipay', raw: WXP_PAY_URL, ok: false },
    { name: 'rejects alipay content for wechat', method: 'wechat', raw: ALIPAY_PAY_URL, ok: false },
  ]

  it.each(cases)('$name', ({ method, raw, ok }) => {
    const accepted = validateVmqfoxPayUrl(method, raw)
    if (ok) expect(accepted).toBe(raw)
    else expect(accepted).toBeNull()
  })
})

describe('VMQFox adapter contract', () => {
  it('creates wechat and alipay qr_code actions with reallyPrice as amountMinor', async () => {
    const seen: string[] = []
    const http: VmqfoxHttp = async req => {
      seen.push(`${req.method} ${req.url}`)
      expect(req.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
      const params = new URLSearchParams(req.body)
      const type = params.get('type')!
      const sign = createSignV2({
        payId: params.get('payId')!,
        param: params.get('param')!,
        type,
        price: params.get('price')!,
        notifyUrl: params.get('notifyUrl')!,
        returnUrl: params.get('returnUrl')!,
      }, VECTOR_KEY)
      expect(params.get('sign')).toBe(sign)
      expect(params.get('payId')).toBe(ATTEMPT_ID)
      expect(params.get('param')).toBe(ORDER_ID)
      expect(params.get('returnUrl')).toBe(RETURN_URL)
      return envelope(createData({
        payType: Number(type),
        payUrl: type === '2' ? ALIPAY_PAY_URL : WXP_PAY_URL,
      }))
    }
    const provider = createVmqfoxProvider(liveConfig, { http, now: () => FROZEN_NOW })
    const wechat = await provider.createPayment(createInput())
    expect(wechat.status).toBe('requires_action')
    expect(wechat.action).toEqual({
      type: 'qr_code',
      content: WXP_PAY_URL,
      display: 'text',
      expiresAt: QR_EXPIRES_AT,
    })
    expect(wechat.amountMinor).toBe(1001n)
    expect(wechat.providerPaymentId).toBe(ATTEMPT_ID)
    expect(wechat.providerOrderId).toBe(TOKEN)
    expect(JSON.stringify(wechat.action)).not.toContain('pay.snowvictor.com')

    const alipay = await provider.createPayment(createInput({ paymentMethod: 'alipay' }))
    expect(alipay.action).toEqual({
      type: 'qr_code',
      content: ALIPAY_PAY_URL,
      display: 'text',
      expiresAt: QR_EXPIRES_AT,
    })
    expect(alipay.amountMinor).toBe(1001n)
    expect(seen.some(entry => entry.includes('/api/order/get/'))).toBe(false)

    const capabilities = await provider.getCapabilities({
      providerAccountKey: 'vmqfox-primary',
      environment: 'live',
      currency: 'CNY',
      paymentMethod: 'wechat',
    })
    expect(capabilities.supportsRefunds).toBe(false)
    expect(capabilities.supportsPartialRefund).toBe(false)
    expect(capabilities.supportsDisputes).toBe(false)
    expect(capabilities.supportsReconciliation).toBe(false)
    expect(capabilities.supportsBuyerApprovalCapture).toBe(false)
    expect(capabilities.actionTypes).toEqual(['qr_code'])
    expect(capabilities.capabilityVersion).toBe('vmqfox-v3-native-qr')
    expect(VMQFOX_CAPABILITY_VERSION).toBe('vmqfox-v3-native-qr')
    expect(capabilities.minimumAmountMinor).toBe(100n)
    expect(capabilities.maximumAmountMinor).toBe(100_000n)
  })

  it('never falls back to redirect when create payUrl fails allowlist', async () => {
    let queried = 0
    let got = 0
    const http: VmqfoxHttp = async req => {
      if (req.url.includes('/api/order/create')) {
        return envelope(createData({
          payUrl: REDIRECT,
          redirectUrl: REDIRECT,
        }))
      }
      if (req.url.includes('query-by-pay-id')) {
        queried += 1
        const params = new URLSearchParams(req.body)
        expect(params.get('payId')).toBe(ATTEMPT_ID)
        expect(queryByPayIdSignV2({
          payId: params.get('payId')!,
          timestamp: params.get('t')!,
        }, VECTOR_KEY)).toBe(params.get('sign'))
        return envelope(queryData({ status: 0 }))
      }
      if (req.url.includes('/api/order/get/')) {
        got += 1
        expect(req.method).toBe('GET')
        expect(req.url).toBe(`${VMQFOX_RECOMMENDED_ORIGIN}/api/order/get/${TOKEN}`)
        expect(req.url).not.toMatch(/[?&]sign=/)
        expect(req.body).toBeUndefined()
        return envelope(getOrderData())
      }
      throw new Error(`unexpected ${req.url}`)
    }
    const provider = createVmqfoxProvider(liveConfig, { http, now: () => FROZEN_NOW })
    const created = await provider.createPayment(createInput())
    expect(queried).toBe(1)
    expect(got).toBe(1)
    expect(created.status).toBe('requires_action')
    expect(created.action).toEqual({
      type: 'qr_code',
      content: WXP_PAY_URL,
      display: 'text',
      expiresAt: QR_EXPIRES_AT,
    })
    expect(created.providerPaymentId).toBe(ATTEMPT_ID)
    expect(created.providerOrderId).toBe(TOKEN)
    expect(created.amountMinor).toBe(1001n)
  })

  it('binds payId after a successful create when query-by-pay-id recovery misses without redirecting', async () => {
    const http: VmqfoxHttp = async req => {
      if (req.url.includes('/api/order/create')) {
        return envelope(createData({ payUrl: 'javascript:alert(1)' }))
      }
      if (req.url.includes('query-by-pay-id')) {
        return errorEnvelope(400, '订单不存在')
      }
      throw new Error(`unexpected ${req.url}`)
    }
    const provider = createVmqfoxProvider(liveConfig, { http })
    const created = await provider.createPayment(createInput())
    expect(created.status).toBe('unknown')
    expect(created.providerPaymentId).toBe(ATTEMPT_ID)
    expect(created.providerOrderId).toBe(TOKEN)
    expect(created.amountMinor).toBe(1001n)
    expect(created.action.type).toBe('none')
  })

  it('does not redirect when create omits payUrl and redirectUrl is still the snowvictor checkout URL', async () => {
    const http: VmqfoxHttp = async req => {
      if (req.url.includes('/api/order/create')) {
        const { payUrl: _omitPayUrl, ...rest } = createData({ redirectUrl: REDIRECT })
        expect(_omitPayUrl).toBe(WXP_PAY_URL)
        expect(isAllowedCheckoutRedirect(REDIRECT, VMQFOX_ORIGIN_ALLOWLIST)).toBe(true)
        expect(rest).not.toHaveProperty('payUrl')
        expect(rest.redirectUrl).toBe(REDIRECT)
        return envelope(rest)
      }
      if (req.url.includes('query-by-pay-id')) {
        return errorEnvelope(400, '订单不存在')
      }
      throw new Error(`unexpected ${req.url}`)
    }
    const provider = createVmqfoxProvider(liveConfig, { http })
    const created = await provider.createPayment(createInput())
    expect(created.action.type).not.toBe('redirect')
    expect(created.action.type).toBe('none')
    expect(created.status).toBe('unknown')
    const serializedAction = JSON.stringify(created.action)
    expect(serializedAction).not.toContain('pay.snowvictor.com')
    expect(serializedAction).not.toContain(REDIRECT)
    if ('content' in created.action) {
      expect(String(created.action.content)).not.toContain('pay.snowvictor.com')
    }
    if ('url' in created.action) {
      expect(String(created.action.url)).not.toContain('pay.snowvictor.com')
    }
  })

  it('maps remote states -1/0/1/2', async () => {
    expect(mapVmqfoxState(-1)).toBe('cancelled')
    expect(mapVmqfoxState(0)).toBe('processing')
    expect(mapVmqfoxState(1)).toBe('succeeded')
    expect(mapVmqfoxState(2)).toBe('succeeded')
    const http: VmqfoxHttp = async req => {
      if (req.url.includes('query-by-pay-id')) {
        return envelope({
          status: 2,
          publicToken: TOKEN,
          type: 1,
          price: '10.00',
          reallyPrice: '10.01',
          createdAt: 1,
          paidAt: 2,
          closedAt: 0,
        })
      }
      throw new Error(`unexpected ${req.url}`)
    }
    const provider = createVmqfoxProvider(liveConfig, { http })
    const queried = await provider.queryPayment({
      providerPaymentId: ATTEMPT_ID,
      providerAccountKey: 'vmqfox-primary',
    })
    expect(queried.status).toBe('succeeded')
    expect(queried.amountMinor).toBe(1001n)
    expect(queried.quotedAmountMinor).toBe(1000n)

    const tokenHttp: VmqfoxHttp = async req => {
      if (req.url.includes('/api/order/get/')) {
        expect(req.method).toBe('GET')
        expect(req.url).toBe(`${VMQFOX_RECOMMENDED_ORIGIN}/api/order/get/${TOKEN}`)
        return envelope(getOrderData({ state: 2 }))
      }
      if (req.url.includes('/api/order/check/')) {
        return envelope({ state: 2, remainingSeconds: 0 })
      }
      throw new Error(`unexpected ${req.url}`)
    }
    const tokenProvider = createVmqfoxProvider(liveConfig, { http: tokenHttp })
    const byToken = await tokenProvider.queryPayment({
      providerPaymentId: ATTEMPT_ID,
      providerAccountKey: 'vmqfox-primary',
      providerOrderId: TOKEN,
    })
    expect(byToken.status).toBe('succeeded')
    expect(byToken.amountMinor).toBe(1001n)

    const missingPayUrlHttp: VmqfoxHttp = async req => {
      if (req.url.includes('/api/order/get/')) {
        return envelope({
          payId: ATTEMPT_ID,
          payType: 1,
          price: '10.00',
          reallyPrice: '10.01',
          state: 0,
        })
      }
      if (req.url.includes('/api/order/check/')) {
        return envelope({ state: 0 })
      }
      throw new Error(`unexpected ${req.url}`)
    }
    const missingPayUrlProvider = createVmqfoxProvider(liveConfig, { http: missingPayUrlHttp })
    await expect(missingPayUrlProvider.queryPayment({
      providerPaymentId: ATTEMPT_ID,
      providerAccountKey: 'vmqfox-primary',
      providerOrderId: TOKEN,
    })).rejects.toMatchObject({ code: 'PAYMENT_STATE_UNKNOWN' })

    const closedPaid = await provider.closePayment({
      providerPaymentId: ATTEMPT_ID,
      providerAccountKey: 'vmqfox-primary',
      requestIdempotencyKey: 'close-1',
    })
    expect(closedPaid.status).toBe('succeeded')
  })

  it('fails deterministically on monitor_offline', async () => {
    const http: VmqfoxHttp = async () => errorEnvelope(400, '监控端状态异常，请检查')
    const provider = createVmqfoxProvider(liveConfig, { http })
    await expect(provider.createPayment(createInput())).rejects.toMatchObject({
      code: 'PAYMENT_PROVIDER_UNAVAILABLE',
      status: 409,
    })
  })

  it('treats malformed and timeout as unknown and recovers via query-by-pay-id then GET without a second payId', async () => {
    let creates = 0
    const http: VmqfoxHttp = async req => {
      if (req.url.includes('/api/order/create')) {
        creates += 1
        return { status: 200, headers: {}, body: 'not-json' }
      }
      if (req.url.includes('query-by-pay-id')) {
        const params = new URLSearchParams(req.body)
        expect(params.get('payId')).toBe(ATTEMPT_ID)
        return envelope(queryData())
      }
      if (req.url.includes('/api/order/get/')) {
        expect(req.method).toBe('GET')
        expect(req.url).toBe(`${VMQFOX_RECOMMENDED_ORIGIN}/api/order/get/${TOKEN}`)
        return envelope(getOrderData())
      }
      throw new Error(`unexpected ${req.url}`)
    }
    const provider = createVmqfoxProvider(liveConfig, { http, now: () => FROZEN_NOW })
    const created = await provider.createPayment(createInput())
    expect(created.status).toBe('requires_action')
    expect(created.action).toEqual({
      type: 'qr_code',
      content: WXP_PAY_URL,
      display: 'text',
      expiresAt: QR_EXPIRES_AT,
    })
    expect(created.providerPaymentId).toBe(ATTEMPT_ID)
    expect(created.providerOrderId).toBe(TOKEN)
    expect(created.amountMinor).toBe(1001n)
    expect(creates).toBe(1)
  })

  it('recovers create timeout via signed query-by-pay-id then unsigned GET using the original payId and publicToken', async () => {
    let creates = 0
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never)
    const http: VmqfoxHttp = async req => {
      if (req.url.includes('/api/order/create')) {
        creates += 1
        throw Object.assign(new Error('vmqfox request timed out'), { name: 'AbortError' })
      }
      if (req.url.includes('query-by-pay-id')) {
        const params = new URLSearchParams(req.body)
        expect(params.get('payId')).toBe(ATTEMPT_ID)
        expect(params.get('sign')).toBe(queryByPayIdSignV2({
          payId: ATTEMPT_ID,
          timestamp: params.get('t')!,
        }, VECTOR_KEY))
        return envelope(queryData({
          type: 1,
          price: '10.00',
          reallyPrice: '10.01',
          publicToken: TOKEN,
        }))
      }
      if (req.url.includes('/api/order/get/')) {
        expect(req.method).toBe('GET')
        expect(req.url).toBe(`${VMQFOX_RECOMMENDED_ORIGIN}/api/order/get/${TOKEN}`)
        expect(req.url).not.toMatch(/[?&]sign=/)
        expect(req.body).toBeUndefined()
        return envelope(getOrderData({
          payId: ATTEMPT_ID,
          payType: 1,
          price: '10.00',
          reallyPrice: '10.01',
          payUrl: WXP_PAY_URL,
        }))
      }
      throw new Error(`unexpected ${req.url}`)
    }
    try {
      const provider = createVmqfoxProvider(liveConfig, { http, now: () => FROZEN_NOW })
      const created = await provider.createPayment(createInput())
      expect(created.status).toBe('requires_action')
      expect(created.action).toEqual({
        type: 'qr_code',
        content: WXP_PAY_URL,
        display: 'text',
        expiresAt: QR_EXPIRES_AT,
      })
      expect(created.providerPaymentId).toBe(ATTEMPT_ID)
      expect(created.providerOrderId).toBe(TOKEN)
      expect(creates).toBe(1)
      const loggedPaths = info.mock.calls
        .map(call => (call[0] as { path?: string } | undefined)?.path)
        .filter((path): path is string => typeof path === 'string')
      expect(loggedPaths).toContain('/api/order/get/:token')
      expect(loggedPaths.some(path => path.includes(TOKEN))).toBe(false)
    } finally {
      info.mockRestore()
    }
  })

  it('recovers alipay create timeout via signed query-by-pay-id then GET with ALIPAY_PAY_URL', async () => {
    let creates = 0
    const http: VmqfoxHttp = async req => {
      if (req.url.includes('/api/order/create')) {
        creates += 1
        throw Object.assign(new Error('vmqfox request timed out'), { name: 'AbortError' })
      }
      if (req.url.includes('query-by-pay-id')) {
        const params = new URLSearchParams(req.body)
        expect(params.get('payId')).toBe(ATTEMPT_ID)
        expect(params.get('sign')).toBe(queryByPayIdSignV2({
          payId: ATTEMPT_ID,
          timestamp: params.get('t')!,
        }, VECTOR_KEY))
        return envelope(queryData({
          type: 2,
          price: '10.00',
          reallyPrice: '10.01',
          publicToken: TOKEN,
        }))
      }
      if (req.url.includes('/api/order/get/')) {
        expect(req.method).toBe('GET')
        expect(req.url).toBe(`${VMQFOX_RECOMMENDED_ORIGIN}/api/order/get/${TOKEN}`)
        expect(req.url).not.toMatch(/[?&]sign=/)
        expect(req.body).toBeUndefined()
        return envelope(getOrderData({
          payId: ATTEMPT_ID,
          payType: 2,
          price: '10.00',
          reallyPrice: '10.01',
          payUrl: ALIPAY_PAY_URL,
        }))
      }
      throw new Error(`unexpected ${req.url}`)
    }
    const provider = createVmqfoxProvider(liveConfig, { http, now: () => FROZEN_NOW })
    const created = await provider.createPayment(createInput({ paymentMethod: 'alipay' }))
    expect(created.status).toBe('requires_action')
    expect(created.action).toEqual({
      type: 'qr_code',
      content: ALIPAY_PAY_URL,
      display: 'text',
      expiresAt: QR_EXPIRES_AT,
    })
    expect(created.providerPaymentId).toBe(ATTEMPT_ID)
    expect(created.providerOrderId).toBe(TOKEN)
    expect(created.amountMinor).toBe(1001n)
    expect(creates).toBe(1)
    expect(JSON.stringify(created.action)).not.toContain('pay.snowvictor.com')
  })

  it('recovers duplicate_order via query-by-pay-id using the original payId', async () => {
    let creates = 0
    const http: VmqfoxHttp = async req => {
      if (req.url.includes('/api/order/create')) {
        creates += 1
        return errorEnvelope(409, '创建订单冲突')
      }
      if (req.url.includes('query-by-pay-id')) {
        return envelope(queryData({ status: 2 }))
      }
      if (req.url.includes('/api/order/get/')) {
        return envelope(getOrderData({ state: 2 }))
      }
      throw new Error(`unexpected ${req.url}`)
    }
    const provider = createVmqfoxProvider(liveConfig, { http, now: () => FROZEN_NOW })
    const created = await provider.createPayment(createInput())
    expect(created.status).toBe('requires_action')
    expect(created.action.type).toBe('qr_code')
    if (created.action.type === 'qr_code') {
      expect(created.action.content).toBe(WXP_PAY_URL)
      expect(created.action.display).toBe('text')
    }
    expect(created.providerPaymentId).toBe(ATTEMPT_ID)
    expect(creates).toBe(1)
  })

  it('treats GET field mismatch or illegal recovered payUrl as unknown and never redirects', async () => {
    const mismatchHttp: VmqfoxHttp = async req => {
      if (req.url.includes('/api/order/create')) {
        return { status: 200, headers: {}, body: 'not-json' }
      }
      if (req.url.includes('query-by-pay-id')) {
        return envelope(queryData())
      }
      if (req.url.includes('/api/order/get/')) {
        return envelope(getOrderData({ payId: 'other-pay-id' }))
      }
      throw new Error(`unexpected ${req.url}`)
    }
    const illegalPayUrlHttp: VmqfoxHttp = async req => {
      if (req.url.includes('/api/order/create')) {
        return { status: 200, headers: {}, body: 'not-json' }
      }
      if (req.url.includes('query-by-pay-id')) {
        return envelope(queryData())
      }
      if (req.url.includes('/api/order/get/')) {
        return envelope(getOrderData({ payUrl: REDIRECT }))
      }
      throw new Error(`unexpected ${req.url}`)
    }
    const mismatchProvider = createVmqfoxProvider(liveConfig, { http: mismatchHttp })
    await expect(mismatchProvider.createPayment(createInput())).rejects.toMatchObject({
      code: 'PAYMENT_STATE_UNKNOWN',
    })
    const illegalProvider = createVmqfoxProvider(liveConfig, { http: illegalPayUrlHttp })
    await expect(illegalProvider.createPayment(createInput())).rejects.toMatchObject({
      code: 'PAYMENT_STATE_UNKNOWN',
    })
  })

  it.each([
    {
      name: 'wechat recovery GET returning ALIPAY_PAY_URL',
      paymentMethod: 'wechat' as const,
      queryType: 1,
      getPayType: 1,
      recoveredPayUrl: ALIPAY_PAY_URL,
    },
    {
      name: 'alipay recovery GET returning WXP_PAY_URL',
      paymentMethod: 'alipay' as const,
      queryType: 2,
      getPayType: 2,
      recoveredPayUrl: WXP_PAY_URL,
    },
  ])('treats $name as PAYMENT_STATE_UNKNOWN, not a QR for the wrong method', async ({
    paymentMethod,
    queryType,
    getPayType,
    recoveredPayUrl,
  }) => {
    const http: VmqfoxHttp = async req => {
      if (req.url.includes('/api/order/create')) {
        return { status: 200, headers: {}, body: 'not-json' }
      }
      if (req.url.includes('query-by-pay-id')) {
        return envelope(queryData({ type: queryType }))
      }
      if (req.url.includes('/api/order/get/')) {
        return envelope(getOrderData({
          payType: getPayType,
          payUrl: recoveredPayUrl,
        }))
      }
      throw new Error(`unexpected ${req.url}`)
    }
    const provider = createVmqfoxProvider(liveConfig, { http, now: () => FROZEN_NOW })
    await expect(provider.createPayment(createInput({ paymentMethod }))).rejects.toMatchObject({
      code: 'PAYMENT_STATE_UNKNOWN',
    })
  })

  it('keeps rate-limited create retryable without minting a second payId', async () => {
    let creates = 0
    const http: VmqfoxHttp = async req => {
      if (req.url.includes('/api/order/create')) {
        creates += 1
        return errorEnvelope(429, '请求过于频繁，请稍后重试', 429)
      }
      if (req.url.includes('query-by-pay-id')) {
        return errorEnvelope(400, '订单不存在')
      }
      throw new Error(`unexpected ${req.url}`)
    }
    const provider = createVmqfoxProvider(liveConfig, { http })
    await expect(provider.createPayment(createInput())).rejects.toMatchObject({ code: 'PAYMENT_STATE_UNKNOWN' })
    expect(creates).toBe(1)
  })

  it('maps closePayment pending to processing and cancelled to cancelled', async () => {
    const http: VmqfoxHttp = async req => {
      if (!req.url.includes('query-by-pay-id')) throw new Error(req.url)
      const params = new URLSearchParams(req.body)
      const status = params.get('payId') === ATTEMPT_ID ? 0 : -1
      return envelope({
        status,
        publicToken: TOKEN,
        type: 1,
        price: '10.00',
        reallyPrice: '10.01',
      })
    }
    const provider = createVmqfoxProvider(liveConfig, { http })
    const pending = await provider.closePayment({
      providerPaymentId: ATTEMPT_ID,
      providerAccountKey: 'vmqfox-primary',
      requestIdempotencyKey: 'close-pending',
    })
    expect(pending.status).toBe('processing')
  })

  it('throws PAYMENT_REFUND_NOT_SUPPORTED and cannot initiate a provider refund', async () => {
    const provider = createVmqfoxProvider(liveConfig, { http: async () => envelope({}) })
    await expect(provider.createRefund({
      providerPaymentId: ATTEMPT_ID,
      providerAccountKey: 'vmqfox-primary',
      amountMinor: 1000n,
      currency: 'CNY',
      requestIdempotencyKey: 'refund-1',
    })).rejects.toMatchObject({ code: 'PAYMENT_REFUND_NOT_SUPPORTED' })
  })
})

describe('VMQFox webhook', () => {
  it('verifies a signed callback and rejects tampered price/reallyPrice', () => {
    const provider = createVmqfoxProvider(liveConfig, { http: async () => envelope({}) })
    const raw = signedCallback({
      payId: ATTEMPT_ID,
      param: ORDER_ID,
      type: '1',
      price: '10.00',
      reallyPrice: '10.01',
    })
    return provider.verifyAndNormalizeWebhook({ headers: {}, rawBody: raw }).then(async event => {
      expect(event.signatureVerified).toBe(true)
      expect(event.payment?.status).toBe('succeeded')
      expect(event.payment?.amountMinor).toBe(1001n)
      expect(event.payment?.quotedAmountMinor).toBe(1000n)
      expect(event.payment?.quotedOrderId).toBe(ORDER_ID)
      expect(event.dedupeKey).toBe(vmqfoxPaidDedupeKey({
        accountKey: 'vmqfox-primary',
        payId: ATTEMPT_ID,
        type: '1',
        price: '10.00',
        reallyPrice: '10.01',
      }))

      const tamperedPrice = signedCallback({
        payId: ATTEMPT_ID, param: ORDER_ID, type: '1', price: '10.00', reallyPrice: '10.01',
      })
      const params = new URLSearchParams(tamperedPrice.toString('utf8'))
      params.set('reallyPrice', '9.99')
      const failed = await verifyAndNormalizeNotify(liveConfig, Buffer.from(params.toString(), 'utf8'))
      expect(failed.signatureVerified).toBe(false)
      expect(failed.payment).toBeNull()
    })
  })

  it('ACKs with the exact UTF-8 bytes of success and never JSON', async () => {
    expect(VMQFOX_WEBHOOK_SUCCESS_BODY).toBe('success')
    expect(Buffer.from(VMQFOX_WEBHOOK_SUCCESS_BODY, 'utf8').equals(Buffer.from([0x73, 0x75, 0x63, 0x63, 0x65, 0x73, 0x73]))).toBe(true)

    const provider = createVmqfoxProvider(liveConfig, { http: async () => envelope({}) })
    const spy = vi.spyOn(registry, 'getRegisteredProvider').mockImplementation(name => {
      return name === 'vmqfox' ? provider : undefined
    })
    const app = express()
    app.use(createPaymentWebhookRouter())
    const raw = signedCallback({
      payId: ATTEMPT_ID,
      param: ORDER_ID,
      type: '1',
      price: '10.00',
      reallyPrice: '10.01',
    })
    try {
      const res = await request(app)
        .post('/vmqfox')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(raw.toString('utf8'))
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toMatch(/text\/plain/)
      expect(res.text).toBe('success')
      expect(Buffer.from(res.text, 'utf8').equals(Buffer.from('success'))).toBe(true)
      expect(res.text.startsWith('{')).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('VMQFox PostgreSQL duplicate callback', () => {
  it('credits 1000 points once for quote 1000 / reallyPrice 1001 across 100 callbacks', async () => {
    const { user } = await createTestUser(`vmqfox-dup-${randomUUID()}@test.local`, 'pass12345', 'user', 5000)
    const policy = await prisma.rechargePricePolicy.create({
      data: {
        code: `rp-vmqfox-${randomUUID()}`,
        version: Math.floor(Math.random() * 1_000_000) + 1,
        currency: 'CNY',
        currencyScale: 2,
        pointsNumerator: 1n,
        pointsDenominator: 1n,
        roundingMode: 'HALF_EVEN',
        minAmountMinor: 100n,
        maxAmountMinor: 100_000n,
        amountStepMinor: 100n,
        dailyLimitMinor: 200_000n,
        monthlyLimitMinor: 1_000_000n,
        limitTimeZone: 'Asia/Shanghai',
        status: 'active',
        effectiveAt: new Date(),
      },
    })
    const quote = await prisma.rechargeQuote.create({
      data: {
        userId: user.id,
        pricePolicyId: policy.id,
        provider: 'vmqfox',
        paymentMethod: 'wechat',
        providerAccountKey: 'vmqfox-primary',
        capabilityVersion: 'vmqfox-v2',
        capabilityDigest: createHash('sha256').update('vmqfox-test').digest('hex'),
        currency: 'CNY',
        amountMinor: 1000n,
        effectiveMinAmountMinor: 100n,
        effectiveMaxAmountMinor: 100_000n,
        basePoints: 1000n,
        bonusPoints: 0n,
        totalPoints: 1000n,
        amountSource: 'custom',
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    const order = await prisma.rechargeOrder.create({
      data: {
        userId: user.id,
        quoteId: quote.id,
        pricePolicyId: policy.id,
        currency: 'CNY',
        amountMinor: 1000n,
        basePoints: 1000n,
        bonusPoints: 0n,
        totalPoints: 1000n,
        pricePolicyCode: policy.code,
        pricePolicyVersion: policy.version,
        pointsNumerator: 1n,
        pointsDenominator: 1n,
        roundingMode: 'HALF_EVEN',
        currencyScale: 2,
        amountSource: 'custom',
        provider: 'vmqfox',
        paymentMethod: 'wechat',
        providerAccountKey: 'vmqfox-primary',
        capabilityVersion: 'vmqfox-v2',
        capabilityDigest: quote.capabilityDigest,
        effectiveMinAmountMinor: 100n,
        effectiveMaxAmountMinor: 100_000n,
        disclosureVersion: 'recharge-disclosure-v1',
        status: 'pending_payment',
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    const intent = await prisma.paymentIntent.create({
      data: {
        rechargeOrderId: order.id,
        amountMinor: 1000n,
        currency: 'CNY',
        status: 'processing',
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    const attempt = await prisma.paymentAttempt.create({
      data: {
        paymentIntentId: intent.id,
        provider: 'vmqfox',
        providerAccountKey: 'vmqfox-primary',
        method: 'wechat',
        status: 'requires_action',
        requestIdempotencyKey: `recharge:${order.id}:attempt:v1`,
        actionType: 'redirect',
        expectedProviderAmountMinor: 1001n,
      },
    })
    await prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: { providerPaymentId: attempt.id },
    })
    await prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { activeAttemptId: attempt.id },
    })

    const provider = createVmqfoxProvider(liveConfig, { http: async () => envelope({}) })
    const raw = signedCallback({
      payId: attempt.id,
      param: order.id,
      type: '1',
      price: '10.00',
      reallyPrice: '10.01',
    })
    const event = await provider.verifyAndNormalizeWebhook({ headers: {}, rawBody: raw })
    expect(event.signatureVerified).toBe(true)
    const payload = {
      status: event.payment!.status,
      providerPaymentId: event.payment!.providerPaymentId,
      providerCaptureId: event.payment!.providerCaptureId ?? null,
      amountMinor: serializeAmountMinor(event.payment!.amountMinor),
      quotedAmountMinor: serializeAmountMinor(event.payment!.quotedAmountMinor!),
      quotedOrderId: event.payment!.quotedOrderId,
      quotedPaymentMethod: event.payment!.quotedPaymentMethod,
      currency: event.payment!.currency,
      immutableStateVersion: event.payment!.immutableStateVersion,
    }

    for (let i = 0; i < 100; i += 1) {
      const recorded = await recordPaymentObservation({
        provider: 'vmqfox',
        providerAccountKey: 'vmqfox-primary',
        source: 'webhook',
        verificationMethod: 'webhook_signature',
        paymentAttemptId: attempt.id,
        providerPaymentId: attempt.id,
        providerEventId: null,
        dedupeKey: event.dedupeKey,
        eventType: event.eventType,
        payloadSha256: hashNormalizedPayload(payload),
        normalizedPayload: payload,
        signatureVerified: true,
      })
      await applyConfirmedPayment(recorded.id)
    }

    expect(await prisma.rechargeCredit.count({ where: { rechargeOrderId: order.id } })).toBe(1)
    const credit = await prisma.rechargeCredit.findFirstOrThrow({ where: { rechargeOrderId: order.id } })
    expect(credit.points).toBe(1000n)
    const account = await prisma.pointAccount.findUniqueOrThrow({ where: { userId: user.id } })
    expect(account.balance).toBe(6000)
    expect(await prisma.paymentEvent.count({ where: { provider: 'vmqfox', dedupeKey: event.dedupeKey } })).toBe(1)
  })
})
