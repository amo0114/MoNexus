import { describe, expect, it } from 'vitest'
import { HttpError } from '../../../../lib/httpError.js'
import { hashNormalizedPayload, recordPaymentObservation } from '../../observations/record.js'
import { serializeAmountMinor } from '../../../recharge/money.js'
import {
  buildAuthorizationHeader,
  buildRequestSignMessage,
  buildResponseSignMessage,
  decryptAesGcm,
  encryptAesGcm,
  rsaSha256Sign,
  rsaSha256Verify,
  WECHATPAY_SIGN_TEST_PREFIX,
} from './crypto.js'
import {
  OFFICIAL_DOC_APPID,
  OFFICIAL_DOC_CODE_URL,
  OFFICIAL_DOC_OUT_TRADE_NO,
  OFFICIAL_DOC_TRANSACTION_ID,
  OFFICIAL_JAVA_AES_AAD,
  OFFICIAL_JAVA_AES_CIPHERTEXT,
  OFFICIAL_JAVA_AES_MESSAGE,
  OFFICIAL_JAVA_AES_NONCE,
  OFFICIAL_JAVA_API_V3_KEY,
  OFFICIAL_JAVA_MERCHANT_CERTIFICATE,
  OFFICIAL_JAVA_MERCHANT_ID,
  OFFICIAL_JAVA_MERCHANT_PRIVATE_KEY,
  OFFICIAL_JAVA_MERCHANT_SERIAL,
  OFFICIAL_JAVA_PLATFORM_PRIVATE_KEY,
  OFFICIAL_JAVA_PLATFORM_PUBLIC_KEY,
  OFFICIAL_JAVA_PLATFORM_SERIAL,
  OFFICIAL_NATIVE_REQUEST_BODY,
  OFFICIAL_REQUEST_NONCE,
  OFFICIAL_REQUEST_TIMESTAMP,
  OFFICIAL_SUCCESS_REFUND,
  OFFICIAL_SUCCESS_TRANSACTION,
  WECHAT_PAY_NOTIFY_MAX_ATTEMPTS,
  WECHAT_PAY_NOTIFY_RETRY_SCHEDULE,
} from './fixtures.js'
import { createWechatPayProvider, toOutTradeNo, wechatPayWebhookSuccessAck } from './index.js'
import { OUT_TRADE_NO_PATTERN } from './mapping.js'
import { wechatPayAccountKey, type WechatPayCredentials } from './credentials.js'
import type { WechatPayHttp, WechatPayHttpRequest, WechatPayHttpResponse } from './client.js'

const NOW = new Date('2026-01-15T08:00:00.000Z')
const ACCOUNT_KEY = wechatPayAccountKey(OFFICIAL_JAVA_MERCHANT_ID)

function fixtureCredentials(): WechatPayCredentials {
  return {
    mchid: OFFICIAL_JAVA_MERCHANT_ID,
    appid: OFFICIAL_DOC_APPID,
    merchantSerialNo: OFFICIAL_JAVA_MERCHANT_SERIAL,
    merchantPrivateKeyPem: OFFICIAL_JAVA_MERCHANT_PRIVATE_KEY,
    apiV3Key: OFFICIAL_JAVA_API_V3_KEY,
    platformPublicKeyPem: OFFICIAL_JAVA_PLATFORM_PUBLIC_KEY,
    platformSerialNo: OFFICIAL_JAVA_PLATFORM_SERIAL,
    notifyUrl: 'https://shop.example.com/api/payment/webhooks/wechat-pay',
    apiBaseUrl: 'https://api.mch.weixin.qq.com',
  }
}

function signedPlatformHeaders(body: string, now = NOW): Record<string, string> {
  const timestamp = Math.floor(now.getTime() / 1000).toString()
  const nonce = 'D4PJYH8323444WUNiUs5O1jorgGif5ykEs'
  const signature = rsaSha256Sign(
    OFFICIAL_JAVA_PLATFORM_PRIVATE_KEY,
    buildResponseSignMessage(timestamp, nonce, body),
  )
  return {
    'Wechatpay-Timestamp': timestamp,
    'Wechatpay-Nonce': nonce,
    'Wechatpay-Signature': signature,
    'Wechatpay-Serial': OFFICIAL_JAVA_PLATFORM_SERIAL,
    'Wechatpay-Signature-Type': 'WECHATPAY2-SHA256-RSA2048',
  }
}

