import vector from './fixtures/paid-reset-v2.json'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { callPaidReset, callPaidResetPreview, paidResetPayloadHash, type PaidResetPayload } from '../lib/fakaBridge/paidResetV2.js'
import type { FakaTransport } from '../lib/fakaBridge/types.js'
import { signProtocolV2 } from '../lib/signedProtocolV2.js'

const payload: PaidResetPayload = { ...vector.payload, period: 'reset_traffic' }
const before = { plan_id: '3', transfer_enable: '9223372036854775807', expired_at: null,
  last_reset_at: null, reset_count: '9', next_reset_at: null, u: '9007199254740993', d: '20' }
const after = { ...before, u: '0', d: '0', reset_count: '10', last_reset_at: '1792857600' }
function options(mutate: (body: any, sent: any) => void = () => {}) {
  const transport = vi.fn<FakaTransport>().mockImplementation(async req => {
    const sent = JSON.parse(req.body!)
    const revoked = req.url.endsWith('paid-reset-revoke')
    const body = { success: true, protocol_version: 2, request_id: sent.request_id, queried_at: new Date().toISOString(),
      operation: { order_no: payload.order_no, user_id: payload.user_id, sku: payload.sku, plan_id: payload.expected_plan_id,
        period: 'reset_traffic', payload_hash: paidResetPayloadHash(payload, 'monexus'), status: revoked ? 'revoked' : 'completed',
        trade_no: 'TRADE-1', error_code: null, before, after, completed_at: new Date().toISOString() } }
    mutate(body, sent)
    return { status: 200, text: JSON.stringify(body) }
  })
  return { url: 'https://xboard.test/plugin/faka-bridge/order-paid', secret: 'paid-test-secret', transport }
}
function noEvidence(body: any, status: string, errorCode: string | null = null) {
  Object.assign(body.operation, { status, before: null, after: null, completed_at: null, trade_no: null, error_code: errorCode })
}

