import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export type ProtocolV2Audience = 'bot' | 'xboard'
export interface ProtocolV2Message {
  audience: ProtocolV2Audience
  method: string
  /** External full path, before any Express router mount is stripped. */
  path: string
  timestampMs: number
  nonce: string
  rawBody: Uint8Array
}

export const PROTOCOL_V2_WINDOW_MS = 5 * 60 * 1000

function assertEnvelope(message: ProtocolV2Message) {
  const prefix = message.audience === 'bot' ? '/api/bot/v2/xboard/'
    : message.audience === 'xboard' ? '/plugin/faka-bridge/v2/' : null
  if (!prefix || message.method !== 'POST' || !message.path.startsWith(prefix)
    || message.path.length > 200 || !/^(?:\/[a-z0-9-]+)+$/.test(message.path)
    || !Number.isSafeInteger(message.timestampMs) || message.timestampMs < 0
    || !/^[a-f0-9]{32}$/.test(message.nonce)) {
    throw new Error('Invalid signed protocol v2 envelope')
  }
}

/** Hash actual UTF-8 wire bytes; never reconstruct JSON from parsed objects. */
export function signProtocolV2(message: ProtocolV2Message, secret: string): string {
  assertEnvelope(message)
  if (!secret) throw new Error('Signed protocol v2 secret is required')
  const bodyHash = createHash('sha256').update(message.rawBody).digest('hex')
  const payload = JSON.stringify(['monexus-hmac-v2', message.audience, message.method,
    message.path, message.timestampMs, message.nonce, bodyHash])
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex')
}

/** Cryptographic/time check only. Receivers must ALSO atomically consume the
 * nonce and enforce business request/operation idempotency before execution. */
export function verifyProtocolV2(message: ProtocolV2Message, signature: string, secret: string, nowMs = Date.now()): boolean {
  if (!Number.isSafeInteger(nowMs) || !/^[a-f0-9]{64}$/.test(signature)
    || Math.abs(nowMs - message.timestampMs) > PROTOCOL_V2_WINDOW_MS) return false
  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(signProtocolV2(message, secret), 'hex'))
  } catch {
    return false
  }
}

/** Serializes exactly once. Send `body` unchanged; do not pass it through a
 * second JSON serializer. Retries keep body requestId but get a new nonce. */
export function prepareSignedJsonV2(input: {
  audience: ProtocolV2Audience; path: string; body: unknown; secret: string
}, timestampMs = Date.now(), nonce = randomBytes(16).toString('hex')) {
  const body = JSON.stringify(input.body)
  if (body === undefined) throw new Error('Signed protocol v2 requires a JSON body')
  const message: ProtocolV2Message = {
    audience: input.audience, method: 'POST', path: input.path,
    timestampMs, nonce, rawBody: Buffer.from(body, 'utf8'),
  }
  return {
    method: 'POST' as const, path: input.path, body,
    headers: {
      'content-type': 'application/json',
      'x-monexus-signature-version': '2',
      'x-monexus-timestamp': String(timestampMs),
      'x-monexus-nonce': nonce,
      'x-monexus-signature': signProtocolV2(message, input.secret),
    },
  }
}