function jsonResponse(status: number, payload: unknown, now = NOW): WechatPayHttpResponse {
  const body = payload == null ? '' : JSON.stringify(payload)
  return { status, body, headers: signedPlatformHeaders(body, now) }
}

function signedNoContent(now = NOW): WechatPayHttpResponse {
  return { status: 204, body: '', headers: signedPlatformHeaders('', now) }
}

function createProvider(http: WechatPayHttp) {
  return createWechatPayProvider({
    credentials: fixtureCredentials(),
    http,
    now: () => NOW,
  })
}

function nativeCreateInput(overrides: Partial<Parameters<ReturnType<typeof createWechatPayProvider>['createPayment']>[0]> = {}) {
  return {
    orderId: '11111111-1111-1111-1111-111111111111',
    paymentIntentId: '22222222-2222-2222-2222-222222222222',
    paymentAttemptId: '33333333-3333-3333-3333-333333333333',
    amountMinor: 100n,
    currency: 'CNY' as const,
    paymentMethod: 'native',
    providerAccountKey: ACCOUNT_KEY,
    requestIdempotencyKey: 'recharge:11111111-1111-1111-1111-111111111111:attempt:1',
    ...overrides,
  }
}

describe('WeChat Pay APIv3 crypto fixtures', () => {
  it('decrypts the official wechatpay-java AES-256-GCM vector', () => {
    const plain = decryptAesGcm({
      apiV3Key: OFFICIAL_JAVA_API_V3_KEY,
      nonce: OFFICIAL_JAVA_AES_NONCE,
      ciphertextB64: OFFICIAL_JAVA_AES_CIPHERTEXT,
      associatedData: OFFICIAL_JAVA_AES_AAD,
    })
    expect(plain).toBe(OFFICIAL_JAVA_AES_MESSAGE)
  })

  it('rejects a tampered official AES ciphertext', () => {
    expect(() => decryptAesGcm({
      apiV3Key: OFFICIAL_JAVA_API_V3_KEY,
      nonce: OFFICIAL_JAVA_AES_NONCE,
      ciphertextB64: OFFICIAL_JAVA_AES_CIPHERTEXT.replace('u', 'v'),
      associatedData: OFFICIAL_JAVA_AES_AAD,
    })).toThrow()
  })

  it('signs a Native request with official merchant key and verifies with the merchant cert', () => {
    const message = buildRequestSignMessage(
      'POST',
      '/v3/pay/transactions/native',
      OFFICIAL_REQUEST_TIMESTAMP,
      OFFICIAL_REQUEST_NONCE,
      OFFICIAL_NATIVE_REQUEST_BODY,
    )
    const signature = rsaSha256Sign(OFFICIAL_JAVA_MERCHANT_PRIVATE_KEY, message)
    expect(rsaSha256Verify(OFFICIAL_JAVA_MERCHANT_CERTIFICATE, message, signature)).toBe(true)
    const authorization = buildAuthorizationHeader({
      mchid: OFFICIAL_JAVA_MERCHANT_ID,
      serialNo: OFFICIAL_JAVA_MERCHANT_SERIAL,
      privateKeyPem: OFFICIAL_JAVA_MERCHANT_PRIVATE_KEY,
      method: 'POST',
      urlPathAndQuery: '/v3/pay/transactions/native',
      body: OFFICIAL_NATIVE_REQUEST_BODY,
      timestamp: OFFICIAL_REQUEST_TIMESTAMP,
      nonce: OFFICIAL_REQUEST_NONCE,
    })
    expect(authorization.startsWith('WECHATPAY2-SHA256-RSA2048 ')).toBe(true)
    expect(authorization).toContain(`mchid="${OFFICIAL_JAVA_MERCHANT_ID}"`)
    expect(authorization).toContain(`serial_no="${OFFICIAL_JAVA_MERCHANT_SERIAL}"`)
  })

  it('rejects WeChat signature probe traffic', () => {
    const message = buildResponseSignMessage('1', 'n', '{}')
    expect(rsaSha256Verify(
      OFFICIAL_JAVA_PLATFORM_PUBLIC_KEY,
      message,
      `${WECHATPAY_SIGN_TEST_PREFIX}not-a-real-signature`,
    )).toBe(false)
  })
})

