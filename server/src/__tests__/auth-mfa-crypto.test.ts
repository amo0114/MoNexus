import { describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import {
  MFA_CHALLENGE_MAX_ATTEMPTS,
  MFA_CHALLENGE_TTL_MS,
  MFA_RECOVERY_CODE_COUNT,
  claimMfaRecoveryCode,
  consumeAuthChallenge,
  countUnusedMfaRecoveryCodes,
  createAuthChallenge,
  createMfaProvisioningUri,
  decryptMfaSecret,
  encryptMfaSecret,
  generateMfaRecoveryCodes,
  generateTotp,
  generateTotpSeed,
  getUsableAuthChallenge,
  hashMfaRecoveryCode,
  recordAuthChallengeFailure,
  replaceMfaRecoveryCodes,
  verifyTotp,
} from '../modules/auth/mfa.js'
import { createTestUser } from './helpers.js'

const TEST_MFA_KEY = Buffer.alloc(32, 23)
const FIXED_NOW = new Date('2026-07-27T12:00:11.000Z')

describe('MFA crypto primitives', () => {
  it('encrypts each TOTP seed with an independent AES-GCM IV and safely rejects tampering', () => {
    const seed = generateTotpSeed()
    const first = encryptMfaSecret(seed, { key: TEST_MFA_KEY })
    const second = encryptMfaSecret(seed, { key: TEST_MFA_KEY })

    expect(first !== second).toBe(true)
    // Keep a failure from rendering this test-only seed in Vitest output.
    expect(!first.includes(seed) && decryptMfaSecret(first, { key: TEST_MFA_KEY }) === seed).toBe(true)

    const [version, iv, ciphertext, tag] = first.split('.')
    const tamperedTag = `${tag.slice(0, -1)}${tag.endsWith('A') ? 'B' : 'A'}`
    const tampered = [version, iv, ciphertext, tamperedTag].join('.')

    expect(() => decryptMfaSecret(tampered, { key: TEST_MFA_KEY })).toThrow('MFA secret is unavailable')
    expect(() => decryptMfaSecret(first, { key: Buffer.alloc(32, 24) })).toThrow('MFA secret is unavailable')
  })

  it('uses RFC 6238 SHA-1, six digits, a 30-second period, and only a ±1 window', () => {
    const seed = generateTotpSeed()
    const token = generateTotp(seed, { now: FIXED_NOW })
    const provisioningUri = createMfaProvisioningUri({
      seed,
      issuer: 'MoNexus',
      accountName: 'admin@mfa.test',
    })
    const parsedUri = new URL(provisioningUri)

    expect(/^\d{6}$/.test(token)).toBe(true)
    expect(verifyTotp(seed, token, { now: FIXED_NOW })).toBe(true)
    expect(verifyTotp(seed, token, { now: new Date(FIXED_NOW.getTime() - 30_000) })).toBe(true)
    expect(verifyTotp(seed, token, { now: new Date(FIXED_NOW.getTime() + 30_000) })).toBe(true)
    expect(verifyTotp(seed, token, { now: new Date(FIXED_NOW.getTime() + 60_000) })).toBe(false)

    expect(parsedUri.protocol).toBe('otpauth:')
    expect(parsedUri.hostname).toBe('totp')
    expect(parsedUri.searchParams.get('algorithm')).toBe('SHA1')
    expect(parsedUri.searchParams.get('digits')).toBe('6')
    expect(parsedUri.searchParams.get('period')).toBe('30')
    const uriSecret = parsedUri.searchParams.get('secret')
    expect(typeof uriSecret === 'string' && /^[A-Z2-7]{32}$/.test(uriSecret)).toBe(true)
  })
})

describe('MFA recovery codes', () => {
  it('generates exactly ten high-entropy codes and persists only their hashes', async () => {
    const codes = generateMfaRecoveryCodes()
    const hashes = codes.map(hashMfaRecoveryCode)
    const { user } = await createTestUser('mfa-recovery-hashes@test.local')

    expect(codes.length === MFA_RECOVERY_CODE_COUNT && new Set(codes).size === MFA_RECOVERY_CODE_COUNT).toBe(true)
    expect(codes.every(code => /^[0-9A-Z]{5}(?:-[0-9A-Z]{5}){3}$/.test(code))).toBe(true)
    expect(new Set(hashes).size === MFA_RECOVERY_CODE_COUNT).toBe(true)
    expect(hashes.every(hash => /^[a-f0-9]{64}$/.test(hash))).toBe(true)

    await prisma.mfaRecoveryCode.create({
      data: { userId: user.id, codeHash: hashes[0] },
    })
    const stored = await prisma.mfaRecoveryCode.findFirstOrThrow({ where: { userId: user.id } })

    // Do not render a test recovery code in an assertion failure.
    expect(stored.codeHash === hashes[0] && stored.codeHash !== codes[0]).toBe(true)
  })

  it('claims a recovery code with one conditional update under concurrent use', async () => {
    const { user } = await createTestUser('mfa-recovery-claim@test.local')
    const [code] = generateMfaRecoveryCodes()

    await prisma.mfaRecoveryCode.create({
      data: { userId: user.id, codeHash: hashMfaRecoveryCode(code) },
    })

    const claims = await Promise.all([
      claimMfaRecoveryCode(user.id, code, { now: FIXED_NOW }),
      claimMfaRecoveryCode(user.id, code, { now: FIXED_NOW }),
    ])

    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(await claimMfaRecoveryCode(user.id, code, { now: FIXED_NOW })).toBe(false)
    expect(await countUnusedMfaRecoveryCodes(user.id)).toBe(0)
  })

  it('atomically retires prior active recovery codes when generating a replacement set', async () => {
    const { user } = await createTestUser('mfa-recovery-replace@test.local')
    const [oldCode] = generateMfaRecoveryCodes()

    await prisma.mfaRecoveryCode.create({
      data: { userId: user.id, codeHash: hashMfaRecoveryCode(oldCode) },
    })

    const replacementCodes = await replaceMfaRecoveryCodes(user.id, { now: FIXED_NOW })
    const oldStored = await prisma.mfaRecoveryCode.findFirstOrThrow({
      where: { userId: user.id, codeHash: hashMfaRecoveryCode(oldCode) },
    })

    expect(replacementCodes.length === MFA_RECOVERY_CODE_COUNT).toBe(true)
    expect(oldStored.usedAt).toEqual(FIXED_NOW)
    expect(await countUnusedMfaRecoveryCodes(user.id)).toBe(MFA_RECOVERY_CODE_COUNT)
  })
})

describe('MFA pre-auth challenges', () => {
  it('rejects an unknown purpose before any challenge row can be created', async () => {
    await expect(createAuthChallenge({
      userId: 1,
      purpose: 'untrusted_purpose' as never,
      now: FIXED_NOW,
    })).rejects.toThrow('MFA challenge purpose is invalid')
  })

  it('creates a five-minute challenge and does not consume it for an incorrect verification attempt', async () => {
    const { user } = await createTestUser('mfa-challenge-failure@test.local')
    const pendingSeed = generateTotpSeed()
    const challenge = await createAuthChallenge({
      userId: user.id,
      purpose: 'admin_enroll',
      pendingSecret: pendingSeed,
      now: FIXED_NOW,
    })

    expect(challenge.expiresAt.getTime()).toBe(FIXED_NOW.getTime() + MFA_CHALLENGE_TTL_MS)
    expect(
      challenge.secretEncrypted !== pendingSeed
      && decryptMfaSecret(challenge.secretEncrypted ?? '') === pendingSeed,
    ).toBe(true)
    const usableChallenge = await getUsableAuthChallenge({
      challengeId: challenge.id,
      userId: user.id,
      purpose: 'admin_enroll',
      now: FIXED_NOW,
    })
    expect(usableChallenge.kind).toBe('active')

    expect(await recordAuthChallengeFailure({
      challengeId: challenge.id,
      userId: user.id,
      purpose: 'admin_enroll',
      now: FIXED_NOW,
    })).toEqual({ kind: 'recorded' })

    const afterFailure = await prisma.authChallenge.findUniqueOrThrow({ where: { id: challenge.id } })
    expect(afterFailure.failedAttempts).toBe(1)
    expect(afterFailure.consumedAt).toBeNull()

    expect(await consumeAuthChallenge({
      challengeId: challenge.id,
      userId: user.id,
      purpose: 'admin_enroll',
      now: FIXED_NOW,
    })).toBe(true)
  })

  it('locks and consumes the challenge on the fifth failed attempt, preventing any later verification', async () => {
    const { user } = await createTestUser('mfa-challenge-lock@test.local')
    const challenge = await createAuthChallenge({
      userId: user.id,
      purpose: 'admin_login',
      now: FIXED_NOW,
    })

    for (let attempt = 1; attempt < MFA_CHALLENGE_MAX_ATTEMPTS; attempt += 1) {
      await expect(recordAuthChallengeFailure({
        challengeId: challenge.id,
        userId: user.id,
        purpose: 'admin_login',
        now: FIXED_NOW,
      })).resolves.toEqual({ kind: 'recorded' })
    }

    await expect(recordAuthChallengeFailure({
      challengeId: challenge.id,
      userId: user.id,
      purpose: 'admin_login',
      now: FIXED_NOW,
    })).resolves.toEqual({ kind: 'locked' })

    const locked = await prisma.authChallenge.findUniqueOrThrow({ where: { id: challenge.id } })
    expect(locked.failedAttempts).toBe(MFA_CHALLENGE_MAX_ATTEMPTS)
    expect(locked.consumedAt).toEqual(FIXED_NOW)
    expect(await getUsableAuthChallenge({
      challengeId: challenge.id,
      userId: user.id,
      purpose: 'admin_login',
      now: FIXED_NOW,
    })).toEqual({ kind: 'too_many_attempts' })
    expect(await consumeAuthChallenge({
      challengeId: challenge.id,
      userId: user.id,
      purpose: 'admin_login',
      now: FIXED_NOW,
    })).toBe(false)
  })

  it('rejects expired challenges and allows only one concurrent successful consume', async () => {
    const { user } = await createTestUser('mfa-challenge-concurrency@test.local')
    const expired = await createAuthChallenge({
      userId: user.id,
      purpose: 'admin_enroll',
      now: FIXED_NOW,
    })

    expect(await getUsableAuthChallenge({
      challengeId: expired.id,
      userId: user.id,
      purpose: 'admin_enroll',
      now: new Date(FIXED_NOW.getTime() + MFA_CHALLENGE_TTL_MS),
    })).toEqual({ kind: 'expired' })
    expect(await consumeAuthChallenge({
      challengeId: expired.id,
      userId: user.id,
      purpose: 'admin_enroll',
      now: new Date(FIXED_NOW.getTime() + MFA_CHALLENGE_TTL_MS),
    })).toBe(false)

    const active = await createAuthChallenge({
      userId: user.id,
      purpose: 'admin_login',
      now: FIXED_NOW,
    })
    const consumes = await Promise.all([
      consumeAuthChallenge({
        challengeId: active.id,
        userId: user.id,
        purpose: 'admin_login',
        now: FIXED_NOW,
      }),
      consumeAuthChallenge({
        challengeId: active.id,
        userId: user.id,
        purpose: 'admin_login',
        now: FIXED_NOW,
      }),
    ])

    expect(consumes.filter(Boolean)).toHaveLength(1)
  })
})
