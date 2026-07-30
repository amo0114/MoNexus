import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { TOTP } from 'otpauth'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'

/**
 * MFA primitives deliberately live below the auth HTTP layer.  They never
 * log a seed, a recovery code, or a challenge identifier; callers turn the
 * boolean/result unions below into the public error envelope.
 */

export const MFA_TOTP_ALGORITHM = 'SHA1' as const
export const MFA_TOTP_DIGITS = 6
export const MFA_TOTP_PERIOD_SECONDS = 30
export const MFA_TOTP_WINDOW = 1
export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000
export const MFA_CHALLENGE_MAX_ATTEMPTS = 5
export const MFA_RECOVERY_CODE_COUNT = 10

const MFA_SECRET_CIPHERTEXT_VERSION = 'v1'
const MFA_SECRET_IV_BYTES = 12
const MFA_SECRET_AUTH_TAG_BYTES = 16
const MFA_SECRET_AAD = Buffer.from('monexus:mfa-secret:v1', 'utf8')
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const RECOVERY_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RECOVERY_CODE_RAW_LENGTH = 20
const RECOVERY_CODE_GROUP_LENGTH = 5

export const AUTH_CHALLENGE_PURPOSES = [
  'admin_enroll',
  'admin_login',
  'admin_reconfigure',
] as const

export type AuthChallengePurpose = (typeof AUTH_CHALLENGE_PURPOSES)[number]
const AUTH_CHALLENGE_PURPOSE_SET = new Set<string>(AUTH_CHALLENGE_PURPOSES)

/** A deliberately generic error that is safe for callers to map to a 4xx. */
export class MfaCryptoError extends Error {
  constructor() {
    super('MFA secret is unavailable')
    this.name = 'MfaCryptoError'
  }
}

/** Raised only when a deployment has not supplied a usable AES-256 key. */
export class MfaConfigurationError extends Error {
  constructor() {
    super('MFA encryption is not configured')
    this.name = 'MfaConfigurationError'
  }
}

export type MfaEncryptionOptions = {
  /** Injectable only for deterministic unit tests; production uses config. */
  key?: Buffer
}

export type MfaTotpOptions = {
  /** Allows tests and callers with an explicit clock to avoid waiting. */
  now?: Date
  issuer?: string
  accountName?: string
}

export type MfaProvisioningOptions = {
  seed: string
  accountName: string
  issuer?: string
}

export type AuthChallengeRecord = {
  id: string
  userId: number
  purpose: string
  secretEncrypted: string | null
  expiresAt: Date
  consumedAt: Date | null
  failedAttempts: number
  createdAt: Date
}

export type CreateAuthChallengeOptions = {
  userId: number
  purpose: AuthChallengePurpose
  /**
   * A pending enrollment/reconfiguration seed. This module encrypts it before
   * persistence so a future auth caller cannot accidentally write plaintext
   * seed material to AuthChallenge.secretEncrypted.
   */
  pendingSecret?: string | null
  now?: Date
  tx?: Prisma.TransactionClient
}

export type AuthChallengeSelector = {
  challengeId: string
  purpose: AuthChallengePurpose
  /** Supplying this narrows writes to the already-resolved challenge owner. */
  userId?: number
  now?: Date
  tx?: Prisma.TransactionClient
}

export type AuthChallengeLookupResult =
  | { kind: 'active'; challenge: AuthChallengeRecord }
  | { kind: 'invalid' | 'expired' | 'too_many_attempts' }

export type AuthChallengeFailureResult =
  | { kind: 'recorded' }
  | { kind: 'locked' }
  | { kind: 'unavailable' }

export type RecoveryCodeOptions = {
  now?: Date
  tx?: Prisma.TransactionClient
}

function nowFrom(input: Date | undefined) {
  const now = input ? new Date(input.getTime()) : new Date()
  if (!Number.isFinite(now.getTime())) throw new TypeError('A valid MFA clock is required')
  return now
}

function getEncryptionKey(key: Buffer | undefined) {
  const configuredKey = key ?? config.mfaEncryptionKey
  if (!configuredKey || configuredKey.length !== 32) throw new MfaConfigurationError()
  return configuredKey
}

