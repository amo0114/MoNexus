import { createSign, createVerify, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { HttpError } from '../../../../lib/httpError.js'
import { recordNormalizedPaymentFact, recordPaymentObservation } from '../../observations/record.js'
import { FORM_POST_MAX_VALUE_LENGTH } from '../formPost.js'
import {
  amountMinorToYuanString,
  isFullRefundAmount,
  yuanStringToAmountMinor,
} from './amount.js'
import {
  ALIPAY_LIVE_GATEWAY,
  ALIPAY_SANDBOX_GATEWAY,
  alipayAccountKey,
} from './config.js'
import { createOfficialAlipaySdk, type AlipaySdkSurface } from './gateway.js'
import {
  createAlipayProvider,
  encodeAlipayRefundId,
  toAlipayOutRequestNo,
} from './provider.js'

const APP_ID = '2021000000000001'
const SELLER_ID = '2088000000000001'

function generatePemPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
}

const merchant = generatePemPair()
const alipay = generatePemPair()

const liveConfig = {
  mode: 'live' as const,
  appId: APP_ID,
  sellerId: SELLER_ID,
  privateKey: merchant.privateKey,
  alipayPublicKey: alipay.publicKey,
  gatewayUrl: ALIPAY_LIVE_GATEWAY,
  notifyUrl: 'https://shop.example.com/api/payment/webhooks/alipay',
}

const sandboxConfig = {
  ...liveConfig,
  mode: 'sandbox' as const,
  gatewayUrl: ALIPAY_SANDBOX_GATEWAY,
}

function rsa2Sign(params: Record<string, string>, privateKey: string, omit: readonly string[]): string {
  const content = Object.keys(params)
    .filter(key => !omit.includes(key) && params[key] !== '')
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&')
  return createSign('RSA-SHA256').update(content, 'utf8').sign(privateKey, 'base64')
}

function verifyRequestSign(fields: Record<string, string>, publicKey: string): boolean {
  const { sign, ...rest } = fields
  if (!sign) return false
  const content = Object.keys(rest).sort().map(key => `${key}=${rest[key]}`).join('&')
  return createVerify('RSA-SHA256').update(content, 'utf8').verify(publicKey, sign, 'base64')
}

function encodeNotify(fields: Record<string, string>): Buffer {
  const body = new URLSearchParams(fields).toString()
  return Buffer.from(body, 'utf8')
}

function signedNotify(overrides: Record<string, string> = {}): { fields: Record<string, string>; raw: Buffer } {
  const fields: Record<string, string> = {
    notify_time: '2026-08-20 12:00:00',
    notify_type: 'trade_status_sync',
    notify_id: 'notify_fixed_001',
    app_id: APP_ID,
    charset: 'utf-8',
    version: '1.0',
    sign_type: 'RSA2',
    trade_no: '2026082022001400000000000001',
    out_trade_no: '11111111-1111-1111-1111-111111111111',
    seller_id: SELLER_ID,
    trade_status: 'TRADE_SUCCESS',
    total_amount: '1.00',
    ...overrides,
  }
  fields.sign = rsa2Sign(fields, alipay.privateKey, ['sign', 'sign_type'])
  return { fields, raw: encodeNotify(fields) }
}

function withExec(
  exec: AlipaySdkSurface['exec'],
  config = liveConfig,
): ReturnType<typeof createAlipayProvider> {
  const official = createOfficialAlipaySdk(config)
  return createAlipayProvider(config, {
    sdk: {
      pageExecute: official.pageExecute.bind(official),
      checkNotifySign: official.checkNotifySign.bind(official),
      exec,
    },
  })
}