describe('out_trade_no and amount contract', () => {
  it('keeps out_trade_no stable, 6-32 chars, and within the official charset', () => {
    const key = 'recharge:11111111-1111-1111-1111-111111111111:attempt:1'
    const first = toOutTradeNo(key)
    const second = toOutTradeNo(key)
    expect(first).toBe(second)
    expect(first).toMatch(OUT_TRADE_NO_PATTERN)
    expect(first.length).toBeGreaterThanOrEqual(6)
    expect(first.length).toBeLessThanOrEqual(32)
    expect(toOutTradeNo(OFFICIAL_DOC_OUT_TRADE_NO)).toBe(OFFICIAL_DOC_OUT_TRADE_NO)
    expect(toOutTradeNo('33333333-3333-3333-3333-333333333333')).toBe('33333333333333333333333333333333')
  })

  it('rejects non-CNY, zero, and non-positive totals before calling WeChat', async () => {
    const http: WechatPayHttp = async () => {
      throw new Error('WeChat must not be called')
    }
    const provider = createProvider(http)
    await expect(provider.createPayment(nativeCreateInput({ currency: 'USD' }))).rejects.toBeInstanceOf(HttpError)
    await expect(provider.createPayment(nativeCreateInput({ amountMinor: 0n }))).rejects.toBeInstanceOf(HttpError)
    await expect(provider.createPayment(nativeCreateInput({ amountMinor: -1n }))).rejects.toBeInstanceOf(HttpError)
  })

  it('posts amount.total as a positive fen integer with currency CNY', async () => {
    let captured: WechatPayHttpRequest | null = null
    const http: WechatPayHttp = async request => {
      captured = request
      return jsonResponse(200, { code_url: OFFICIAL_DOC_CODE_URL })
    }
    const provider = createProvider(http)
    await provider.createPayment(nativeCreateInput({ amountMinor: 100n }))
    expect(captured).not.toBeNull()
    const body = JSON.parse(captured!.body) as { amount: { total: number; currency: string }; out_trade_no: string }
    expect(Number.isInteger(body.amount.total)).toBe(true)
    expect(body.amount.total).toBe(100)
    expect(body.amount.currency).toBe('CNY')
    expect(body.out_trade_no).toBe(toOutTradeNo(nativeCreateInput().requestIdempotencyKey))
    expect(captured!.headers.Authorization.startsWith('WECHATPAY2-SHA256-RSA2048 ')).toBe(true)
  })
})