function encodeBase64Url(value: Uint8Array) {
  return Buffer.from(value).toString('base64url')
}

function decodeCanonicalBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null

  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length === 0 || decoded.toString('base64url') !== value) return null
  return decoded
}

function parseEncryptedSecret(encrypted: string) {
  const parts = encrypted.split('.')
  if (parts.length !== 4 || parts[0] !== MFA_SECRET_CIPHERTEXT_VERSION) throw new MfaCryptoError()

  const iv = decodeCanonicalBase64Url(parts[1])
  const ciphertext = decodeCanonicalBase64Url(parts[2])
  const authTag = decodeCanonicalBase64Url(parts[3])
  if (!iv || !ciphertext || !authTag || iv.length !== MFA_SECRET_IV_BYTES || authTag.length !== MFA_SECRET_AUTH_TAG_BYTES) {
    throw new MfaCryptoError()
  }

  return { iv, ciphertext, authTag }
}

/**
 * Encrypts a seed with authenticated AES-256-GCM.  The version, IV,
 * ciphertext, and authentication tag are all persisted in one opaque value.
 */
export function encryptMfaSecret(secret: string, options: MfaEncryptionOptions = {}) {
  if (typeof secret !== 'string' || secret.length === 0) throw new MfaCryptoError()

  const key = getEncryptionKey(options.key)
  const iv = randomBytes(MFA_SECRET_IV_BYTES)

  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(MFA_SECRET_AAD)
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()

    return [
      MFA_SECRET_CIPHERTEXT_VERSION,
      encodeBase64Url(iv),
      encodeBase64Url(ciphertext),
      encodeBase64Url(authTag),
    ].join('.')
  } catch {
    // Never expose OpenSSL parsing, tag, or key details to an API caller.
    throw new MfaCryptoError()
  }
}

/**
 * Decrypts only the current format.  Any malformed, tampered, or wrong-key
 * ciphertext receives the same safe error so it cannot be used as an oracle.
 */
export function decryptMfaSecret(encrypted: string, options: MfaEncryptionOptions = {}) {
  const key = getEncryptionKey(options.key)

  try {
    const { iv, ciphertext, authTag } = parseEncryptedSecret(encrypted)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(MFA_SECRET_AAD)
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch (error) {
    if (error instanceof MfaConfigurationError) throw error
    throw new MfaCryptoError()
  }
}

function encodeBase32(value: Uint8Array) {
  let output = ''
  let buffer = 0
  let bits = 0

  for (const byte of value) {
    buffer = (buffer << 8) | byte
    bits += 8

    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
  }

  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31]
  return output
}

function normalizeTotpSeed(seed: string) {
  const normalized = seed.replace(/[\s-]/g, '').toUpperCase()
  return /^[A-Z2-7]+$/.test(normalized) ? normalized : null
}

function createTotp(seed: string, options: Pick<MfaTotpOptions, 'issuer' | 'accountName'> = {}) {
  const normalizedSeed = normalizeTotpSeed(seed)
  if (!normalizedSeed) throw new MfaCryptoError()

  return new TOTP({
    issuer: options.issuer ?? 'MoNexus',
    label: options.accountName ?? 'administrator',
    algorithm: MFA_TOTP_ALGORITHM,
    digits: MFA_TOTP_DIGITS,
    period: MFA_TOTP_PERIOD_SECONDS,
    secret: normalizedSeed,
  })
}

/** Generates a 160-bit RFC 4648 base32 TOTP seed without padding. */
export function generateTotpSeed() {
  return encodeBase32(randomBytes(20))
}

export function createMfaProvisioningUri(options: MfaProvisioningOptions) {
  if (!options.accountName.trim()) throw new MfaCryptoError()
  if (options.issuer !== undefined && !options.issuer.trim()) throw new MfaCryptoError()

  return createTotp(options.seed, {
    issuer: options.issuer,
    accountName: options.accountName,
  }).toString()
}

/** Generates a fixed-format RFC 6238 SHA-1 / six-digit / 30-second token. */
export function generateTotp(seed: string, options: MfaTotpOptions = {}) {
  return createTotp(seed, options).generate({ timestamp: nowFrom(options.now).getTime() })
}