describe('Alipay amountMinor ↔ yuan conversion', () => {
  it('formats 1/10/100/101 fen without float', () => {
    expect(amountMinorToYuanString(1n)).toBe('0.01')
    expect(amountMinorToYuanString(10n)).toBe('0.10')
    expect(amountMinorToYuanString(100n)).toBe('1.00')
    expect(amountMinorToYuanString(101n)).toBe('1.01')
    expect(yuanStringToAmountMinor('0.01')).toBe(1n)
    expect(yuanStringToAmountMinor('0.10')).toBe(10n)
    expect(yuanStringToAmountMinor('1.00')).toBe(100n)
    expect(yuanStringToAmountMinor('1.01')).toBe(101n)
    expect(isFullRefundAmount('1.00', '0.01')).toBe(false)
    expect(isFullRefundAmount('1.00', '1.00')).toBe(true)
  })

  it('rejects non-canonical yuan strings that float parsing would accept', () => {
    expect(() => yuanStringToAmountMinor('0.1')).toThrow(/canonical/)
    expect(() => yuanStringToAmountMinor('1.0')).toThrow(/canonical/)
    expect(() => yuanStringToAmountMinor('1.000')).toThrow(/canonical/)
    expect(() => yuanStringToAmountMinor('01.00')).toThrow(/canonical/)
    expect(() => yuanStringToAmountMinor('1e-2')).toThrow(/exponent/)
    expect(() => yuanStringToAmountMinor(0.1 as unknown as string)).toThrow(/string/)
  })
})

describe('Alipay form_post signing and action contract', () => {
  it('returns a structured WAP/PC form_post whose body signature verifies', async () => {
    const provider = createAlipayProvider(liveConfig)
    const attemptId = '22222222-2222-2222-2222-222222222222'
    const created = await provider.createPayment({
      orderId: '33333333-3333-3333-3333-333333333333',
      paymentIntentId: '44444444-4444-4444-4444-444444444444',
      paymentAttemptId: attemptId,
      amountMinor: 101n,
      currency: 'CNY',
      paymentMethod: 'wap',
      providerAccountKey: alipayAccountKey('live', APP_ID),
      requestIdempotencyKey: 'recharge:order:create:v1',
      returnUrl: 'https://shop.example.com/recharge/return',
    })
    expect(created.action.type).toBe('form_post')
    if (created.action.type !== 'form_post') throw new Error('expected form_post')
    expect(created.action.actionUrl).toBe(ALIPAY_LIVE_GATEWAY)
    expect(created.action.method).toBe('POST')
    expect(created.action.fields.method).toBe('alipay.trade.wap.pay')
    expect(created.action.fields.app_id).toBe(APP_ID)
    expect(created.action.fields.biz_content).toContain('"total_amount":"1.01"')
    expect(created.action.fields.biz_content).toContain(`"out_trade_no":"${attemptId}"`)
    expect(JSON.stringify(created.action)).not.toMatch(/<\s*form/i)
    expect(verifyRequestSign(created.action.fields, merchant.publicKey)).toBe(true)

    const tampered = { ...created.action.fields, total_amount: '9.99' }
    expect(verifyRequestSign(tampered, merchant.publicKey)).toBe(false)

    const page = await provider.createPayment({
      orderId: '33333333-3333-3333-3333-333333333333',
      paymentIntentId: '44444444-4444-4444-4444-444444444444',
      paymentAttemptId: '55555555-5555-5555-5555-555555555555',
      amountMinor: 100n,
      currency: 'CNY',
      paymentMethod: 'page',
      providerAccountKey: alipayAccountKey('live', APP_ID),
      requestIdempotencyKey: 'recharge:order:page:v1',
    })
    expect(page.action.type).toBe('form_post')
    if (page.action.type !== 'form_post') throw new Error('expected form_post')
    expect(page.action.fields.method).toBe('alipay.trade.page.pay')
    expect(verifyRequestSign(page.action.fields, merchant.publicKey)).toBe(true)
  })

  it('rejects non-allowlisted hosts, oversized fields, and full HTML', async () => {
    const official = createOfficialAlipaySdk(liveConfig)
    const htmlSdk: AlipaySdkSurface = {
      pageExecute: () => '<form action="https://openapi.alipay.com/gateway.do"><input name="biz_content" value="x"/></form><script>document.forms[0].submit()</script>',
      checkNotifySign: official.checkNotifySign.bind(official),
      exec: official.exec.bind(official),
    }
    await expect(createAlipayProvider(liveConfig, { sdk: htmlSdk }).createPayment({
      orderId: 'o',
      paymentIntentId: 'i',
      paymentAttemptId: 'a',
      amountMinor: 100n,
      currency: 'CNY',
      paymentMethod: 'wap',
      providerAccountKey: alipayAccountKey('live', APP_ID),
      requestIdempotencyKey: 'k-html',
    })).rejects.toThrow(/HTML/)

    const evilSdk: AlipaySdkSurface = {
      pageExecute: () => 'https://evil.example/gateway.do?app_id=1&method=alipay.trade.wap.pay&sign=abc',
      checkNotifySign: official.checkNotifySign.bind(official),
      exec: official.exec.bind(official),
    }
    await expect(createAlipayProvider(liveConfig, { sdk: evilSdk }).createPayment({
      orderId: 'o',
      paymentIntentId: 'i',
      paymentAttemptId: 'a',
      amountMinor: 100n,
      currency: 'CNY',
      paymentMethod: 'wap',
      providerAccountKey: alipayAccountKey('live', APP_ID),
      requestIdempotencyKey: 'k-evil',
    })).rejects.toThrow(/allowlisted/)

    const huge = 'x'.repeat(FORM_POST_MAX_VALUE_LENGTH + 1)
    const oversizedSdk: AlipaySdkSurface = {
      pageExecute: () => `https://openapi.alipay.com/gateway.do?app_id=1&method=alipay.trade.wap.pay&payload=${huge}`,
      checkNotifySign: official.checkNotifySign.bind(official),
      exec: official.exec.bind(official),
    }
    await expect(createAlipayProvider(liveConfig, { sdk: oversizedSdk }).createPayment({
      orderId: 'o',
      paymentIntentId: 'i',
      paymentAttemptId: 'a',
      amountMinor: 100n,
      currency: 'CNY',
      paymentMethod: 'wap',
      providerAccountKey: alipayAccountKey('live', APP_ID),
      requestIdempotencyKey: 'k-size',
    })).rejects.toMatchObject({ message: expect.stringMatching(/size/) } satisfies Partial<HttpError>)
  })
})

