import { createHmac, randomBytes } from 'node:crypto'
import { createChallenge, extractParams, verifySolution } from 'altcha-lib/v1'
import type { Payload } from 'altcha-lib/v1/types'
import { config } from '../../../config/index.js'
import { runRedisCommandWithTimeout } from '../../../lib/redis.js'
import {
  ALTCHA_PROTOCOL_VERSION,
  HUMAN_VERIFICATION_PAYLOAD_MAX_BYTES,
  REJECTED,
  UNAVAILABLE,
  VERIFIED,
  type HumanVerificationAction,
  type HumanVerificationResult,
  type HumanVerifier,
} from './types.js'

export type AltchaChallenge = {
  algorithm: 'SHA-256'
  challenge: string
  maxnumber: number
  salt: string
  signature: string
}

export type AltchaNonceConsumeResult = 'consumed' | 'replay' | 'unavailable'

export type AltchaHumanVerifierOptions = {
  hmacKey?: string | Buffer
  hashKey?: Buffer
  maxNumber?: number
  challengeTtlSec?: number
  consumeNonce?: (nonce: string, ttlSec: number) => Promise<AltchaNonceConsumeResult>
}

const MAX_SALT_LENGTH = 512
const NONCE_BYTES = 16

function hmacKeyString(value: string | Buffer | undefined): string | undefined {
  if (!value) return undefined
  return typeof value === 'string' ? value : value.toString('base64')
}

function configuredHmacKey(options: AltchaHumanVerifierOptions): string | undefined {
  return hmacKeyString(options.hmacKey ?? config.altcha.hmacKey)
}

function configuredHashKey(options: AltchaHumanVerifierOptions): Buffer | undefined {
  const key = options.hashKey ?? config.abuseHashKey
  if (!key || !Buffer.isBuffer(key) || key.length !== 32) return undefined
  return key
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function payloadByteLength(value: string) {
  return Buffer.byteLength(value, 'utf8')
}

function parseAltchaPayload(raw: string): Payload | undefined {
  if (payloadByteLength(raw) > HUMAN_VERIFICATION_PAYLOAD_MAX_BYTES) return undefined

  let decoded: unknown = raw
  if (raw.trim().startsWith('{')) {
    try {
      decoded = JSON.parse(raw)
    } catch {
      return undefined
    }
  } else {
    try {
      decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))
    } catch {
      return undefined
    }
  }

  if (!isRecord(decoded)) return undefined
  if (decoded.algorithm !== 'SHA-256') return undefined
  if (typeof decoded.challenge !== 'string' || decoded.challenge.length === 0 || decoded.challenge.length > 256) {
    return undefined
  }
  if (typeof decoded.salt !== 'string' || decoded.salt.length === 0 || decoded.salt.length > MAX_SALT_LENGTH) {
    return undefined
  }
  if (typeof decoded.signature !== 'string' || decoded.signature.length === 0 || decoded.signature.length > 256) {
    return undefined
  }
  if (typeof decoded.number !== 'number' || !Number.isInteger(decoded.number) || decoded.number < 0) {
    return undefined
  }

  return {
    algorithm: 'SHA-256',
    challenge: decoded.challenge,
    number: decoded.number,
    salt: decoded.salt,
    signature: decoded.signature,
  }
}

function nonceRedisKey(nonce: string, hashKey: Buffer): string {
  const digest = createHmac('sha256', hashKey)
    .update(`v1\0altcha-nonce\0${nonce}`, 'utf8')
    .digest('hex')
  return `${config.cacheKeyPrefix}:abuse:v1:human-challenge:nonce:${digest}`
}

async function redisConsumeNonce(nonce: string, ttlSec: number, hashKey: Buffer): Promise<AltchaNonceConsumeResult> {
  const key = nonceRedisKey(nonce, hashKey)
  const ttl = Math.min(Math.max(1, Math.floor(ttlSec)), 3_600)
  try {
    const result = await runRedisCommandWithTimeout('altcha_nonce_set', async client => {
      return client.set(key, 'consumed', 'EX', ttl, 'NX')
    })
    if (result === 'OK' || result === true) return 'consumed'
    if (result === null || result === undefined || result === false) return 'replay'
    return 'unavailable'
  } catch {
    return 'unavailable'
  }
}

function remainingTtlSec(expiresUnix: string | undefined, fallbackSec: number): number {
  if (!expiresUnix) return fallbackSec
  const expiresAtMs = Number.parseInt(expiresUnix, 10) * 1_000
  if (!Number.isFinite(expiresAtMs)) return fallbackSec
  const remaining = Math.ceil((expiresAtMs - Date.now()) / 1_000)
  if (!Number.isFinite(remaining)) return fallbackSec
  return Math.min(fallbackSec, Math.max(1, remaining))
}

export async function issueAltchaChallenge(
  action: HumanVerificationAction,
  options: AltchaHumanVerifierOptions = {},
): Promise<AltchaChallenge | { kind: 'unavailable' }> {
  const hmacKey = configuredHmacKey(options)
  const maxNumber = options.maxNumber ?? config.altcha.maxNumber
  const challengeTtlSec = options.challengeTtlSec ?? config.altcha.challengeTtlSec
  if (!hmacKey) return { kind: 'unavailable' }

  const nonce = randomBytes(NONCE_BYTES).toString('hex')
  const challenge = await createChallenge({
    algorithm: 'SHA-256',
    hmacKey,
    maxNumber,
    saltLength: NONCE_BYTES,
    expires: new Date(Date.now() + challengeTtlSec * 1_000),
    params: {
      nonce,
      action,
      version: ALTCHA_PROTOCOL_VERSION,
    },
  })

  return {
    algorithm: 'SHA-256',
    challenge: challenge.challenge,
    maxnumber: challenge.maxnumber ?? maxNumber,
    salt: challenge.salt,
    signature: challenge.signature,
  }
}

export function createAltchaHumanVerifier(
  options: AltchaHumanVerifierOptions = {},
): HumanVerifier {
  const hmacKey = configuredHmacKey(options)
  const hashKey = configuredHashKey(options)
  const challengeTtlSec = options.challengeTtlSec ?? config.altcha.challengeTtlSec
  const consumeNonce = options.consumeNonce

  return {
    async verify(input): Promise<HumanVerificationResult> {
      const raw = typeof input.payload === 'string' ? input.payload.trim() : ''
      if (!raw) return REJECTED
      if (payloadByteLength(raw) > HUMAN_VERIFICATION_PAYLOAD_MAX_BYTES) return REJECTED

      const parsed = parseAltchaPayload(raw)
      if (!parsed) return REJECTED
      if (!hmacKey || !hashKey) return UNAVAILABLE

      let verified: boolean
      try {
        verified = await verifySolution(parsed, hmacKey, true)
      } catch {
        return UNAVAILABLE
      }
      if (!verified) return REJECTED

      let params: Record<string, string>
      try {
        params = extractParams(parsed)
      } catch {
        return REJECTED
      }
      if (params.action !== input.action) return REJECTED
      if (params.version !== ALTCHA_PROTOCOL_VERSION) return REJECTED
      const nonce = params.nonce
      if (!nonce || nonce.length !== NONCE_BYTES * 2) return REJECTED

      const consume = consumeNonce
        ?? ((value: string, ttlSec: number) => redisConsumeNonce(value, ttlSec, hashKey))
      const consumption = await consume(nonce, remainingTtlSec(params.expires, challengeTtlSec))
      if (consumption === 'unavailable') return UNAVAILABLE
      if (consumption === 'replay') return REJECTED
      return VERIFIED
    },
  }
}
