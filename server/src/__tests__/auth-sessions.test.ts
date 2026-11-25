import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { describe, expect, it } from 'vitest'
import { api, authHeader, createTestMerchant, createTestUser, loginAs } from './helpers.js'
import { prisma } from '../lib/prisma.js'
import { refreshTokenCookieName } from '../lib/cookies.js'
import { changePassword, loginUser, refreshAccessToken, revokeAllUserRefreshTokens } from '../modules/auth/service.js'
import { hashRefreshToken } from '../modules/auth/sessionIssuance.js'
import { lockUserRefreshSessionMutations } from '../modules/auth/sessionService.js'
import { approveMerchant, banUser, suspendMerchant } from '../modules/admin/service.js'
import { config } from '../config/index.js'

type LoginResult = {
  accessToken: string
  refreshCookie: string
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function waitForQueuedUserSessionLock(userId: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count"
      FROM pg_locks
      WHERE locktype = 'advisory' AND objid = ${userId}::int4 AND NOT granted
    `
    if ((row?.count ?? 0) > 0) return
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  throw new Error('expected a queued user refresh-session lock')
}

/**
 * Reproduces the dangerous half of password reset/change with real PostgreSQL
 * transactions: it owns the user advisory lock, then writes the User row only
 * after the admin mutation has begun. The admin path must therefore queue on
 * the advisory lock before it can acquire a User row lock. The old inverse
 * order deadlocked here; no mock, sleep, or production test seam is used.
 */
async function assertAdminUserWriteQueuesBeforeSessionLockRelease(input: {
  userId: number
  mutate: () => Promise<unknown>
}) {
  const holderReady = deferred()
  const releaseHolder = deferred()
  let holder!: Promise<unknown>
  let mutation!: Promise<unknown>

  try {
    holder = prisma.$transaction(async tx => {
      await lockUserRefreshSessionMutations(tx, input.userId)
      holderReady.resolve()
      await releaseHolder.promise
      await tx.user.update({
        where: { id: input.userId },
        data: { nickname: `lock-${input.userId}` },
      })
    })
    await holderReady.promise

    mutation = input.mutate()
    await waitForQueuedUserSessionLock(input.userId)

    releaseHolder.resolve()
    await Promise.all([holder, mutation])
  } finally {
    releaseHolder.resolve()
    await Promise.allSettled([holder, mutation].filter(Boolean))
  }
}

function refreshCookieFrom(res: { headers: Record<string, unknown> }) {
  const cookies = res.headers['set-cookie'] as string[] | undefined
  const cookie = cookies?.find(value => value.startsWith(`${refreshTokenCookieName}=`))
  if (!cookie) throw new Error('Expected a refresh cookie')
  return cookie
}

function sessionIdFromAccessToken(accessToken: string): string {
  const payload = jwt.decode(accessToken) as { sid?: unknown } | null
  if (typeof payload?.sid !== 'string') throw new Error('Expected an access-token session id')
  return payload.sid
}

async function login(email: string, password: string, userAgent = 'M3-ISH session test agent'):
  Promise<LoginResult> {
  const response = await api
    .post('/api/auth/login')
    .set('User-Agent', userAgent)
    .send({ email, password })
    .expect(200)

  return {
    accessToken: response.body.accessToken,
    refreshCookie: refreshCookieFrom(response),
  }
}

type SessionSummary = {
  sessionId: string
  deviceLabel: string
  ipHint: string
  sessionStartedAt: string
  lastUsedAt: string
  current: boolean
}

async function listSessions(accessToken: string) {
  const response = await api
    .get('/api/auth/sessions')
    .set(authHeader(accessToken))
    .expect(200)

  return response.body.items as SessionSummary[]
}

describe('device session families', () => {
  it('keeps sid/sessionId stable across refresh rotation and exposes only a safe current-session summary', async () => {
    const { user, password } = await createTestUser('session-rotation@test.local', 'session-password')
    const original = await login(user.email, password, 'Sensitive Session UA / 1.0')
    const originalRow = await prisma.refreshToken.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { id: 'desc' },
    })
    const initialClaims = jwt.decode(original.accessToken) as { sid?: unknown } | null

    expect(initialClaims?.sid === originalRow.sessionId).toBe(true)
    // D2 write-side minimization: new writes store only summaries and null out raw IP/UA columns.
    expect(originalRow.ip).toBeNull()
    expect(originalRow.userAgent).toBeNull()
    expect(originalRow.deviceLabel).toBe('浏览器会话')
    expect(originalRow.ipHint).toBe('未知 IP')
    expect(originalRow.absoluteExpiresAt).toBeInstanceOf(Date)

    const refreshed = await api
      .post('/api/auth/refresh')
      .set('Cookie', original.refreshCookie)
      .set('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/131.0 Safari/537.36')
      .expect(200)
    const refreshedRow = await prisma.refreshToken.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { id: 'desc' },
    })
    const originalAfterRefresh = await prisma.refreshToken.findUniqueOrThrow({ where: { id: originalRow.id } })
    const refreshedClaims = jwt.decode(refreshed.body.accessToken) as { sid?: unknown } | null

    const rotationInvariants = {
      originalRevoked: originalAfterRefresh.revoked,
      sameSessionId: refreshedRow.sessionId === originalRow.sessionId,
      sameStartedAt: refreshedRow.sessionStartedAt.getTime() === originalRow.sessionStartedAt.getTime(),
      sameAbsoluteExpiry: refreshedRow.absoluteExpiresAt?.getTime() === originalRow.absoluteExpiresAt?.getTime(),
      lastUsedAdvanced: refreshedRow.lastUsedAt.getTime() >= originalRow.lastUsedAt.getTime(),
      refreshedSid: refreshedClaims?.sid === originalRow.sessionId,
      refreshedRawIpNull: refreshedRow.ip === null,
      refreshedRawUaNull: refreshedRow.userAgent === null,
      refreshedDeviceLabel: refreshedRow.deviceLabel === 'Chrome · macOS',
      refreshedIpHint: refreshedRow.ipHint === '未知 IP',
    }
    const failedRotationInvariants = Object.entries(rotationInvariants)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
    expect(failedRotationInvariants).toEqual([])

    const items = await listSessions(refreshed.body.accessToken)
    const [current] = items
    const noRawMetadata = !JSON.stringify(items).includes('Sensitive Session UA')
      && !JSON.stringify(items).includes('Mozilla/')
      && !JSON.stringify(items).includes('127.0.0.1')
    const hasOnlySummaryFields = current !== undefined
      && Object.keys(current).every(key => [
        'sessionId',
        'deviceLabel',
        'ipHint',
        'sessionStartedAt',
        'lastUsedAt',
        'current',
      ].includes(key))
      && current.current
      && current.deviceLabel === 'Chrome · macOS'
      && current.sessionId === originalRow.sessionId
      && !('tokenHash' in current)
      && !('userAgent' in current)
      && !('ip' in current)

    expect(items.length === 1 && hasOnlySummaryFields && noRawMetadata).toBe(true)

    // Legacy row read-side fallback during rolling upgrades: null summary columns fall back to raw columns via bounded parser.
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
        expiresAt: new Date(Date.now() + 3_600_000),
        ip: '203.0.113.50',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/130.0',
        deviceLabel: null,
        ipHint: null,
      },
    })
    const withLegacy = await listSessions(refreshed.body.accessToken)
    const legacySummary = withLegacy.find(item => !item.current)
    expect(legacySummary).toMatchObject({
      deviceLabel: 'Firefox · Windows',
      ipHint: '203.0.113.*',
    })
  })

  it('only lets an owner revoke a non-current family, while the current family continues to work', async () => {
    const { user, password } = await createTestUser('session-single-owner@test.local', 'session-password')
    const current = await login(user.email, password, 'Current Device')
    const other = await login(user.email, password, 'Other Device')
    const { user: stranger, password: strangerPassword } = await createTestUser(
      'session-stranger@test.local',
      'session-password',
    )
    const strangerLogin = await login(stranger.email, strangerPassword, 'Stranger Device')

    const items = await listSessions(current.accessToken)
    const currentSession = items.find(item => item.current)
    const otherSession = items.find(item => !item.current)
    expect(typeof currentSession?.sessionId === 'string' && typeof otherSession?.sessionId === 'string').toBe(true)

    const currentAttempt = await api
      .delete(`/api/auth/sessions/${currentSession!.sessionId}`)
      .set(authHeader(current.accessToken))
      .expect(400)
    expect(currentAttempt.body.error.code).toBe('CURRENT_SESSION_REQUIRES_LOGOUT')

    await api
      .delete(`/api/auth/sessions/${otherSession!.sessionId}`)
      .set(authHeader(strangerLogin.accessToken))
      .expect(404)

    await api
      .delete(`/api/auth/sessions/${otherSession!.sessionId}`)
      .set(authHeader(current.accessToken))
      .expect(204)

    await api.get('/api/auth/sessions').set(authHeader(other.accessToken)).expect(401)
    await api.post('/api/auth/refresh').set('Cookie', other.refreshCookie).expect(401)
    await api.post('/api/auth/refresh').set('Cookie', current.refreshCookie).expect(200)

    const revocation = await prisma.securityEvent.findFirstOrThrow({
      where: { userId: user.id, sessionId: otherSession!.sessionId, type: 'session_revoked' },
      orderBy: { id: 'desc' },
    })
    const detail = revocation.detailSafe as { reason?: unknown; revokedCount?: unknown } | null
    expect(detail?.reason === 'single_session' && detail?.revokedCount === 1).toBe(true)
  })

  it('revokes every other active family without affecting the current refresh family', async () => {
    const { user, password } = await createTestUser('session-revoke-others@test.local', 'session-password')
    const current = await login(user.email, password, 'Current Device')
    const otherOne = await login(user.email, password, 'Other Device One')
    const otherTwo = await login(user.email, password, 'Other Device Two')

    const response = await api
      .post('/api/auth/sessions/revoke-others')
      .set(authHeader(current.accessToken))
      .expect(200)

    expect(response.body.revokedCount).toBe(2)
    await api.post('/api/auth/refresh').set('Cookie', otherOne.refreshCookie).expect(401)
    await api.post('/api/auth/refresh').set('Cookie', otherTwo.refreshCookie).expect(401)
    await api.post('/api/auth/refresh').set('Cookie', current.refreshCookie).expect(200)

    const remaining = await listSessions(current.accessToken)
    const event = await prisma.securityEvent.findFirstOrThrow({
      where: { userId: user.id, type: 'session_revoked' },
      orderBy: { id: 'desc' },
    })
    const detail = event.detailSafe as { reason?: unknown; revokedCount?: unknown } | null
    expect(
      remaining.length === 1
      && remaining[0]?.current === true
      && detail?.reason === 'revoke_others'
      && detail?.revokedCount === 2,
    ).toBe(true)
  })

  it('keeps logout scoped to its current family and does not turn its old cookie into a global replay', async () => {
    const { user, password } = await createTestUser('session-logout@test.local', 'session-password')
    const current = await login(user.email, password, 'Current Device')
    const other = await login(user.email, password, 'Other Device')

    await api
      .post('/api/auth/logout')
      .set('Cookie', current.refreshCookie)
      .send({ expectedSessionId: sessionIdFromAccessToken(current.accessToken) })
      .expect(200)
    await api.post('/api/auth/refresh').set('Cookie', current.refreshCookie).expect(401)
    await api.post('/api/auth/refresh').set('Cookie', other.refreshCookie).expect(200)

    const event = await prisma.securityEvent.findFirstOrThrow({
      where: { userId: user.id, type: 'session_revoked' },
      orderBy: { id: 'desc' },
    })
    const detail = event.detailSafe as { reason?: unknown; revokedCount?: unknown } | null
    expect(detail?.reason === 'logout' && detail?.revokedCount === 1).toBe(true)
  })

  it('treats a rotated predecessor from an explicitly revoked family as terminal, not a global replay', async () => {
    const { user, password } = await createTestUser('session-terminal-predecessor@test.local', 'session-password')
    const current = await login(user.email, password, 'Current Device')
    const target = await login(user.email, password, 'Target Device')

    const rotated = await api
      .post('/api/auth/refresh')
      .set('Cookie', target.refreshCookie)
      .set('User-Agent', 'Target Device')
      .expect(200)
    const targetSession = (await listSessions(current.accessToken)).find(item => !item.current)
    expect(typeof targetSession?.sessionId === 'string').toBe(true)

    await api
      .delete(`/api/auth/sessions/${targetSession!.sessionId}`)
      .set(authHeader(current.accessToken))
      .expect(204)

    await api.post('/api/auth/refresh').set('Cookie', target.refreshCookie).expect(401)
    await api.post('/api/auth/refresh').set('Cookie', refreshCookieFrom(rotated)).expect(401)
    await api.post('/api/auth/refresh').set('Cookie', current.refreshCookie).expect(200)

    const replayEvents = await prisma.securityEvent.count({
      where: { userId: user.id, sessionId: targetSession!.sessionId, type: 'session_replay_detected' },
    })
    expect(replayEvents).toBe(0)
  })

  it('uses a stale pre-rotation logout cookie to terminate its active successor family', async () => {
    const { user, password } = await createTestUser('session-stale-logout@test.local', 'session-password')
    const rotating = await login(user.email, password, 'Rotating Device')
    const other = await login(user.email, password, 'Other Device')
    const rotated = await api
      .post('/api/auth/refresh')
      .set('Cookie', rotating.refreshCookie)
      .set('User-Agent', 'Rotating Device')
      .expect(200)

    await api
      .post('/api/auth/logout')
      .set('Cookie', rotating.refreshCookie)
      .send({ expectedSessionId: sessionIdFromAccessToken(rotating.accessToken) })
      .expect(200)
    await api.post('/api/auth/refresh').set('Cookie', refreshCookieFrom(rotated)).expect(401)
    await api.post('/api/auth/refresh').set('Cookie', other.refreshCookie).expect(200)
  })

  it('marks global security revocation with a closed reason and a safe audit event', async () => {
    const { user, password } = await createTestUser('session-global-revoke-audit@test.local', 'session-password')
    await loginUser(user.email, password)

    await changePassword(user.id, password, 'next-session-password')

    const rows = await prisma.refreshToken.findMany({ where: { userId: user.id } })
    const event = await prisma.securityEvent.findFirst({
      where: { userId: user.id, type: 'session_revoked' },
      orderBy: { id: 'desc' },
    })
    const detail = event?.detailSafe as { reason?: unknown; revokedCount?: unknown } | null | undefined

    expect(
      rows.length === 1
      && rows[0]?.revoked
      && rows[0]?.revokeReason === 'revoke_all'
      && detail?.reason === 'revoke_all'
      && detail?.revokedCount === 1,
    ).toBe(true)
  })

  it('serializes same-user refresh-session mutations on one transaction-scoped PostgreSQL lock', async () => {
    const { user } = await createTestUser('session-user-lock@test.local', 'session-password')
    const holderReady = deferred()
    const releaseHolder = deferred()
    const waiterAcquired = deferred()
    let holder!: Promise<unknown>
    let waiter!: Promise<unknown>

    try {
      holder = prisma.$transaction(async tx => {
        await lockUserRefreshSessionMutations(tx, user.id)
        holderReady.resolve()
        await releaseHolder.promise
      })
      await holderReady.promise

      waiter = prisma.$transaction(async tx => {
        await lockUserRefreshSessionMutations(tx, user.id)
        waiterAcquired.resolve()
      })
      await waitForQueuedUserSessionLock(user.id)

      let acquiredBeforeRelease = false
      void waiterAcquired.promise.then(() => { acquiredBeforeRelease = true })
      await Promise.resolve()
      expect(acquiredBeforeRelease).toBe(false)

      releaseHolder.resolve()
      await Promise.all([holder, waiter])
      expect(acquiredBeforeRelease).toBe(true)
    } finally {
      releaseHolder.resolve()
      await Promise.allSettled([holder, waiter].filter(Boolean))
    }
  })

  it('uses advisory → User ordering for every admin mutation that revokes sessions', async () => {
    const { user: admin } = await createTestUser('session-lock-admin@test.local', 'session-password', 'admin')

    const { user: banTarget } = await createTestUser('session-lock-ban@test.local', 'session-password')
    await assertAdminUserWriteQueuesBeforeSessionLockRelease({
      userId: banTarget.id,
      mutate: () => banUser(admin.id, banTarget.id, 'lock-order regression'),
    })

    const { user: approveTarget, merchant: pendingMerchant } = await createTestMerchant(
      'session-lock-approve@test.local',
      'session-password',
      { status: 'pending' },
    )
    await assertAdminUserWriteQueuesBeforeSessionLockRelease({
      userId: approveTarget.id,
      mutate: () => approveMerchant(admin.id, pendingMerchant.id),
    })

    const { user: suspendTarget, merchant: activeMerchant } = await createTestMerchant(
      'session-lock-suspend@test.local',
      'session-password',
      { status: 'active' },
    )
    await assertAdminUserWriteQueuesBeforeSessionLockRelease({
      userId: suspendTarget.id,
      mutate: () => suspendMerchant(admin.id, activeMerchant.id),
    })

    const [banned, approved, suspended] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: banTarget.id }, select: { status: true } }),
      prisma.merchant.findUniqueOrThrow({ where: { id: pendingMerchant.id }, select: { status: true } }),
      prisma.merchant.findUniqueOrThrow({ where: { id: activeMerchant.id }, select: { status: true } }),
    ])
    expect(banned.status === 'banned' && approved.status === 'active' && suspended.status === 'suspended').toBe(true)
  })

  it('requires sid for session management without changing ordinary legacy access-token compatibility', async () => {
    const { user } = await createTestUser('session-legacy-sid@test.local', 'session-password')
    const legacyAccessToken = jwt.sign({ userId: user.id, role: user.role }, config.jwtSecret, { expiresIn: '15m' })

    await api.get('/api/auth/me').set(authHeader(legacyAccessToken)).expect(200)
    await api.get('/api/auth/sessions').set(authHeader(legacyAccessToken)).expect(401)
  })

  it('keeps the existing refresh replay revoke-all policy and records a safe replay event', async () => {
    const { user, password } = await createTestUser('session-replay@test.local', 'session-password')
    const session = await loginUser(user.email, password)
    if (session.kind !== 'authenticated') throw new Error('Expected non-admin login session')
    const original = await prisma.refreshToken.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { id: 'desc' },
    })

    const attempts = await Promise.allSettled([
      refreshAccessToken(session.refreshToken),
      refreshAccessToken(session.refreshToken),
    ])

    const replayEvent = await prisma.securityEvent.findFirstOrThrow({
      where: { userId: user.id, sessionId: original.sessionId, type: 'session_replay_detected' },
      orderBy: { id: 'desc' },
    })
    const detail = replayEvent.detailSafe as { action?: unknown; revokedCount?: unknown } | null
    const activeTokenCount = await prisma.refreshToken.count({ where: { userId: user.id, revoked: false } })

    expect(
      attempts.filter(result => result.status === 'fulfilled').length === 1
      && attempts.filter(result => result.status === 'rejected').length === 1
      && activeTokenCount === 0
      && detail?.action === 'revoke_all_user_sessions'
      && detail?.revokedCount === 1,
    ).toBe(true)
  })

  it('triggers replay revocation only once per family and never lets repeated replays kick out newer logins', async () => {
    const { user, password } = await createTestUser('session-replay-once@test.local', 'session-password')
    const victim = await login(user.email, password, 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/131.0 Safari/537.36')
    const secondDevice = await login(user.email, password, 'Mozilla/5.0 (Windows NT 10.0) Firefox/130.0')

    // Rotate victim once so victim.refreshCookie becomes a rotated predecessor.
    await api
      .post('/api/auth/refresh')
      .set('Cookie', victim.refreshCookie)
      .expect(200)

    // First replay revokes all currently active families (victim successor + secondDevice = 2).
    await api
      .post('/api/auth/refresh')
      .set('Cookie', victim.refreshCookie)
      .expect(401)

    expect(await prisma.refreshToken.count({ where: { userId: user.id, revoked: false } })).toBe(0)
    const firstReplayEvents = await prisma.securityEvent.findMany({
      where: { userId: user.id, type: 'session_replay_detected' },
      orderBy: { id: 'asc' },
    })
    expect(firstReplayEvents).toHaveLength(1)
    expect(firstReplayEvents[0]?.detailSafe).toEqual({
      action: 'revoke_all_user_sessions',
      revokedCount: 2,
    })

    // User recovers and logs in on a fresh device.
    const recovered = await login(user.email, password, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1')

    // Replaying the old stolen predecessor again must return 401 without revoking the new login or spamming events.
    await api
      .post('/api/auth/refresh')
      .set('Cookie', victim.refreshCookie)
      .expect(401)

    await api
      .post('/api/auth/refresh')
      .set('Cookie', recovered.refreshCookie)
      .expect(200)
    expect(await prisma.securityEvent.count({ where: { userId: user.id, type: 'session_replay_detected' } })).toBe(1)
  })

  it('does not treat a rotated predecessor as replay when its successor naturally expired or when the predecessor itself expired', async () => {
    const { user, password } = await createTestUser('session-expired-predecessor@test.local', 'session-password')
    const healthy = await login(user.email, password, 'Healthy Device')
    const stale = await login(user.email, password, 'Stale Device')
    const staleSessionId = sessionIdFromAccessToken(stale.accessToken)

    // Rotate stale once -> predecessor has revokeReason='refresh_rotation', successor is active.
    await api.post('/api/auth/refresh').set('Cookie', stale.refreshCookie).expect(200)

    // Case 1: predecessor itself expired while successor is still active -> 401 expired, no global revoke.
    const staleRows = await prisma.refreshToken.findMany({
      where: { userId: user.id, sessionId: staleSessionId },
      orderBy: { id: 'asc' },
    })
    expect(staleRows).toHaveLength(2)
    const past = new Date(Date.now() - 60_000)
    const future = new Date(Date.now() + 3_600_000)
    await prisma.refreshToken.update({
      where: { id: staleRows[0]!.id },
      data: { expiresAt: past },
    })
    await api.post('/api/auth/refresh').set('Cookie', stale.refreshCookie).expect(401)
    expect(await prisma.securityEvent.count({ where: { userId: user.id, type: 'session_replay_detected' } })).toBe(0)

    // Case 2: predecessor is still unexpired, but its active successor naturally expired (never explicitly revoked).
    await prisma.refreshToken.update({
      where: { id: staleRows[0]!.id },
      data: { expiresAt: future },
    })
    await prisma.refreshToken.update({
      where: { id: staleRows[1]!.id },
      data: { expiresAt: past },
    })
    await api.post('/api/auth/refresh').set('Cookie', stale.refreshCookie).expect(401)

    // Healthy session must remain active and no replay event recorded.
    await api.post('/api/auth/refresh').set('Cookie', healthy.refreshCookie).expect(200)
    expect(await prisma.securityEvent.count({ where: { userId: user.id, type: 'session_replay_detected' } })).toBe(0)
  })

  it('requires an active family successor before escalating a legacy null-reason revoked row', async () => {
    const { user, password } = await createTestUser('session-legacy-null@test.local', 'session-password')
    const healthy = await login(user.email, password, 'Healthy Device')
    const future = new Date(Date.now() + 3_600_000)

    // Orphan legacy revoked row (no active successor in its family) -> 401 only, healthy survives.
    const orphanRaw = crypto.randomBytes(40).toString('hex')
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRefreshToken(orphanRaw),
        revoked: true,
        revokedAt: new Date(Date.now() - 10_000),
        revokeReason: null,
        expiresAt: future,
      },
    })
    await api.post('/api/auth/refresh').set('Cookie', [`${refreshTokenCookieName}=${orphanRaw}`]).expect(401)
    await api.post('/api/auth/refresh').set('Cookie', healthy.refreshCookie).expect(200)
    expect(await prisma.securityEvent.count({ where: { userId: user.id, type: 'session_replay_detected' } })).toBe(0)

    // Legacy null-reason row WITH an active successor in the same family -> escalates once, then becomes terminal.
    const liveFamily = await login(user.email, password, 'Legacy Live Family')
    const liveSessionId = sessionIdFromAccessToken(liveFamily.accessToken)
    const legacyPredRaw = crypto.randomBytes(40).toString('hex')
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        sessionId: liveSessionId,
        tokenHash: hashRefreshToken(legacyPredRaw),
        revoked: true,
        revokedAt: new Date(Date.now() - 10_000),
        revokeReason: null,
        expiresAt: future,
      },
    })
    await api.post('/api/auth/refresh').set('Cookie', [`${refreshTokenCookieName}=${legacyPredRaw}`]).expect(401)
    expect(await prisma.securityEvent.count({ where: { userId: user.id, type: 'session_replay_detected' } })).toBe(1)
    expect(await prisma.refreshToken.count({ where: { userId: user.id, revoked: false } })).toBe(0)

    // Re-login after replay; replaying the legacy row a second time must not revoke the new login.
    const afterReplay = await login(user.email, password, 'Fresh After Legacy Replay')
    await api.post('/api/auth/refresh').set('Cookie', [`${refreshTokenCookieName}=${legacyPredRaw}`]).expect(401)
    await api.post('/api/auth/refresh').set('Cookie', afterReplay.refreshCookie).expect(200)
    expect(await prisma.securityEvent.count({ where: { userId: user.id, type: 'session_replay_detected' } })).toBe(1)
  })

  it('counts only active families in revokeAllUserRefreshTokens and preserves request audit metadata across password and admin revocations', async () => {
    const { user, password } = await createTestUser('session-audit-count@test.local', 'Old#Pass-2026')
    const first = await login(user.email, password, 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/131.0 Safari/537.36')
    await login(user.email, password, 'Mozilla/5.0 (Windows NT 10.0) Firefox/130.0')

    // Insert an already-expired unrevoked row that must not inflate active family count.
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
        revoked: false,
        expiresAt: new Date(Date.now() - 60_000),
      },
    })

    const revokedFamilies = await revokeAllUserRefreshTokens(user.id, undefined, 'revoke_all', {
      ip: '203.0.113.55',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/131.0 Safari/537.36',
    })
    expect(revokedFamilies).toBe(2)
    expect(await prisma.refreshToken.count({ where: { userId: user.id, revoked: false } })).toBe(0)

    const directEvent = await prisma.securityEvent.findFirstOrThrow({
      where: { userId: user.id, type: 'session_revoked' },
      orderBy: { id: 'desc' },
    })
    expect(directEvent.detailSafe).toEqual({ reason: 'revoke_all', revokedCount: 2 })
    expect(directEvent.ipHash).toBeTruthy()
    expect(directEvent.deviceHint).toBe('Chrome · macOS')

    // Verify HTTP password-change passes request ip/user-agent metadata to SecurityEvent.
    const relogged = await login(user.email, password, 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/131.0 Safari/537.36')
    await api
      .post('/api/auth/password-change')
      .set(authHeader(relogged.accessToken))
      .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0) Firefox/130.0')
      .send({ currentPassword: password, newPassword: 'New#Pass-2026-Strong' })
      .expect(200)

    const pwdEvent = await prisma.securityEvent.findFirstOrThrow({
      where: { userId: user.id, type: 'session_revoked' },
      orderBy: { id: 'desc' },
    })
    expect(pwdEvent.ipHash).toBeTruthy()
    expect(pwdEvent.deviceHint).toBe('Firefox · Windows')
    expect(pwdEvent.detailSafe).toEqual({ reason: 'revoke_all', revokedCount: 1 })

    // Verify HTTP admin ban passes admin request metadata to SecurityEvent.
    const { user: admin, password: adminPassword } = await createTestUser('session-audit-admin@test.local', 'Admin#Pass-2026', 'admin')
    const adminSession = await loginAs(admin.email, adminPassword)
    await login(user.email, 'New#Pass-2026-Strong', 'Target Session')
    await api
      .put(`/api/admin/users/${user.id}/ban`)
      .set(authHeader(adminSession.accessToken))
      .set('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/131.0 Safari/537.36')
      .send({ reason: 'audit metadata check' })
      .expect(200)

    const banEvent = await prisma.securityEvent.findFirstOrThrow({
      where: { userId: user.id, type: 'session_revoked' },
      orderBy: { id: 'desc' },
    })
    expect(banEvent.ipHash).toBeTruthy()
    expect(banEvent.deviceHint).toBe('Chrome · macOS')
    expect(first.accessToken).toBeTruthy()
  })

  it('enforces role-based absolute session lifetimes and clamps rotated cookie Max-Age and JWT exp', async () => {
    const dayMs = 24 * 60 * 60 * 1000
    await prisma.systemConfig.upsert({
      where: { key: 'refreshTokenMaxAgeDays' },
      create: { key: 'refreshTokenMaxAgeDays', value: 365, description: 'test' },
      update: { value: 365 },
    })

    try {
      // User is capped at 90 days even when refreshTokenMaxAgeDays is 365.
      const { user, password } = await createTestUser('session-abs-user@test.local', 'Abs#Pass-2026')
      const userLogin = await login(user.email, password)
      const userRow = await prisma.refreshToken.findFirstOrThrow({
        where: { userId: user.id },
        orderBy: { id: 'desc' },
      })
      const userSpanDays = (userRow.absoluteExpiresAt!.getTime() - userRow.sessionStartedAt.getTime()) / dayMs
      expect(userSpanDays).toBeGreaterThan(89.9)
      expect(userSpanDays).toBeLessThan(90.1)
      expect(userRow.expiresAt.getTime()).toBeLessThanOrEqual(userRow.absoluteExpiresAt!.getTime())

      // Near absolute ceiling (90 seconds left): rotation clamps BOTH cookie Max-Age and JWT exp.
      const nearCeiling = new Date(Date.now() + 90_000)
      await prisma.refreshToken.update({
        where: { id: userRow.id },
        data: { absoluteExpiresAt: nearCeiling, expiresAt: nearCeiling },
      })
      const clampedRes = await api
        .post('/api/auth/refresh')
        .set('Cookie', userLogin.refreshCookie)
        .expect(200)
      const clampedClaims = jwt.decode(clampedRes.body.accessToken) as { exp?: number; iat?: number }
      expect(Number.isInteger(clampedClaims.exp)).toBe(true)
      expect(clampedClaims.exp! - clampedClaims.iat!).toBeLessThanOrEqual(90)
      expect(clampedClaims.exp! - clampedClaims.iat!).toBeGreaterThanOrEqual(80)
      const clampedCookie = refreshCookieFrom(clampedRes)
      const maxAgeMatch = clampedCookie.match(/Max-Age=(\d+)/)
      expect(maxAgeMatch).toBeTruthy()
      expect(Number(maxAgeMatch![1])).toBeLessThanOrEqual(90)
      expect(Number(maxAgeMatch![1])).toBeGreaterThanOrEqual(80)

      // Past absolute ceiling -> refresh fails with 401 and marks row expired.
      const rotatedRow = await prisma.refreshToken.findFirstOrThrow({
        where: { userId: user.id, revoked: false },
        orderBy: { id: 'desc' },
      })
      await prisma.refreshToken.update({
        where: { id: rotatedRow.id },
        data: { absoluteExpiresAt: new Date(Date.now() - 5_000), expiresAt: new Date(Date.now() + 60_000) },
      })
      await api
        .post('/api/auth/refresh')
        .set('Cookie', clampedCookie)
        .expect(401)
      const afterExpire = await prisma.refreshToken.findUniqueOrThrow({ where: { id: rotatedRow.id } })
      expect(afterExpire.revoked).toBe(true)
      expect(afterExpire.revokeReason).toBe('expired')

      // Admin is capped at 7 days even when refreshTokenMaxAgeDays is 365.
      const { user: admin, password: adminPassword } = await createTestUser('session-abs-admin@test.local', 'Adm#Pass-2026', 'admin')
      const adminSession = await loginAs(admin.email, adminPassword)
      expect(adminSession.accessToken).toBeTruthy()
      const adminRow = await prisma.refreshToken.findFirstOrThrow({
        where: { userId: admin.id, revoked: false },
        orderBy: { id: 'desc' },
      })
      const adminSpanDays = (adminRow.absoluteExpiresAt!.getTime() - adminRow.sessionStartedAt.getTime()) / dayMs
      expect(adminSpanDays).toBeGreaterThan(6.9)
      expect(adminSpanDays).toBeLessThan(7.1)

      // Once an admin session's absoluteExpiresAt passes, admin routes immediately reject even if expiresAt is still future.
      await prisma.refreshToken.update({
        where: { id: adminRow.id },
        data: { absoluteExpiresAt: new Date(Date.now() - 5_000), expiresAt: new Date(Date.now() + 60_000) },
      })
      const expiredAdminRes = await api
        .get('/api/admin/users')
        .set(authHeader(adminSession.accessToken))
        .expect(401)
      expect(expiredAdminRes.body.error.code).toBe('SESSION_REVOKED')
    } finally {
      await prisma.systemConfig.deleteMany({ where: { key: 'refreshTokenMaxAgeDays' } })
    }
  })

  it('caps active device families at 20 per user by evicting the oldest families on new logins, not on rotation', async () => {
    const { user, password } = await createTestUser('session-cap-20@test.local', 'Cap#Pass-2026')
    const baseTime = Date.now() - 60 * 60 * 1000
    const seededSessionIds: string[] = []
    for (let index = 0; index < 20; index += 1) {
      const row = await prisma.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: hashRefreshToken(crypto.randomBytes(40).toString('hex')),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          absoluteExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          sessionStartedAt: new Date(baseTime + index * 1_000),
          lastUsedAt: new Date(baseTime + index * 1_000),
          deviceLabel: 'Chrome · macOS',
          ipHint: '203.0.113.*',
        },
      })
      seededSessionIds.push(row.sessionId)
    }

    // 21st login must evict only the oldest seeded session (index 0) and keep active count at 20.
    const newestLogin = await login(user.email, password, 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/131.0 Safari/537.36')
    const activeRows = await prisma.refreshToken.findMany({
      where: { userId: user.id, revoked: false },
      select: { sessionId: true },
    })
    expect(activeRows).toHaveLength(20)
    expect(activeRows.some(row => row.sessionId === seededSessionIds[0])).toBe(false)
    expect(activeRows.some(row => row.sessionId === seededSessionIds[1])).toBe(true)

    const evictedRow = await prisma.refreshToken.findFirstOrThrow({
      where: { userId: user.id, sessionId: seededSessionIds[0] },
    })
    expect(evictedRow.revoked).toBe(true)
    expect(evictedRow.revokeReason).toBe('session_limit')

    const limitEvent = await prisma.securityEvent.findFirstOrThrow({
      where: { userId: user.id, type: 'session_revoked' },
      orderBy: { id: 'desc' },
    })
    expect(limitEvent.detailSafe).toEqual({ reason: 'session_limit', revokedCount: 1 })

    // Rotating the newest session at the 20-family cap must NOT evict any other family.
    await api.post('/api/auth/refresh').set('Cookie', newestLogin.refreshCookie).expect(200)
    const activeAfterRotate = await prisma.refreshToken.findMany({
      where: { userId: user.id, revoked: false },
      select: { sessionId: true },
    })
    expect(activeAfterRotate).toHaveLength(20)
    expect(activeAfterRotate.some(row => row.sessionId === seededSessionIds[1])).toBe(true)
  })
})
