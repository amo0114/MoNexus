import { describe, expect, it, vi } from 'vitest'
import { callFakaV2Capabilities, callFakaV2ResolveAccount, callFakaV2Subscription } from '../lib/fakaBridge/accountV2.js'
import { verifyProtocolV2 } from '../lib/signedProtocolV2.js'
import type { FakaTransport } from '../lib/fakaBridge/types.js'

const requestId = '00000000-0000-4000-8000-000000000001'
const envelope = { success: true, protocol_version: 2, request_id: requestId, queried_at: '2026-10-25T08:00:00Z' }
const caps = { ...envelope, plugin_version: '1.6.0', build_id: 'a'.repeat(64), core_adapter: 'xboard-eloquent-read-v1',
  capabilities: { resolve_by_order: true, subscription_by_user_id: true, reset_idempotency: false, reset_status: false, cancel_tombstone: false, paid_reset_by_user_id: false } }
const resolved = { ...envelope, external_order_no: 'MN-42', trade_no: 'TRADE-42', source_status: 'completed', account: { user_id: '9007199254740993', email: 'changed@example.com' } }
const profile = { ...envelope, account: resolved.account, subscription: { status: 'active', plan_id: '3', plan_name: '标准套餐',
  total_bytes: '9223372036854775807', upload_bytes: '9007199254740993', download_bytes: '1', used_bytes: '9007199254740994',
  remaining_bytes: '9214364837600034813', expires_at: null, next_reset_at: '1794000000', reset_count: '7' } }
function options(body: unknown, status = 200) {
  const transport = vi.fn<FakaTransport>().mockResolvedValue({ status, text: JSON.stringify(body) })
  return { url: 'https://xboard.test/plugin/faka-bridge/order-paid', secret: 'test-v2-client', timeoutMs: 1500, transport }
}