describe('Alipay notify verify and replay', () => {
  it('accepts a valid signed form body and rejects a tampered one', async () => {
    const provider = createAlipayProvider(liveConfig)
    const { raw } = signedNotify()
    const ok = await provider.verifyAndNormalizeWebhook({ headers: {}, rawBody: raw })
    expect(ok.signatureVerified).toBe(true)
    expect(ok.payment?.status).toBe('succeeded')
    expect(ok.payment?.amountMinor).toBe(100n)
    expect(ok.payment?.providerCaptureId).toBe('2026082022001400000000000001')
    expect(ok.dedupeKey).toBe('notify:notify_fixed_001')

    const bad = signedNotify()
    bad.fields.total_amount = '9.99'
    const failed = await provider.verifyAndNormalizeWebhook({
      headers: {},
      rawBody: encodeNotify(bad.fields),
    })
    expect(failed.signatureVerified).toBe(false)
    expect(failed.payment).toBeNull()
  })

  it('verifies a notify whose subject contains % without a second decode', async () => {
    const provider = createAlipayProvider(liveConfig)
    const { raw } = signedNotify({
      notify_id: 'notify_percent_subject',
      subject: '100% recharge',
    })
    const ok = await provider.verifyAndNormalizeWebhook({ headers: {}, rawBody: raw })
    expect(ok.signatureVerified).toBe(true)
    expect(ok.payment?.status).toBe('succeeded')
  })

  it('replays the same notify_id through recordPaymentObservation without marking paid', async () => {
    const provider = createAlipayProvider(liveConfig)
    const { raw } = signedNotify({ notify_id: 'notify_replay_same' })
    const firstEvent = await provider.verifyAndNormalizeWebhook({ headers: {}, rawBody: raw })
    const secondEvent = await provider.verifyAndNormalizeWebhook({ headers: {}, rawBody: raw })
    expect(firstEvent.dedupeKey).toBe('notify:notify_replay_same')
    expect(secondEvent.dedupeKey).toBe(firstEvent.dedupeKey)

    const payload = {
      status: firstEvent.payment?.status,
      providerPaymentId: firstEvent.providerPaymentId,
    }
    const first = await recordPaymentObservation({
      provider: 'alipay',
      providerAccountKey: firstEvent.providerAccountKey,
      source: 'webhook',
      verificationMethod: 'webhook_signature',
      providerPaymentId: firstEvent.providerPaymentId,
      providerEventId: firstEvent.providerEventId,
      dedupeKey: firstEvent.dedupeKey,
      eventType: firstEvent.eventType,
      payloadSha256: 'a'.repeat(64),
      normalizedPayload: payload,
      signatureVerified: true,
    })
    const replay = await recordPaymentObservation({
      provider: 'alipay',
      providerAccountKey: secondEvent.providerAccountKey,
      source: 'webhook',
      verificationMethod: 'webhook_signature',
      providerPaymentId: secondEvent.providerPaymentId,
      providerEventId: secondEvent.providerEventId,
      dedupeKey: secondEvent.dedupeKey,
      eventType: secondEvent.eventType,
      payloadSha256: 'b'.repeat(64),
      normalizedPayload: payload,
      signatureVerified: true,
    })
    expect(first.created).toBe(true)
    expect(replay.created).toBe(false)
    expect(replay.id).toBe(first.id)
  })
})

