import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { describe, expect, it } from 'vitest'
import { api, authHeader, createTestUser } from './helpers.js'
import { prisma } from '../lib/prisma.js'
import { createAuthChallenge, generateTotp, generateTotpSeed } from '../modules/auth/mfa.js'
import { resetAdminMfaForBreakGlass } from '../modules/auth/service.js'
import { config } from '../config/index.js'

function hasRefreshCookie(response: { headers: Record<string, unknown> }) {
  const cookies = response.headers['set-cookie'] as string[] | undefined
  return cookies?.some(cookie => cookie.startsWith('refreshToken=')) ?? false
}

function refreshCookies(response: { headers: Record<string, unknown> }) {
  return (response.headers['set-cookie'] as string[] | undefined) ?? []
}

function changeOneTotpDigit(code: string) {
  return `${code.slice(0, -1)}${code.endsWith('0') ? '1' : '0'}`
}

async function beginEnrollment(email: string, password: string) {
  const login = await api
    .post('/api/auth/login')
    .send({ email, password })
    .expect(202)

  expect(
    login.body.status === 'mfa_enrollment_required'
    && typeof login.body.challengeId === 'string'
    && !('accessToken' in login.body)
    && !hasRefreshCookie(login),
  ).toBe(true)

  const start = await api
    .post('/api/auth/mfa/enrollment/start')
    .send({ challengeId: login.body.challengeId })
    .expect(200)

  if (typeof start.body.manualKey !== 'string' || start.body.manualKey.length === 0) {
    throw new Error('Expected a non-empty MFA enrollment manual key')
  }

  return {
    challengeId: login.body.challengeId as string,
    manualKey: start.body.manualKey as string,
  }
}

async function confirmEnrollment(challengeId: string, manualKey: string) {
  const confirmed = await api
    .post('/api/auth/mfa/enrollment/confirm')
    .send({ challengeId, code: generateTotp(manualKey) })
    .expect(201)

  if (!Array.isArray(confirmed.body.recoveryCodes) || !confirmed.body.recoveryCodes.every((code: unknown) => typeof code === 'string')) {
    throw new Error('Expected one-time MFA recovery codes')
  }

  expect(typeof confirmed.body.accessToken === 'string' && hasRefreshCookie(confirmed)).toBe(true)
  return {
    accessToken: confirmed.body.accessToken as string,
    recoveryCodes: confirmed.body.recoveryCodes as string[],
    refreshCookies: refreshCookies(confirmed),
  }
}