describe('WeChat Pay adapter', () => {
  it('is disabled when credentials are missing', async () => {
    const provider = createWechatPayProvider({ credentials: null, now: () => NOW })
    await expect(provider.selectAccount({
      environment: 'live',
      currency: 'CNY',
      paymentMethod: 'native',
    })).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' })
  })

  it('does not invent a sandbox and rejects non-live environments', async () => {
    const provider = createProvider(async () => jsonResponse(200, {}))
    await expect(provider.selectAccount({
      environment: 'sandbox',
      currency: 'CNY',
      paymentMethod: 'native',
    })).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' })
  })

  it('creates a Native order and returns a qr_code action from code_url', async () => {
    const provider = createProvider(async request => {
      expect(request.method).toBe('POST')
      expect(request.pathAndQuery).toBe('/v3/pay/transactions/native')
      expect(request.url).toBe('https://api.mch.weixin.qq.com/v3/pay/transactions/native')
      const body = JSON.parse(request.body) as { mchid: string; appid: string; amount: { total: number } }
      expect(body.mchid).toBe(OFFICIAL_JAVA_MERCHANT_ID)
      expect(body.appid).toBe(OFFICIAL_DOC_APPID)
      expect(body.amount.total).toBeGreaterThan(0)
      return jsonResponse(200, { code_url: OFFICIAL_DOC_CODE_URL })
    })
    const created = await provider.createPayment(nativeCreateInput())
    expect(created.status).toBe('requires_action')
    expect(created.amountMinor).toBe(100n)
    expect(created.action).toMatchObject({
      type: 'qr_code',
      content: OFFICIAL_DOC_CODE_URL,
      display: 'text',
    })
    expect(created.providerPaymentId).toBe(toOutTradeNo(nativeCreateInput().requestIdempotencyKey))
  })

  it('queries and closes by out_trade_no without marking paid', async () => {
    const provider = createProvider(async request => {
      if (request.pathAndQuery.includes('/close')) {
        return signedNoContent()
      }
      return jsonResponse(200, OFFICIAL_SUCCESS_TRANSACTION)
    })
    const queried = await provider.queryPayment({
      providerPaymentId: OFFICIAL_DOC_OUT_TRADE_NO,
      providerAccountKey: ACCOUNT_KEY,
    })
    expect(queried.status).toBe('succeeded')
    expect(queried.amountMinor).toBe(100n)
    expect(queried.currency).toBe('CNY')
    expect(queried.providerPaymentId).toBe(OFFICIAL_DOC_OUT_TRADE_NO)
    expect(queried.providerOrderId).toBe(OFFICIAL_DOC_TRANSACTION_ID)

    const closed = await provider.closePayment({
      providerPaymentId: OFFICIAL_DOC_OUT_TRADE_NO,
      providerAccountKey: ACCOUNT_KEY,
      requestIdempotencyKey: 'close-1',
    })
    expect(closed.status).toBe('cancelled')
  })

  it('verifies a 204 close over the official empty-body sign message', async () => {
    const timestamp = Math.floor(NOW.getTime() / 1000).toString()
    const nonce = 'D4PJYH8323444WUNiUs5O1jorgGif5ykEs'
    expect(buildResponseSignMessage(timestamp, nonce, '')).toBe(`${timestamp}\n${nonce}\n\n`)
    const provider = createProvider(async () => signedNoContent())
    const closed = await provider.closePayment({
      providerPaymentId: OFFICIAL_DOC_OUT_TRADE_NO,
      providerAccountKey: ACCOUNT_KEY,
      requestIdempotencyKey: 'close-signed-204',
    })
    expect(closed.status).toBe('cancelled')
  })

  it('does not treat an unsigned or wrongly signed 204 close as cancelled', async () => {
    const unsigned = createProvider(async () => ({ status: 204, body: '', headers: {} }))
    await expect(unsigned.closePayment({
      providerPaymentId: OFFICIAL_DOC_OUT_TRADE_NO,
      providerAccountKey: ACCOUNT_KEY,
      requestIdempotencyKey: 'close-unsigned',
    })).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' })

    const wrongBody = createProvider(async () => ({
      status: 204,
      body: '',
      headers: signedPlatformHeaders('{"code":"SUCCESS"}'),
    }))
    await expect(wrongBody.closePayment({
      providerPaymentId: OFFICIAL_DOC_OUT_TRADE_NO,
      providerAccountKey: ACCOUNT_KEY,
      requestIdempotencyKey: 'close-wrong-body',
    })).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE' })
  })

  it('does not output succeeded when mchid/appid/amount/currency mismatch', async () => {
    const provider = createProvider(async () => jsonResponse(200, {
      ...OFFICIAL_SUCCESS_TRANSACTION,
      mchid: '0000000000',
      amount: { total: 1, currency: 'CNY' },
    }))
    const queried = await provider.queryPayment({
      providerPaymentId: OFFICIAL_DOC_OUT_TRADE_NO,
      providerAccountKey: ACCOUNT_KEY,
    })
    expect(queried.status).not.toBe('succeeded')
  })
})