/**
 * Validates only the current, previous, or following time step.  Invalid seed
 * or token input returns false rather than exposing parser details.
 */
export function verifyTotp(seed: string, token: string, options: MfaTotpOptions = {}) {
  if (!/^\d{6}$/.test(token)) return false

  try {
    return createTotp(seed, options).validate({
      token,
      window: MFA_TOTP_WINDOW,
      timestamp: nowFrom(options.now).getTime(),
    }) !== null
  } catch {
    return false
  }
}

function formatRecoveryCode(raw: string) {
  const groups = raw.match(new RegExp(`.{1,${RECOVERY_CODE_GROUP_LENGTH}}`, 'g'))
  return groups?.join('-') ?? raw
}

function normalizeRecoveryCode(code: string) {
  return code
    .replace(/[\s-]/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
}

/**
 * Generates ten independent 100-bit recovery codes.  Each character consumes
 * five uniform random bits, so no modulo bias is introduced by formatting.
 */
export function generateMfaRecoveryCodes() {
  const codes = new Set<string>()

  while (codes.size < MFA_RECOVERY_CODE_COUNT) {
    const bytes = randomBytes(RECOVERY_CODE_RAW_LENGTH)
    let raw = ''
    for (const byte of bytes) raw += RECOVERY_CODE_ALPHABET[byte & 31]
    codes.add(formatRecoveryCode(raw))
  }

  return [...codes]
}

/**
 * Recovery codes have 100 bits of CSPRNG entropy, so a namespaced SHA-256
 * digest is sufficient for lookup without retaining recoverable plaintext.
 */
export function hashMfaRecoveryCode(code: string) {
  return createHash('sha256')
    .update(`monexus:mfa-recovery:v1:${normalizeRecoveryCode(code)}`)
    .digest('hex')
}

type MfaRecoveryCodeClient = Pick<typeof prisma, 'mfaRecoveryCode'>
type AuthChallengeClient = Pick<typeof prisma, 'authChallenge'>

function recoveryClient(tx?: Prisma.TransactionClient): MfaRecoveryCodeClient {
  return tx ?? prisma
}

function challengeClient(tx?: Prisma.TransactionClient): AuthChallengeClient {
  return tx ?? prisma
}

/**
 * Replaces the active code set atomically.  Callers already in a broader
 * auth transaction pass its tx so enabling MFA and issuing codes commit as
 * one unit; standalone use receives its own transaction.
 */
export async function replaceMfaRecoveryCodes(userId: number, options: RecoveryCodeOptions = {}) {
  const codes = generateMfaRecoveryCodes()
  const hashes = codes.map(hashMfaRecoveryCode)
  const now = nowFrom(options.now)

  const write = async (client: MfaRecoveryCodeClient) => {
    await client.mfaRecoveryCode.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: now },
    })
    await client.mfaRecoveryCode.createMany({
      data: hashes.map(codeHash => ({ userId, codeHash })),
    })
  }

  if (options.tx) {
    await write(options.tx)
  } else {
    await prisma.$transaction(async tx => write(tx))
  }

  return codes
}

/**
 * Claims a code with one conditional SQL UPDATE.  Concurrent requests can
 * observe at most one affected row, so a recovery code cannot be replayed.
 */
export async function claimMfaRecoveryCode(userId: number, code: string, options: RecoveryCodeOptions = {}) {
  const result = await recoveryClient(options.tx).mfaRecoveryCode.updateMany({
    where: {
      userId,
      codeHash: hashMfaRecoveryCode(code),
      usedAt: null,
    },
    data: { usedAt: nowFrom(options.now) },
  })

  return result.count === 1
}

export async function countUnusedMfaRecoveryCodes(userId: number, tx?: Prisma.TransactionClient) {
  return recoveryClient(tx).mfaRecoveryCode.count({ where: { userId, usedAt: null } })
}

