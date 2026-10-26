import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import vectors from './fixtures/signed-protocol-v2.json'
import { prepareSignedJsonV2, signProtocolV2, verifyProtocolV2, PROTOCOL_V2_WINDOW_MS, type ProtocolV2Message } from '../lib/signedProtocolV2.js'

function message(vector = vectors.vectors[0]): ProtocolV2Message {
  return { ...vector, audience: vector.audience as ProtocolV2Message['audience'], rawBody: Buffer.from(vector.rawBody, 'utf8') }
}

describe('signed protocol v2 foundation (not a replay/idempotency gate)', () => {
  it.each(vectors.vectors)('matches independent Python hashlib/hmac vector for $audience', vector => {
    expect(createHash('sha256').update(message(vector).rawBody).digest('hex')).toBe(vector.bodyHash)
    expect(signProtocolV2(message(vector), vector.secret)).toBe(vector.signature)
    expect(verifyProtocolV2(message(vector), vector.signature, vector.secret, vector.timestampMs)).toBe(true)
  })

  it('signs actual UTF-8 bytes and refuses body, method, path, audience or key substitution', () => {
    const v = vectors.vectors[0], original = message()
    for (const changed of [
      { ...original, rawBody: Buffer.from(JSON.stringify(JSON.parse(v.rawBody), null, 2)) },
      { ...original, rawBody: Buffer.from(v.rawBody.replace('12345678', '87654321')) },
      { ...original, method: 'GET' },
      { ...original, path: '/api/bot/v2/xboard/accounts' },
      { ...original, audience: 'xboard' as const },
      { ...original, path: '/plugin/faka-bridge/v2/capabilities', audience: 'xboard' as const },
    ]) expect(verifyProtocolV2(changed, v.signature, v.secret, v.timestampMs)).toBe(false)
    expect(verifyProtocolV2(original, v.signature, 'another-key', v.timestampMs)).toBe(false)
  })

  it('accepts only the bounded clock window, including exact boundaries', () => {
    const v = vectors.vectors[0], m = message()
    for (const sign of [-1, 1]) {
      expect(verifyProtocolV2(m, v.signature, v.secret, v.timestampMs + sign * PROTOCOL_V2_WINDOW_MS)).toBe(true)
      expect(verifyProtocolV2(m, v.signature, v.secret, v.timestampMs + sign * (PROTOCOL_V2_WINDOW_MS + 1))).toBe(false)
    }
  })

  it.each(['abc', '', 'a'.repeat(31), 'A'.repeat(32)])('rejects malformed nonce %s', nonce => {
    const v = vectors.vectors[0]
    expect(verifyProtocolV2({ ...message(), nonce }, v.signature, v.secret, v.timestampMs)).toBe(false)
  })

  it.each(['/api/bot/v2/xboard/profile?userId=7', '/api/bot/v2/xboard//profile', '/api/bot/v2/xboard/%70rofile', '/v2/xboard/profile', '/api/bot/v2/xboard/../profile'])('rejects noncanonical or mounted-only path %s', path => {
    expect(() => signProtocolV2({ ...message(), path }, 'test')).toThrow()
  })

  it('serializes once; retries preserve body but generate fresh nonces', () => {
    const input = { audience: 'bot' as const, path: '/api/bot/v2/xboard/profile', body: { platform: 'qq', requestId: 'same-request', text: '流量' }, secret: 'test' }
    const a = prepareSignedJsonV2(input), b = prepareSignedJsonV2(input)
    expect(a.body).toBe(b.body)
    expect(a.headers['x-monexus-nonce']).not.toBe(b.headers['x-monexus-nonce'])
    expect(a.headers['x-monexus-signature']).not.toBe(b.headers['x-monexus-signature'])
    expect(a.headers['x-monexus-signature-version']).toBe('2')
    expect(verifyProtocolV2({ audience: 'bot', method: a.method, path: a.path,
      timestampMs: Number(a.headers['x-monexus-timestamp']), nonce: a.headers['x-monexus-nonce'], rawBody: Buffer.from(a.body),
    }, a.headers['x-monexus-signature'], input.secret)).toBe(true)
    expect(verifyProtocolV2(message(), 'invalid', 'test', vectors.vectors[0].timestampMs)).toBe(false)
    expect(() => prepareSignedJsonV2({ ...input, body: undefined })).toThrow()
  })
})