describe('Alipay query / refund / isolation', () => {
  it('converges a missing callback through trade.query without marking paid', async () => {
    const outTradeNo = '66666666-6666-6666-6666-666666666666'
    const provider = withExec(async method => {
      expect(method).toBe('alipay.trade.query')
      return {
        code: '10000',
        msg: 'Success',
        out_trade_no: outTradeNo,
        trade_no: '2026082022001400000000000002',
        trade_status: 'TRADE_SUCCESS',
        total_amount: '1.00',
        seller_id: SELLER_ID,
      }
    })
    const queried = await provider.queryPayment({
      providerPaymentId: outTradeNo,
      providerAccountKey: alipayAccountKey('live', APP_ID),
    })
    expect(queried.status).toBe('succeeded')
    expect(queried.amountMinor).toBe(100n)
    expect(queried.providerCaptureId).toBe('2026082022001400000000000002')

    const recorded = await recordNormalizedPaymentFact({
      source: 'provider_query',
      provider: 'alipay',
      providerAccountKey: queried.providerAccountKey,
      payment: {
        status: queried.status,
        providerPaymentId: queried.providerPaymentId,
        providerCaptureId: queried.providerCaptureId,
        amountMinor: queried.amountMinor,
        currency: queried.currency,
        immutableStateVersion: queried.immutableStateVersion,
      },
    })
    expect(recorded.created).toBe(true)
  })

  it('does not treat a partial refund as a full refund', async () => {
    const outTradeNo = '77777777-7777-7777-7777-777777777777'
    const platformRefundKey = 'recharge:77777777-7777-7777-7777-777777777777:refund:v1'
    const alipayOutRequestNo = toAlipayOutRequestNo(platformRefundKey)
    expect(alipayOutRequestNo).not.toContain(':')
    expect(alipayOutRequestNo).toMatch(/^[A-Za-z0-9_-]+$/)
    const provider = withExec(async (method, params) => {
      const biz = (params?.bizContent ?? {}) as Record<string, unknown>
      if (method === 'alipay.trade.query') {
        return {
          code: '10000',
          out_trade_no: outTradeNo,
          trade_no: '2026082022001400000000000003',
          trade_status: 'TRADE_SUCCESS',
          total_amount: '1.00',
          refund_amount: '0.01',
          seller_id: SELLER_ID,
        }
      }
      if (method === 'alipay.trade.refund') {
        expect(biz.refund_amount).toBe('0.01')
        expect(biz.out_trade_no).toBe(outTradeNo)
        expect(biz.out_request_no).toBe(alipayOutRequestNo)
        expect(String(biz.out_request_no)).not.toContain(':')
        return {
          code: '10000',
          fund_change: 'Y',
          out_trade_no: outTradeNo,
          out_request_no: alipayOutRequestNo,
          refund_fee: '0.01',
          total_amount: '1.00',
        }
      }
      if (method === 'alipay.trade.fastpay.refund.query') {
        if (!biz.out_trade_no && !biz.trade_no) {
          return {
            code: '40004',
            sub_code: 'ACQ.INVALID_PARAMETER',
            sub_msg: 'out_trade_no or trade_no is required',
          }
        }
        expect(biz.out_trade_no).toBe(outTradeNo)
        expect(biz.out_request_no).toBe(alipayOutRequestNo)
        return {
          code: '10000',
          out_request_no: alipayOutRequestNo,
          out_trade_no: outTradeNo,
          refund_amount: '0.01',
          total_amount: '1.00',
          refund_status: 'REFUND_SUCCESS',
        }
      }
      throw new Error(`unexpected ${method}`)
    })

    const refunded = await provider.createRefund({
      providerPaymentId: outTradeNo,
      providerAccountKey: alipayAccountKey('live', APP_ID),
      amountMinor: 1n,
      currency: 'CNY',
      requestIdempotencyKey: platformRefundKey,
    })
    expect(refunded.status).toBe('succeeded')
    expect(refunded.amountMinor).toBe(1n)
    expect(refunded.providerRefundId).toBe(encodeAlipayRefundId(outTradeNo, alipayOutRequestNo))
    expect(isFullRefundAmount('1.00', amountMinorToYuanString(refunded.amountMinor))).toBe(false)

    const refundQuery = await provider.queryRefund({
      providerRefundId: refunded.providerRefundId,
      providerAccountKey: alipayAccountKey('live', APP_ID),
    })
    expect(refundQuery.amountMinor).toBe(1n)
    expect(refundQuery.status).toBe('succeeded')

    const missingTrade = await provider.queryRefund({
      providerRefundId: alipayOutRequestNo,
      providerAccountKey: alipayAccountKey('live', APP_ID),
    })
    expect(missingTrade.status).toBe('unknown')

    const trade = await provider.queryPayment({
      providerPaymentId: outTradeNo,
      providerAccountKey: alipayAccountKey('live', APP_ID),
    })
    expect(trade.status).toBe('succeeded')
    expect(trade.amountMinor).toBe(100n)
  })

  it('rejects sandbox config in live', async () => {
    expect(() => createAlipayProvider({
      ...liveConfig,
      gatewayUrl: ALIPAY_SANDBOX_GATEWAY,
    })).toThrow(/sandbox/)

    const sandbox = createAlipayProvider(sandboxConfig)
    await expect(sandbox.selectAccount({
      environment: 'live',
      currency: 'CNY',
      paymentMethod: 'wap',
    })).rejects.toThrow(/sandbox/)

    expect(() => createAlipayProvider({
      ...liveConfig,
      certs: {
        environment: 'sandbox',
        appCert: 'SANDBOX_APP_CERT',
        alipayCert: 'SANDBOX_ALIPAY_CERT',
        rootCert: 'SANDBOX_ROOT_CERT',
      },
    }, {
      sdk: createOfficialAlipaySdk(liveConfig),
    })).toThrow(/sandbox/)
  })

  it('closes an Alipay-acknowledged unpaid trade', async () => {
    const provider = withExec(async method => {
      if (method === 'alipay.trade.close') return { code: '10000', msg: 'Success' }
      throw new Error(`unexpected ${method}`)
    })
    const closed = await provider.closePayment({
      providerPaymentId: '88888888-8888-8888-8888-888888888888',
      providerAccountKey: alipayAccountKey('live', APP_ID),
      requestIdempotencyKey: 'recharge:order:close:v1',
    })
    expect(closed.status).toBe('cancelled')
  })

  it('keeps TRADE_NOT_EXIST close as unknown while the signed form is still payable', async () => {
    const provider = withExec(async method => {
      if (method === 'alipay.trade.close') {
        return { code: '40004', sub_code: 'ACQ.TRADE_NOT_EXIST', sub_msg: '交易不存在' }
      }
      throw new Error(`unexpected ${method}`)
    })
    const closed = await provider.closePayment({
      providerPaymentId: '88888888-8888-8888-8888-888888888888',
      providerAccountKey: alipayAccountKey('live', APP_ID),
      requestIdempotencyKey: 'recharge:order:close:v1',
    })
    expect(closed.status).toBe('unknown')
  })

  it('rejects a live config whose gateway is not openapi.alipay.com', () => {
    expect(() => createAlipayProvider({
      ...liveConfig,
      gatewayUrl: 'https://evil.example/gateway.do',
    })).toThrow(/openapi\.alipay\.com/)
  })

  it('does not treat a query app_id mismatch as succeeded', async () => {
    const outTradeNo = '99999999-9999-9999-9999-999999999999'
    const provider = withExec(async () => ({
      code: '10000',
      app_id: '2021999999999999',
      out_trade_no: outTradeNo,
      trade_no: '2026082022001400000000000009',
      trade_status: 'TRADE_SUCCESS',
      total_amount: '1.00',
      seller_id: SELLER_ID,
    }))
    const queried = await provider.queryPayment({
      providerPaymentId: outTradeNo,
      providerAccountKey: alipayAccountKey('live', APP_ID),
    })
    expect(queried.status).toBe('unknown')
  })
})