function challengeScope(selector: AuthChallengeSelector, now: Date): Prisma.AuthChallengeWhereInput {
  if (!AUTH_CHALLENGE_PURPOSE_SET.has(selector.purpose)) {
    throw new Error('MFA challenge purpose is invalid')
  }

  return {
    id: selector.challengeId,
    purpose: selector.purpose,
    ...(selector.userId === undefined ? {} : { userId: selector.userId }),
    consumedAt: null,
    expiresAt: { gt: now },
  }
}

/** Creates an opaque pre-auth challenge with the fixed five-minute TTL. */
export async function createAuthChallenge(options: CreateAuthChallengeOptions): Promise<AuthChallengeRecord> {
  if (!AUTH_CHALLENGE_PURPOSE_SET.has(options.purpose)) {
    throw new Error('MFA challenge purpose is invalid')
  }

  const now = nowFrom(options.now)
  const secretEncrypted = options.pendingSecret === undefined || options.pendingSecret === null
    ? null
    : encryptMfaSecret(options.pendingSecret)

  return challengeClient(options.tx).authChallenge.create({
    data: {
      userId: options.userId,
      purpose: options.purpose,
      secretEncrypted,
      expiresAt: new Date(now.getTime() + MFA_CHALLENGE_TTL_MS),
    },
  })
}

/**
 * Reads a challenge for a factor check without changing it.  In particular,
 * an invalid TOTP must not consume a still-valid challenge before its fifth
 * recorded failure.
 */
export async function getUsableAuthChallenge(selector: AuthChallengeSelector): Promise<AuthChallengeLookupResult> {
  if (!AUTH_CHALLENGE_PURPOSE_SET.has(selector.purpose)) {
    throw new Error('MFA challenge purpose is invalid')
  }

  const now = nowFrom(selector.now)
  const challenge = await challengeClient(selector.tx).authChallenge.findFirst({
    where: {
      id: selector.challengeId,
      purpose: selector.purpose,
      ...(selector.userId === undefined ? {} : { userId: selector.userId }),
    },
  })

  if (!challenge) return { kind: 'invalid' }
  if (challenge.failedAttempts >= MFA_CHALLENGE_MAX_ATTEMPTS) return { kind: 'too_many_attempts' }
  if (challenge.consumedAt) return { kind: 'invalid' }
  if (challenge.expiresAt <= now) return { kind: 'expired' }
  return { kind: 'active', challenge }
}

/**
 * Records an unsuccessful factor validation.  Attempts one through four only
 * increment the counter.  The fifth atomically both reaches the limit and
 * consumes the challenge, so no later correct code can win a race.
 */
export async function recordAuthChallengeFailure(selector: AuthChallengeSelector): Promise<AuthChallengeFailureResult> {
  const now = nowFrom(selector.now)
  const client = challengeClient(selector.tx)
  const scope = challengeScope(selector, now)

  const recorded = await client.authChallenge.updateMany({
    where: {
      ...scope,
      failedAttempts: { lt: MFA_CHALLENGE_MAX_ATTEMPTS - 1 },
    },
    data: { failedAttempts: { increment: 1 } },
  })
  if (recorded.count === 1) return { kind: 'recorded' }

  const locked = await client.authChallenge.updateMany({
    where: {
      ...scope,
      failedAttempts: {
        gte: MFA_CHALLENGE_MAX_ATTEMPTS - 1,
        lt: MFA_CHALLENGE_MAX_ATTEMPTS,
      },
    },
    data: {
      failedAttempts: MFA_CHALLENGE_MAX_ATTEMPTS,
      consumedAt: now,
    },
  })

  return locked.count === 1 ? { kind: 'locked' } : { kind: 'unavailable' }
}

/**
 * Conditionally consumes a challenge only after the caller has verified the
 * supplied TOTP or recovery code.  The same predicate also makes competing
 * successful submissions single-winner and rejects expiry/lock races.
 */
export async function consumeAuthChallenge(selector: AuthChallengeSelector) {
  const now = nowFrom(selector.now)
  const result = await challengeClient(selector.tx).authChallenge.updateMany({
    where: {
      ...challengeScope(selector, now),
      failedAttempts: { lt: MFA_CHALLENGE_MAX_ATTEMPTS },
    },
    data: { consumedAt: now },
  })

  return result.count === 1
}