describe('WeChat Pay callbacks and refunds', () => {
  function encryptedCallback(eventType: string, originalType: string, plaintext: unknown, id = 'EV-2018022511223320873') {
    const ciphertext = encryptAesGcm({
      apiV3Key: OFFICIAL_JAVA_API_V3_KEY,
      nonce: OFFICIAL_JAVA_AES_NONCE,
      plaintext: JSON.stringify(plaintext),
      associatedData: originalType,
    })
    const body = JSON.stringify({
      id,
      create_time: '2015-05-20T13:29:35+08:00',
      resource_type: 'encrypt-resource',
      event_type: eventType,
      summary: eventType,
      resource: {
        original_type: originalType,
        algorithm: 'AEAD_AES_256_GCM',
        ciphertext,
        associated_data: originalType,
        nonce: OFFICIAL_JAVA_AES_NONCE,
      },
    })
    return {
      rawBody: Buffer.from(body, 'utf8'),
      headers: signedPlatformHeaders(body),
    }
  }

  it('verifies, decrypts, and normalizes a payment callback only after full identity match', async () => {
    const provider = createProvider(async () => jsonResponse(200, {}))
    const event = await provider.verifyAndNormalizeWebhook(encryptedCallback(
      'TRANSACTION.SUCCESS',
      'transaction',
      OFFICIAL_SUCCESS_TRANSACTION,
    ))
    expect(event.signatureVerified).toBe(true)
    expect(event.payment?.status).toBe('succeeded')
    expect(event.payment?.amountMinor).toBe(100n)
    expect(event.payment?.currency).toBe('CNY')
    expect(event.providerPaymentId).toBe(OFFICIAL_DOC_OUT_TRADE_NO)
    expect(event.dedupeKey).toBe('webhook:EV-2018022511223320873')
  })

  it('acks duplicate callbacks across the official 15-retry budget without a second observation', async () => {
    expect(WECHAT_PAY_NOTIFY_RETRY_SCHEDULE).toHaveLength(WECHAT_PAY_NOTIFY_MAX_ATTEMPTS)
    const provider = createProvider(async () => jsonResponse(200, {}))
    const webhook = encryptedCallback('TRANSACTION.SUCCESS', 'transaction', OFFICIAL_SUCCESS_TRANSACTION)
    const keys = []
    const observationIds = []
    for (let i = 0; i < WECHAT_PAY_NOTIFY_MAX_ATTEMPTS; i += 1) {
      const event = await provider.verifyAndNormalizeWebhook(webhook)
      expect(event.signatureVerified).toBe(true)
      keys.push(event.dedupeKey)
      const payload = {
        status: event.payment?.status ?? null,
        providerPaymentId: event.providerPaymentId,
        amountMinor: event.payment ? serializeAmountMinor(event.payment.amountMinor) : null,
        currency: event.payment?.currency ?? null,
      }
      const recorded = await recordPaymentObservation({
        provider: 'wechat_pay',
        providerAccountKey: event.providerAccountKey,
        source: 'webhook',
        verificationMethod: 'webhook_signature',
        providerPaymentId: event.providerPaymentId,
        providerEventId: event.providerEventId,
        dedupeKey: event.dedupeKey,
        eventType: event.eventType,
        payloadSha256: hashNormalizedPayload(payload),
        normalizedPayload: payload,
        signatureVerified: true,
      })
      observationIds.push(recorded.id)
      expect(wechatPayWebhookSuccessAck()).toEqual({ status: 200 })
    }
    expect(new Set(keys).size).toBe(1)
    expect(new Set(observationIds).size).toBe(1)
  })

  it('reuses out_refund_no on refund retry and does not treat PROCESSING as succeeded', async () => {
    const refundCalls: string[] = []
    const http: WechatPayHttp = async request => {
      if (request.pathAndQuery === '/v3/refund/domestic/refunds') {
        refundCalls.push(JSON.parse(request.body).out_refund_no as string)
        return jsonResponse(200, {
          ...OFFICIAL_SUCCESS_REFUND,
          out_refund_no: JSON.parse(request.body).out_refund_no,
          refund_status: 'PROCESSING',
        })
      }
      return jsonResponse(200, {
        ...OFFICIAL_SUCCESS_REFUND,
        out_refund_no: toOutTradeNo('recharge:order:refund:v1'),
        refund_status: 'SUCCESS',
      })
    }
    const provider = createProvider(http)
    const key = 'recharge:11111111-1111-1111-1111-111111111111:refund:v1'
    const first = await provider.createRefund({
      providerPaymentId: OFFICIAL_DOC_OUT_TRADE_NO,
      providerAccountKey: ACCOUNT_KEY,
      amountMinor: 100n,
      currency: 'CNY',
      requestIdempotencyKey: key,
    })
    const second = await provider.createRefund({
      providerPaymentId: OFFICIAL_DOC_OUT_TRADE_NO,
      providerAccountKey: ACCOUNT_KEY,
      amountMinor: 100n,
      currency: 'CNY',
      requestIdempotencyKey: key,
    })
    expect(first.status).toBe('processing')
    expect(first.status).not.toBe('succeeded')
    expect(second.providerRefundId).toBe(first.providerRefundId)
    expect(first.providerRefundId).toBe(toOutTradeNo(key))
    expect(refundCalls).toEqual([toOutTradeNo(key), toOutTradeNo(key)])

    const queried = await provider.queryRefund({
      providerRefundId: first.providerRefundId,
      providerAccountKey: ACCOUNT_KEY,
    })
    expect(queried.status).toBe('succeeded')
  })

  it('normalizes a refund notify without treating acceptance as payment success', async () => {
    const provider = createProvider(async () => jsonResponse(200, {}))
    const processing = await provider.verifyAndNormalizeWebhook(encryptedCallback(
      'REFUND.SUCCESS',
      'refund',
      { ...OFFICIAL_SUCCESS_REFUND, refund_status: 'PROCESSING' },
      'EV-REFUND-1',
    ))
    expect(processing.signatureVerified).toBe(true)
    expect(processing.eventType).toBe('refund.processing')
    expect(processing.payment?.status).not.toBe('succeeded')
  })
})
