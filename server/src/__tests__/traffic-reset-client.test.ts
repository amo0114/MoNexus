import vector from './fixtures/traffic-reset-v2.json'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { callResetPreview, callTrafficReset, resetPayloadHash, type ResetPayload } from '../lib/fakaBridge/resetV2.js'
import type { FakaTransport } from '../lib/fakaBridge/types.js'
const snapshot = { plan_id: '3', transfer_enable: '1000', expired_at: null, last_reset_at: null, reset_count: '0', next_reset_at: null, u: '100', d: '20' }
const payload: ResetPayload = { operation_id: randomUUID(), actor_ref: '11', user_id: '42', benefit_code: 'welcome_traffic_reset_v1', expected_plan_id: '3', subscription_fingerprint: 'a'.repeat(64) }
function opts(mutate: (body: any) => void = () => {}) {
  const transport = vi.fn<FakaTransport>().mockImplementation(async req => {
    const sent = JSON.parse(req.body!)
    const body = { success: true, protocol_version: 2, request_id: sent.request_id, queried_at: new Date().toISOString(),
      operation: { operation_id: payload.operation_id, payload_hash: resetPayloadHash(payload), status: 'succeeded', error_code: null,
        before: snapshot, after: { ...snapshot, reset_count: '1', u: '0', d: '0' }, completed_at: new Date().toISOString() } }
    mutate(body)
    return { status: 200, text: JSON.stringify(body) }
  })
  return { url: 'https://xboard.test/plugin/faka-bridge/order-paid', secret: 'test-bridge', transport }
}
describe('reset bridge response binding', () => {
  it('matches independently calculated cross-language payload vector', () => { expect(resetPayloadHash(vector.payload as ResetPayload)).toBe(vector.payloadHash) })
  it('keeps operation semantics and body hash fixed across execute/status/cancel', async () => {
    const options = opts()
    for (const action of ['traffic-reset','traffic-reset-status','traffic-reset-cancel'] as const) expect((await callTrafficReset(action, payload, options)).ok).toBe(true)
    const requests = options.transport.mock.calls.map(c => c[0])
    expect(new Set(requests.map(r => r.headers['x-monexus-nonce'])).size).toBe(3)
    expect(requests.map(r => new URL(r.url).pathname)).toEqual(['/plugin/faka-bridge/v2/traffic-reset','/plugin/faka-bridge/v2/traffic-reset-status','/plugin/faka-bridge/v2/traffic-reset-cancel'])
  })
  it.each(['request','operation','hash','usage','count','plan','malformed'] as const)('rejects %s corruption without accepting a terminal result', async key => {
    const options = opts(body => {
      if (key === 'request') body.request_id = randomUUID()
      if (key === 'operation') body.operation.operation_id = randomUUID()
      if (key === 'hash') body.operation.payload_hash = 'b'.repeat(64)
      if (key === 'usage') body.operation.after.u = '1'
      if (key === 'count') body.operation.after.reset_count = '0'
      if (key === 'plan') body.operation.after.plan_id = '4'
      if (key === 'malformed') body.operation.after.reset_count = '1e3'
    })
    expect(await callTrafficReset('traffic-reset', payload, options)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' })
  })
  it('binds preview identity and rejects unrequested/contradictory eligibility', async () => {
    const options = opts(body => { delete body.operation; body.preview = { user_id: '43', plan_id: '3', fingerprint: 'a'.repeat(64), eligible: true, block_reason: null, snapshot } })
    expect(await callResetPreview('42', options)).toMatchObject({ ok: false, code: 'INVALID_RESPONSE' })
    expect(await callTrafficReset('traffic-reset', { ...payload, user_id: '0' }, options)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(options.transport).toHaveBeenCalledTimes(1)
  })
})