describe('Faka account v2 transport', () => {
  it('signs actual UTF-8 body, full POST path, request ID and fixed server origin', async () => {
    const opts = options(resolved)
    expect((await callFakaV2ResolveAccount('MN-42', opts, requestId)).ok).toBe(true)
    const sent = opts.transport.mock.calls[0][0]
    expect(sent.url).toBe('https://xboard.test/plugin/faka-bridge/v2/user-resolve')
    expect(sent.timeoutMs).toBe(1500)
    expect(JSON.parse(sent.body!)).toEqual({ request_id: requestId, external_order_no: 'MN-42' })
    expect(verifyProtocolV2({ audience: 'xboard', method: sent.method, path: new URL(sent.url).pathname,
      timestampMs: Number(sent.headers['x-monexus-timestamp']), nonce: sent.headers['x-monexus-nonce'], rawBody: Buffer.from(sent.body!) },
    sent.headers['x-monexus-signature'], opts.secret)).toBe(true)
  })

  it('keeps request ID across retries with fresh nonce', async () => {
    const opts = options(caps)
    await callFakaV2Capabilities(opts, requestId)
    await callFakaV2Capabilities(opts, requestId)
    expect(opts.transport.mock.calls[0][0].body).toBe(opts.transport.mock.calls[1][0].body)
    expect(opts.transport.mock.calls[0][0].headers['x-monexus-nonce']).not.toBe(opts.transport.mock.calls[1][0].headers['x-monexus-nonce'])
  })

  it('accepts false write capabilities and exact decimal byte/ID strings', async () => {
    expect(await callFakaV2Capabilities(options(caps), requestId)).toMatchObject({ ok: true, body: caps })
    expect(await callFakaV2Subscription(resolved.account.user_id, options(profile), requestId)).toMatchObject({ ok: true, body: profile })
    const exhausted = structuredClone(profile)
    Object.assign(exhausted.subscription, { upload_bytes: '9223372036854775807', download_bytes: '9223372036854775807', used_bytes: '18446744073709551614', remaining_bytes: '0', expires_at: '0', status: 'expired' })
    expect((await callFakaV2Subscription(resolved.account.user_id, options(exhausted), requestId)).ok).toBe(true)
  })

  it.each(['https://xboard.test/api/v1/plugin/faka-bridge/order-paid', 'https://xboard.test/plugin/faka-bridge/order-paid?secret=x',
    'https://user:pass@xboard.test/plugin/faka-bridge/order-paid', 'http://xboard.test/plugin/faka-bridge/order-paid',
    'https://xboard.test/plugin/faka-bridge/order-paid#hash'])('rejects ambiguous or insecure configured target %s', async url => {
    const opts = { ...options(caps), url }
    expect(await callFakaV2Capabilities(opts, requestId)).toMatchObject({ ok: false, code: 'INVALID_TARGET' })
    expect(opts.transport).not.toHaveBeenCalled()
  })

  it('rejects malformed inputs without transport', async () => {
    const opts = options(profile)
    for (const value of ['0', '01', '9223372036854775808', '1e3', '../1']) {
      expect(await callFakaV2Subscription(value, opts, requestId)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    }
    expect(await callFakaV2ResolveAccount('someone@example.com', opts, requestId)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(await callFakaV2Capabilities(opts, 'invalid')).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(opts.transport).not.toHaveBeenCalled()
  })

  it('rejects cross-request/order/user responses and malformed or inconsistent projections', async () => {
    for (const body of [{ ...resolved, request_id: '00000000-0000-4000-8000-000000000002' }, { ...resolved, external_order_no: 'MN-other' },
      { ...resolved, account: { ...resolved.account, password: 'PRIVATE_SENTINEL' } }]) {
      expect(await callFakaV2ResolveAccount('MN-42', options(body), requestId)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' })
    }
    for (const body of [{ ...profile, account: { ...profile.account, user_id: '2' } },
      { ...profile, subscription: { ...profile.subscription, total_bytes: 100 } },
      { ...profile, subscription: { ...profile.subscription, upload_bytes: '1e3' } },
      { ...profile, subscription: { ...profile.subscription, used_bytes: '0' } },
      { ...profile, subscription: { ...profile.subscription, remaining_bytes: '0' } }]) {
      expect(await callFakaV2Subscription(resolved.account.user_id, options(body), requestId)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' })
    }
    expect(await callFakaV2Capabilities(options({ ...caps, protocol_version: 1 }), requestId)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' })
  })

  it('returns bounded failure codes without raw account/error contents', async () => {
    const opts = options({ success: false, protocol_version: 2, request_id: requestId, error_code: 'ACCOUNT_UNRESOLVED' }, 409)
    expect(await callFakaV2ResolveAccount('MN-42', opts, requestId)).toEqual({ ok: false, code: 'REMOTE_REJECTED', httpStatus: 409, remoteCode: 'ACCOUNT_UNRESOLVED' })
    opts.transport.mockResolvedValue({ status: 409, text: JSON.stringify({ success: false, protocol_version: 2,
      request_id: '00000000-0000-4000-8000-000000000002', error_code: 'ACCOUNT_UNRESOLVED' }) })
    expect(await callFakaV2Capabilities(opts, requestId)).toEqual({ ok: false, code: 'INVALID_RESPONSE', httpStatus: 409 })
    opts.transport.mockResolvedValue({ status: 401, text: JSON.stringify({ success: false, protocol_version: 2, request_id: null, error_code: 'SIGNATURE_INVALID' }) })
    expect(await callFakaV2Capabilities(opts, requestId)).toEqual({ ok: false, code: 'REMOTE_REJECTED', httpStatus: 401, remoteCode: 'SIGNATURE_INVALID' })
    opts.transport.mockResolvedValue({ status: 503, text: 'PRIVATE_EMAIL_SENTINEL' })
    expect(JSON.stringify(await callFakaV2Capabilities(opts, requestId))).not.toContain('PRIVATE_EMAIL_SENTINEL')
    opts.transport.mockRejectedValue(new Error('timeout PRIVATE_EMAIL_SENTINEL'))
    expect(await callFakaV2Capabilities(opts, requestId)).toEqual({ ok: false, code: 'TIMEOUT', httpStatus: 0 })
    opts.transport.mockRejectedValue(new Error('PRIVATE_SECRET_SENTINEL'))
    expect(await callFakaV2Capabilities(opts, requestId)).toEqual({ ok: false, code: 'NETWORK', httpStatus: 0 })
    opts.transport.mockResolvedValue({ status: 200, text: 'x'.repeat(65537) })
    expect(await callFakaV2Capabilities(opts, requestId)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' })
    opts.transport.mockResolvedValue({ status: 302, text: '{}' })
    expect(await callFakaV2Capabilities(opts, requestId)).toMatchObject({ ok: false, code: 'HTTP' })
  })
})