describe('administrator MFA enrollment and login', () => {
  it('keeps an unbound admin pre-authenticated until TOTP confirmation, then atomically creates an MFA session', async () => {
    const { user, password } = await createTestUser('mfa-enrollment@test.local', 'mfa-password', 'admin')
    const enrollment = await beginEnrollment(user.email, password)

    const storedBeforeConfirm = await prisma.authChallenge.findUniqueOrThrow({ where: { id: enrollment.challengeId } })
    const noSessionBeforeConfirm = await prisma.refreshToken.count({ where: { userId: user.id } }) === 0
    expect(
      storedBeforeConfirm.secretEncrypted !== enrollment.manualKey
      && !storedBeforeConfirm.secretEncrypted?.includes(enrollment.manualKey)
      && noSessionBeforeConfirm,
    ).toBe(true)

    await api
      .post('/api/auth/mfa/enrollment/confirm')
      .send({ challengeId: enrollment.challengeId, code: changeOneTotpDigit(generateTotp(enrollment.manualKey)) })
      .expect(401)

    expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0)
    const session = await confirmEnrollment(enrollment.challengeId, enrollment.manualKey)
    const enrolled = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    const eventTypes = await prisma.securityEvent.findMany({
      where: { userId: user.id },
      select: { type: true },
    })

    expect(
      enrolled.mfaEnabled
      && enrolled.mfaSecretEncrypted !== null
      && enrolled.mfaVersion > 0
      && (await prisma.mfaRecoveryCode.count({ where: { userId: user.id } })) === 10
      && eventTypes.some(event => event.type === 'mfa_enrolled')
      && eventTypes.some(event => event.type === 'mfa_login_failed')
      && typeof session.accessToken === 'string',
    ).toBe(true)
  })

  it('requires a second factor for an enrolled admin and permits a recovery code exactly once', async () => {
    const { user, password } = await createTestUser('mfa-recovery-login@test.local', 'mfa-password', 'admin')
    const enrollment = await beginEnrollment(user.email, password)
    const first = await confirmEnrollment(enrollment.challengeId, enrollment.manualKey)
    const [recoveryCode] = first.recoveryCodes

    const login = await api.post('/api/auth/login').send({ email: user.email, password }).expect(202)
    expect(login.body.status === 'mfa_required' && !hasRefreshCookie(login) && !('accessToken' in login.body)).toBe(true)

    const recovery = await api
      .post('/api/auth/mfa/verify')
      .send({ challengeId: login.body.challengeId, method: 'recovery', code: recoveryCode })
      .expect(200)
    expect(recovery.body.recoveryCodeRemaining === 9 && hasRefreshCookie(recovery)).toBe(true)

    const replayChallenge = await api.post('/api/auth/login').send({ email: user.email, password }).expect(202)
    const replay = await api
      .post('/api/auth/mfa/verify')
      .send({ challengeId: replayChallenge.body.challengeId, method: 'recovery', code: recoveryCode })
      .expect(401)

    expect(!hasRefreshCookie(replay) && !('accessToken' in replay.body)).toBe(true)
    expect(await prisma.securityEvent.count({ where: { userId: user.id, type: 'mfa_recovery_used' } })).toBe(1)
  })

  it('accepts only one concurrent enrollment confirmation and retires every sibling enrollment challenge', async () => {
    const { user, password } = await createTestUser('mfa-enrollment-race@test.local', 'mfa-password', 'admin')
    const first = await beginEnrollment(user.email, password)
    const second = await beginEnrollment(user.email, password)

    const confirmations = await Promise.all([
      api.post('/api/auth/mfa/enrollment/confirm').send({ challengeId: first.challengeId, code: generateTotp(first.manualKey) }),
      api.post('/api/auth/mfa/enrollment/confirm').send({ challengeId: second.challengeId, code: generateTotp(second.manualKey) }),
    ])
    const statuses = confirmations.map(response => response.status)
    const challenges = await prisma.authChallenge.findMany({
      where: { userId: user.id, purpose: 'admin_enroll' },
      select: { consumedAt: true },
    })
    const enrolled = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })

    expect(
      statuses.filter(status => status === 201).length === 1
      && statuses.filter(status => status === 401).length === 1
      && enrolled.mfaEnabled
      && enrolled.mfaVersion === 1
      && challenges.length === 2
      && challenges.every(challenge => challenge.consumedAt !== null)
      && (await prisma.mfaRecoveryCode.count({ where: { userId: user.id, usedAt: null } })) === 10
      && (await prisma.refreshToken.count({ where: { userId: user.id, revoked: false } })) === 1,
    ).toBe(true)
  })

  it('locks a challenge after its fifth failed factor attempt and never creates a session', async () => {
    const { user, password } = await createTestUser('mfa-attempt-limit@test.local', 'mfa-password', 'admin')
    const enrollment = await beginEnrollment(user.email, password)
    const wrongCode = changeOneTotpDigit(generateTotp(enrollment.manualKey))

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const failed = await api
        .post('/api/auth/mfa/enrollment/confirm')
        .send({ challengeId: enrollment.challengeId, code: wrongCode })
        .expect(401)
      expect(failed.body.error.code).toBe('MFA_VERIFICATION_FAILED')
    }
    const locked = await api
      .post('/api/auth/mfa/enrollment/confirm')
      .send({ challengeId: enrollment.challengeId, code: wrongCode })
      .expect(429)
    const stillLocked = await api
      .post('/api/auth/mfa/enrollment/confirm')
      .send({ challengeId: enrollment.challengeId, code: generateTotp(enrollment.manualKey) })
      .expect(429)

    expect(
      locked.body.error.code === 'MFA_TOO_MANY_ATTEMPTS'
      && stillLocked.body.error.code === 'MFA_TOO_MANY_ATTEMPTS'
      && (await prisma.refreshToken.count({ where: { userId: user.id } })) === 0,
    ).toBe(true)
  })

  it('makes administrator-only routes reject legacy, claim-mismatched, and revoked sessions', async () => {
    const { user, password } = await createTestUser('mfa-guard@test.local', 'mfa-password', 'admin')
    const enrollment = await beginEnrollment(user.email, password)
    const authenticated = await confirmEnrollment(enrollment.challengeId, enrollment.manualKey)
    const current = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    const session = await prisma.refreshToken.findFirstOrThrow({
      where: { userId: user.id, revoked: false },
      orderBy: { id: 'desc' },
    })

    await api.get('/api/admin/stats').set(authHeader(authenticated.accessToken)).expect(200)

    const refreshed = await api
      .post('/api/auth/refresh')
      .set('Cookie', authenticated.refreshCookies)
      .expect(200)
    const refreshClaims = jwt.decode(refreshed.body.accessToken) as { mfaVerified?: unknown; mfaVersion?: unknown } | null
    expect(refreshClaims?.mfaVerified === true && refreshClaims.mfaVersion === current.mfaVersion).toBe(true)

    const noSid = jwt.sign({ userId: user.id, role: 'admin', mfaVerified: true, mfaVersion: current.mfaVersion }, config.jwtSecret, { expiresIn: '15m' })
    const missingMfa = jwt.sign({ userId: user.id, role: 'admin', sid: session.sessionId }, config.jwtSecret, { expiresIn: '15m' })
    const staleVersion = jwt.sign({
      userId: user.id,
      role: 'admin',
      sid: session.sessionId,
      mfaVerified: true,
      mfaVersion: current.mfaVersion + 1,
    }, config.jwtSecret, { expiresIn: '15m' })

    const noSidResult = await api.get('/api/admin/stats').set(authHeader(noSid)).expect(401)
    const missingMfaResult = await api.get('/api/admin/stats').set(authHeader(missingMfa)).expect(403)
    const staleVersionResult = await api.get('/api/admin/stats').set(authHeader(staleVersion)).expect(403)
    const fileBypass = await api
      .post('/api/orders/999999/files/download-url')
      .set(authHeader(missingMfa))
      .expect(403)

    const adminAnnouncement = await prisma.announcement.create({
      data: {
        title: 'MFA-only operations notice',
        content: 'admin audience must not be visible to legacy sessions',
        audience: 'admin',
        status: 'published',
        startsAt: new Date(Date.now() - 1_000),
      },
    })
    const downgradedAnnouncements = await api
      .get('/api/announcements')
      .set(authHeader(missingMfa))
      .expect(200)
    const allowedAnnouncements = await api
      .get('/api/announcements')
      .set(authHeader(authenticated.accessToken))
      .expect(200)
    await api
      .post(`/api/announcements/${adminAnnouncement.id}/read`)
      .set(authHeader(missingMfa))
      .expect(404)

    expect(
      noSidResult.body.error.code === 'SESSION_REVOKED'
      && missingMfaResult.body.error.code === 'MFA_REQUIRED'
      && staleVersionResult.body.error.code === 'MFA_REQUIRED'
      && fileBypass.body.error.code === 'MFA_REQUIRED'
      && (await prisma.fileGrantLog.count()) === 0
      && !downgradedAnnouncements.body.some((item: { id: number }) => item.id === adminAnnouncement.id)
      && allowedAnnouncements.body.some((item: { id: number }) => item.id === adminAnnouncement.id)
      && (await prisma.announcementReceipt.count({ where: { announcementId: adminAnnouncement.id, userId: user.id } })) === 0,
    ).toBe(true)

    await prisma.refreshToken.updateMany({
      where: { userId: user.id, sessionId: session.sessionId },
      data: { revoked: true, revokedAt: new Date(), revokeReason: 'single_session' },
    })
    const revoked = await api.get('/api/admin/stats').set(authHeader(authenticated.accessToken)).expect(401)
    expect(revoked.body.error.code).toBe('SESSION_REVOKED')
  })
})