describe('stable-account commercial reset v2', () => {
  it('matches the independent PHP/Python semantic vector without rounding account IDs', () => {
    expect(paidResetPayloadHash(payload, vector.clientId)).toBe(vector.payloadHash)
    for (const [key, value] of Object.entries({ order_no: 'MN-other', user_id: '42', sku: 'plan-4-reset_traffic', expected_plan_id: '4' })) {
      expect(paidResetPayloadHash({ ...payload, [key]: value }, 'monexus')).not.toBe(vector.payloadHash)
    }
    expect(paidResetPayloadHash(payload, 'rotated-client')).not.toBe(vector.payloadHash)
  })

  it('signs fixed v2 paths with immutable semantics and fresh nonce/request IDs', async () => {
    const opts = options()
    for (const action of ['paid-reset', 'paid-reset-status', 'paid-reset-revoke'] as const) {
      expect((await callPaidReset(action, payload, 'monexus', opts)).ok).toBe(true)
    }
    const requests = opts.transport.mock.calls.map(([req]) => req)
    expect(new Set(requests.map(r => r.headers['x-monexus-nonce'])).size).toBe(3)
    expect(new Set(requests.map(r => JSON.parse(r.body!).request_id)).size).toBe(3)
    expect(requests.map(r => new URL(r.url).pathname)).toEqual([
      '/plugin/faka-bridge/v2/paid-reset', '/plugin/faka-bridge/v2/paid-reset-status', '/plugin/faka-bridge/v2/paid-reset-revoke',
    ])
    for (const req of requests) {
      expect(JSON.parse(req.body!)).toEqual({ request_id: expect.any(String), ...payload })
      expect(req.headers['x-monexus-signature']).toBe(signProtocolV2({ audience: 'xboard', method: 'POST',
        path: new URL(req.url).pathname, timestampMs: Number(req.headers['x-monexus-timestamp']),
        nonce: req.headers['x-monexus-nonce'], rawBody: Buffer.from(req.body!) }, opts.secret))
    }
  })

  it.each(['request', 'order', 'user', 'sku', 'plan', 'hash', 'usage', 'count', 'expiry', 'limit', 'snapshotPlan', 'trade', 'malformed', 'overflow', 'extra'] as const)(
    'rejects %s corruption without accepting success', async key => {
      const opts = options(body => {
        body.operation.before = { ...before }; body.operation.after = { ...after }
        if (key === 'request') body.request_id = randomUUID()
        if (key === 'order') body.operation.order_no = 'MN-other'
        if (key === 'user') body.operation.user_id = '42'
        if (key === 'sku') body.operation.sku = 'plan-4-reset_traffic'
        if (key === 'plan') body.operation.plan_id = '4'
        if (key === 'hash') body.operation.payload_hash = 'a'.repeat(64)
        if (key === 'usage') body.operation.after.u = '1'
        if (key === 'count') body.operation.after.reset_count = '9'
        if (key === 'expiry') body.operation.after.expired_at = '0'
        if (key === 'limit') body.operation.after.transfer_enable = '1'
        if (key === 'snapshotPlan') { body.operation.before.plan_id = '4'; body.operation.after.plan_id = '4' }
        if (key === 'trade') body.operation.trade_no = null
        if (key === 'malformed') body.operation.after.reset_count = '1e3'
        if (key === 'overflow') body.operation.after.reset_count = '9223372036854775808'
        if (key === 'extra') body.operation.email = 'secret@example.com'
      })
      expect(await callPaidReset('paid-reset', payload, 'monexus', opts)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' })
    })

  it('accepts not_found only for status, and revoke only with a durable revoked state', async () => {
    const absent = options(body => noEvidence(body, 'not_found'))
    expect(await callPaidReset('paid-reset-status', payload, 'monexus', absent)).toMatchObject({ ok: true, body: { operation: { status: 'not_found', after: null } } })
    for (const action of ['paid-reset', 'paid-reset-revoke'] as const) {
      expect(await callPaidReset(action, payload, 'monexus', absent)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' })
    }
    const completed = options(body => { body.operation.status = 'completed' })
    expect(await callPaidReset('paid-reset-revoke', payload, 'monexus', completed)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' })
  })

  it('distinguishes a cancellation before execution from a refund after execution', async () => {
    const tombstone = options(body => noEvidence(body, 'revoked'))
    expect(await callPaidReset('paid-reset-revoke', payload, 'monexus', tombstone)).toMatchObject({ ok: true, body: { operation: { status: 'revoked', after: null } } })
    const executed = options()
    expect(await callPaidReset('paid-reset-revoke', payload, 'monexus', executed)).toMatchObject({ ok: true, body: { operation: { status: 'revoked', after } } })
    const broken = options(body => { body.operation.after = null })
    expect(await callPaidReset('paid-reset-revoke', payload, 'monexus', broken)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' })
  })

  it('requires a known business reason for terminal rejection and no fake success evidence', async () => {
    const failed = options(body => noEvidence(body, 'failed', 'SUBSCRIPTION_INELIGIBLE'))
    expect(await callPaidReset('paid-reset', payload, 'monexus', failed)).toMatchObject({ ok: true, body: { operation: { status: 'failed' } } })
    const broken = options(body => noEvidence(body, 'failed'))
    expect(await callPaidReset('paid-reset', payload, 'monexus', broken)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' })
  })

  it('binds fresh preview to the expected account, SKU and plan without email', async () => {
    const input = { user_id: payload.user_id, sku: payload.sku, expected_plan_id: payload.expected_plan_id }
    const preview = options((body, sent) => {
      delete body.operation
      body.preview = { user_id: sent.user_id, sku: sent.sku, plan_id: '3', period: 'reset_traffic', eligible: true, block_reason: null }
    })
    expect((await callPaidResetPreview(input, preview)).ok).toBe(true)
    expect(JSON.parse(preview.transport.mock.calls[0][0].body!)).toEqual({ request_id: expect.any(String), user_id: input.user_id, sku: input.sku })
    expect(await callPaidResetPreview({ ...input, expected_plan_id: '4' }, preview)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' })
    const contradictory = options(body => {
      delete body.operation
      body.preview = { user_id: input.user_id, sku: input.sku, plan_id: '3', period: 'reset_traffic', eligible: true, block_reason: 'RESET_NOT_FOR_SALE' }
    })
    expect(await callPaidResetPreview(input, contradictory)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' })
  })

  it('rejects extra identity fields, invalid client and out-of-range plan before HTTP', async () => {
    const opts = options()
    const inputs = [{ ...payload, email: 'other@example.com' }, { ...payload, user_id: 42 },
      { ...payload, expected_plan_id: '2147483648' }, { ...payload, period: 'monthly' }, { ...payload, user_id: '9223372036854775808' }]
    for (const input of inputs) {
      expect(await callPaidReset('paid-reset', input as PaidResetPayload, 'monexus', opts)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    }
    expect(await callPaidReset('paid-reset', payload, '', opts)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(opts.transport).not.toHaveBeenCalled()
  })
})
