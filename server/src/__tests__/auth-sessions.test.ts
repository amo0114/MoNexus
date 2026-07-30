import jwt from 'jsonwebtoken'
import { describe, expect, it } from 'vitest'
import { api, authHeader, createTestMerchant, createTestUser } from './helpers.js'
import { prisma } from '../lib/prisma.js'
import { refreshTokenCookieName } from '../lib/cookies.js'
import { changePassword, loginUser, refreshAccessToken } from '../modules/auth/service.js'
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

    const refreshed = await api
      .post('/api/auth/refresh')
      .set('Cookie', original.refreshCookie)
      .set('User-Agent', 'Sensitive Session UA / 1.0')
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
      lastUsedAdvanced: refreshedRow.lastUsedAt.getTime() >= originalRow.lastUsedAt.getTime(),
      refreshedSid: refreshedClaims?.sid === originalRow.sessionId,
    }
    const failedRotationInvariants = Object.entries(rotationInvariants)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
    expect(failedRotationInvariants).toEqual([])

    const items = await listSessions(refreshed.body.accessToken)
    const [current] = items
    const noRawMetadata = !JSON.stringify(items).includes(originalRow.userAgent ?? '')
      && !JSON.stringify(items).includes(originalRow.ip ?? '')
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
      && current.sessionId === originalRow.sessionId
      && !('tokenHash' in current)
      && !('userAgent' in current)
      && !('ip' in current)

    expect(items.length === 1 && hasOnlySummaryFields && noRawMetadata).toBe(true)
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

    await api.post('/api/auth/logout').set('Cookie', current.refreshCookie).expect(200)
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

    await api.post('/api/auth/logout').set('Cookie', rotating.refreshCookie).expect(200)
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
    expect(banned.status === '已封禁' && approved.status === 'active' && suspended.status === 'suspended').toBe(true)
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
      && typeof detail?.revokedCount === 'number',
    ).toBe(true)
  })
})