describe('bcrypt 12 migration boundaries', () => {
  it('writes bcrypt 12 for registration, password change, and password reset', async () => {
    await api.post('/api/auth/register').send({ email: 'bcrypt-register@test.local', password: 'new-password' }).expect(201)
    const registered = await prisma.user.findUniqueOrThrow({ where: { email: 'bcrypt-register@test.local' } })

    const { user: changing } = await createTestUser('bcrypt-change@test.local', 'old-password')
    const legacyUserToken = jwt.sign({ userId: changing.id, role: 'user' }, config.jwtSecret, { expiresIn: '15m' })
    await api
      .post('/api/auth/password-change')
      .set(authHeader(legacyUserToken))
      .send({ currentPassword: 'old-password', newPassword: 'changed-password' })
      .expect(200)
    const changed = await prisma.user.findUniqueOrThrow({ where: { id: changing.id } })

    const { user: resetting } = await createTestUser('bcrypt-reset@test.local', 'old-password')
    const rawResetToken = 'm3-identity-security-reset-token'
    await prisma.passwordResetToken.create({
      data: {
        userId: resetting.id,
        tokenHash: crypto.createHash('sha256').update(rawResetToken).digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    await api.post('/api/auth/reset-password').send({ token: rawResetToken, password: 'reset-password' }).expect(200)
    const reset = await prisma.user.findUniqueOrThrow({ where: { id: resetting.id } })

    expect(
      bcrypt.getRounds(registered.password) === 12
      && bcrypt.getRounds(changed.password) === 12
      && bcrypt.getRounds(reset.password) === 12,
    ).toBe(true)
  })

  it('upgrades only a successful non-admin legacy login and never rehashes failed or admin pre-authentication', async () => {
    const { user: normal, password: normalPassword } = await createTestUser('bcrypt-upgrade@test.local', 'legacy-password')
    const { user: wrongPassword } = await createTestUser('bcrypt-wrong@test.local', 'legacy-password')
    const { user: admin, password: adminPassword } = await createTestUser('bcrypt-admin-preauth@test.local', 'legacy-password', 'admin')

    await api.post('/api/auth/login').send({ email: normal.email, password: normalPassword }).expect(200)
    await api.post('/api/auth/login').send({ email: wrongPassword.email, password: 'wrong-password' }).expect(401)
    await api.post('/api/auth/login').send({ email: admin.email, password: adminPassword }).expect(202)

    const [normalAfter, wrongAfter, adminAfter] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: normal.id } }),
      prisma.user.findUniqueOrThrow({ where: { id: wrongPassword.id } }),
      prisma.user.findUniqueOrThrow({ where: { id: admin.id } }),
    ])
    expect(
      bcrypt.getRounds(normalAfter.password) === 12
      && bcrypt.getRounds(wrongAfter.password) === 10
      && bcrypt.getRounds(adminAfter.password) === 10,
    ).toBe(true)
  })
})

