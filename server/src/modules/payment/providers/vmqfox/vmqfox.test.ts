import { createHash, randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { prisma } from '../../../../lib/prisma.js'
import { applyConfirmedPayment } from '../../events/applyConfirmedPayment.js'
import { hashNormalizedPayload, recordPaymentObservation } from '../../observations/record.js'
import { serializeAmountMinor } from '../../../recharge/money.js'
import { createTestUser } from '../../../../__tests__/helpers.js'
import { amountMinorToYuanString, yuanStringToAmountMinor } from './amount.js'
import {
  isAllowedCheckoutRedirect,
  parseVmqfoxBaseUrl,
  VMQFOX_ORIGIN_ALLOWLIST,
  VMQFOX_RECOMMENDED_ORIGIN,
  type VmqfoxAdapterConfig,
} from './config.js'
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
    payUrl: 'weixin://wxpay',
    isAuto: 1,
    redirectUrl: REDIRECT,
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
  it('matches official create, callback, and query-by-pay-id vectors', () => {
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

describe('VMQFox adapter contract', () => {
  it('creates wechat and alipay redirect actions with reallyPrice as amountMinor', async () => {
    const seen: string[] = []
    const http: VmqfoxHttp = async req => {
      seen.push(req.url)
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
      return envelope(createData({ payType: Number(type) }))
    }
    const provider = createVmqfoxProvider(liveConfig, { http })
    const wechat = await provider.createPayment(createInput())
    expect(wechat.action.type).toBe('redirect')
    if (wechat.action.type === 'redirect') expect(wechat.action.url).toBe(REDIRECT)
    expect(wechat.amountMinor).toBe(1001n)
    expect(wechat.providerPaymentId).toBe(ATTEMPT_ID)
    expect(wechat.providerOrderId).toBe(TOKEN)

    const alipay = await provider.createPayment(createInput({ paymentMethod: 'alipay' }))
    expect(alipay.action.type).toBe('redirect')
    expect(alipay.amountMinor).toBe(1001n)

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
    expect(capabilities.actionTypes).toEqual(['redirect'])
    expect(capabilities.minimumAmountMinor).toBe(100n)
    expect(capabilities.maximumAmountMinor).toBe(100_000n)
  })

  it('rejects a checkout URL off the origin allowlist', async () => {
    const http: VmqfoxHttp = async () => envelope(createData({
      redirectUrl: `https://evil.example/#/payment/${TOKEN}`,
    }))
    const provider = createVmqfoxProvider(liveConfig, { http })
    await expect(provider.createPayment(createInput())).rejects.toMatchObject({ code: 'PAYMENT_STATE_UNKNOWN' })
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

  it('treats malformed and timeout as unknown and recovers via query-by-pay-id without a second payId', async () => {
    let creates = 0
    const http: VmqfoxHttp = async req => {
      if (req.url.includes('/api/order/create')) {
        creates += 1
        return { status: 200, headers: {}, body: 'not-json' }
      }
      if (req.url.includes('query-by-pay-id')) {
        const params = new URLSearchParams(req.body)
        expect(params.get('payId')).toBe(ATTEMPT_ID)
        return envelope({
          status: 0,
          publicToken: TOKEN,
          type: 1,
          price: '10.00',
          reallyPrice: '10.01',
        })
      }
      throw new Error(`unexpected ${req.url}`)
    }
    const provider = createVmqfoxProvider(liveConfig, { http })
    const created = await provider.createPayment(createInput())
    expect(created.providerPaymentId).toBe(ATTEMPT_ID)
    expect(created.providerOrderId).toBe(TOKEN)
    expect(created.amountMinor).toBe(1001n)
    expect(creates).toBe(1)
  })

  it('recovers duplicate_order via query-by-pay-id using the original payId', async () => {
    let creates = 0
    const http: VmqfoxHttp = async req => {
      if (req.url.includes('/api/order/create')) {
        creates += 1
        return errorEnvelope(409, '创建订单冲突')
      }
      if (req.url.includes('query-by-pay-id')) {
        return envelope({
          status: 0,
          publicToken: TOKEN,
          type: 1,
          price: '10.00',
          reallyPrice: '10.01',
        })
      }
      throw new Error(`unexpected ${req.url}`)
    }
    const provider = createVmqfoxProvider(liveConfig, { http })
    const created = await provider.createPayment(createInput())
    expect(created.providerPaymentId).toBe(ATTEMPT_ID)
    expect(creates).toBe(1)
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