describe('administrator password security boundary', () => {
  it('consumes a pre-authentication challenge and advances MFA version after an admin password change', async () => {
    const { user, password } = await createTestUser('mfa-password-change@test.local', 'old-admin-password', 'admin')
    const enrollment = await beginEnrollment(user.email, password)
    const authenticated = await confirmEnrollment(enrollment.challengeId, enrollment.manualKey)
    const before = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { mfaVersion: true } })

    const staleChallenge = await api
      .post('/api/auth/login')
      .send({ email: user.email, password })
      .expect(202)
    expect(staleChallenge.body.status).toBe('mfa_required')

    await api
      .post('/api/auth/password-change')
      .set(authHeader(authenticated.accessToken))
      .send({ currentPassword: password, newPassword: 'new-admin-password' })
      .expect(200)

    const [after, storedChallenge] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { mfaVersion: true } }),
      prisma.authChallenge.findUniqueOrThrow({ where: { id: staleChallenge.body.challengeId } }),
    ])
    const staleAttempt = await api
      .post('/api/auth/mfa/verify')
      .send({
        challengeId: staleChallenge.body.challengeId,
        method: 'totp',
        code: generateTotp(enrollment.manualKey),
      })
      .expect(401)

    expect(
      after.mfaVersion === before.mfaVersion + 1
      && storedChallenge.consumedAt !== null
      && staleAttempt.body.error.code === 'MFA_VERIFICATION_FAILED'
      && !hasRefreshCookie(staleAttempt),
    ).toBe(true)

    const relogin = await api
      .post('/api/auth/login')
      .send({ email: user.email, password: 'new-admin-password' })
      .expect(202)
    await api
      .post('/api/auth/mfa/verify')
      .send({
        challengeId: relogin.body.challengeId,
        method: 'totp',
        code: generateTotp(enrollment.manualKey),
      })
      .expect(200)
  })

  it('does not consume a pre-authentication challenge or advance MFA version when an admin password change fails', async () => {
    const { user, password } = await createTestUser('mfa-password-change-failure@test.local', 'old-admin-password', 'admin')
    const enrollment = await beginEnrollment(user.email, password)
    const authenticated = await confirmEnrollment(enrollment.challengeId, enrollment.manualKey)
    const before = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { mfaVersion: true } })
    const pending = await api
      .post('/api/auth/login')
      .send({ email: user.email, password })
      .expect(202)

    await api
      .post('/api/auth/password-change')
      .set(authHeader(authenticated.accessToken))
      .send({ currentPassword: 'incorrect-password', newPassword: 'new-admin-password' })
      .expect(401)

    const [after, storedChallenge] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { mfaVersion: true } }),
      prisma.authChallenge.findUniqueOrThrow({ where: { id: pending.body.challengeId } }),
    ])
    expect(after.mfaVersion === before.mfaVersion && storedChallenge.consumedAt === null).toBe(true)
  })

  it('consumes a pre-authentication challenge and advances MFA version after an admin password reset', async () => {
    const { user, password } = await createTestUser('mfa-password-reset@test.local', 'old-admin-password', 'admin')
    const enrollment = await beginEnrollment(user.email, password)
    await confirmEnrollment(enrollment.challengeId, enrollment.manualKey)
    const before = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { mfaVersion: true } })
    const staleChallenge = await api
      .post('/api/auth/login')
      .send({ email: user.email, password })
      .expect(202)
    const resetToken = crypto.randomBytes(32).toString('hex')
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: crypto.createHash('sha256').update(resetToken).digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      },
    })

    await api
      .post('/api/auth/reset-password')
      .send({ token: resetToken, password: 'new-admin-password' })
      .expect(200)

    const [after, storedChallenge] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { mfaVersion: true } }),
      prisma.authChallenge.findUniqueOrThrow({ where: { id: staleChallenge.body.challengeId } }),
    ])
    const staleAttempt = await api
      .post('/api/auth/mfa/verify')
      .send({
        challengeId: staleChallenge.body.challengeId,
        method: 'totp',
        code: generateTotp(enrollment.manualKey),
      })
      .expect(401)

    expect(
      after.mfaVersion === before.mfaVersion + 1
      && storedChallenge.consumedAt !== null
      && staleAttempt.body.error.code === 'MFA_VERIFICATION_FAILED'
      && !hasRefreshCookie(staleAttempt),
    ).toBe(true)
  })

  it('does not rotate a legacy admin refresh session that predates MFA enrollment', async () => {
    const { user } = await createTestUser('mfa-legacy-refresh@test.local', 'legacy-admin-password', 'admin')
    const legacyRefreshToken = crypto.randomBytes(40).toString('hex')
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: crypto.createHash('sha256').update(legacyRefreshToken).digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      },
    })

    const refresh = await api
      .post('/api/auth/refresh')
      .set('Cookie', [`refreshToken=${legacyRefreshToken}`])
      .expect(401)

    expect(
      refresh.body.error.code === 'SESSION_REVOKED'
      && !hasRefreshCookie(refresh)
      && (await prisma.refreshToken.count({ where: { userId: user.id, revoked: false } })) === 1,
    ).toBe(true)
  })
})

describe('offline administrator MFA break-glass reset', () => {
  it('is not an HTTP route and atomically clears every MFA credential before requiring a fresh enrollment', async () => {
    const { user, password } = await createTestUser('mfa-break-glass@test.local', 'admin-password', 'admin')
    const enrollment = await beginEnrollment(user.email, password)
    const authenticated = await confirmEnrollment(enrollment.challengeId, enrollment.manualKey)
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { mfaVersion: true },
    })
    const pending = await api
      .post('/api/auth/login')
      .send({ email: user.email, password })
      .expect(202)
    const pendingSeed = await createAuthChallenge({
      userId: user.id,
      purpose: 'admin_reconfigure',
      pendingSecret: generateTotpSeed(),
    })
    expect((await prisma.authChallenge.findUniqueOrThrow({ where: { id: pendingSeed.id } })).secretEncrypted).not.toBeNull()

    const result = await resetAdminMfaForBreakGlass({ userId: user.id, caseRef: 'OPS-42' })
    const [after, unusedRecoveryCodes, pendingChallenge, pendingSeedChallenge, activeSessions, audit] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      prisma.mfaRecoveryCode.count({ where: { userId: user.id, usedAt: null } }),
      prisma.authChallenge.findUniqueOrThrow({ where: { id: pending.body.challengeId } }),
      prisma.authChallenge.findUniqueOrThrow({ where: { id: pendingSeed.id } }),
      prisma.refreshToken.count({ where: { userId: user.id, revoked: false } }),
      prisma.securityEvent.findFirstOrThrow({
        where: { userId: user.id, type: 'mfa_break_glass_reset' },
        orderBy: { id: 'desc' },
      }),
    ])
    const staleAttempt = await api
      .post('/api/auth/mfa/verify')
      .send({
        challengeId: pending.body.challengeId,
        method: 'totp',
        code: generateTotp(enrollment.manualKey),
      })
      .expect(401)
    const reEnrollment = await api
      .post('/api/auth/login')
      .send({ email: user.email, password })
      .expect(202)
    const oldAccess = await api
      .get('/api/admin/stats')
      .set(authHeader(authenticated.accessToken))
      .expect(403)
    await api
      .post('/api/auth/mfa/break-glass')
      .send({ userId: user.id, caseRef: 'OPS-42' })
      .expect(404)

    expect(
      result.revokedCount === 1
      && after.mfaEnabled === false
      && after.mfaSecretEncrypted === null
      && after.mfaVerifiedAt === null
      && after.mfaVersion === before.mfaVersion + 1
      && unusedRecoveryCodes === 0
      && pendingChallenge.consumedAt !== null
      && pendingSeedChallenge.consumedAt !== null
      && pendingSeedChallenge.secretEncrypted === null
      && activeSessions === 0
      && audit.detailSafe !== null
      && (audit.detailSafe as { caseRef?: string; revokedCount?: number }).caseRef === 'OPS-42'
      && (audit.detailSafe as { caseRef?: string; revokedCount?: number }).revokedCount === 1
      && staleAttempt.body.error.code === 'MFA_VERIFICATION_FAILED'
      && reEnrollment.body.status === 'mfa_enrollment_required'
      && oldAccess.body.error.code === 'MFA_REQUIRED',
    ).toBe(true)
  })

  it('rolls back the break-glass credential reset when its controlled audit case reference is invalid', async () => {
    const { user, password } = await createTestUser('mfa-break-glass-rollback@test.local', 'admin-password', 'admin')
    const enrollment = await beginEnrollment(user.email, password)
    await confirmEnrollment(enrollment.challengeId, enrollment.manualKey)
    const pending = await api
      .post('/api/auth/login')
      .send({ email: user.email, password })
      .expect(202)
    const before = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })

    await expect(
      resetAdminMfaForBreakGlass({ userId: user.id, caseRef: 'unsafe free-form ticket' }),
    ).rejects.toThrow('security event detail contains an invalid safe summary')

    const [after, unusedRecoveryCodes, pendingChallenge, activeSessions, auditCount] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      prisma.mfaRecoveryCode.count({ where: { userId: user.id, usedAt: null } }),
      prisma.authChallenge.findUniqueOrThrow({ where: { id: pending.body.challengeId } }),
      prisma.refreshToken.count({ where: { userId: user.id, revoked: false } }),
      prisma.securityEvent.count({ where: { userId: user.id, type: 'mfa_break_glass_reset' } }),
    ])

    expect(
      after.mfaEnabled === true
      && after.mfaSecretEncrypted === before.mfaSecretEncrypted
      && after.mfaVersion === before.mfaVersion
      && unusedRecoveryCodes === 10
      && pendingChallenge.consumedAt === null
      && activeSessions === 1
      && auditCount === 0,
    ).toBe(true)
  })

  it('refuses a non-admin break-glass target without writing MFA or audit state', async () => {
    const { user } = await createTestUser('mfa-break-glass-non-admin@test.local', 'user-password', 'user')

    await expect(
      resetAdminMfaForBreakGlass({ userId: user.id, caseRef: 'OPS-43' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const [after, auditCount] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      prisma.securityEvent.count({ where: { userId: user.id, type: 'mfa_break_glass_reset' } }),
    ])
    expect(after.mfaEnabled === false && after.mfaVersion === 0 && auditCount === 0).toBe(true)
  })
})
