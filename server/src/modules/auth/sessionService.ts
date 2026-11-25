import type { Prisma } from '@prisma/client'
import { redactIpHint } from '../../lib/clientIp.js'
import { sessionDeviceLabel } from '../../lib/deviceHint.js'
import { badRequest, notFound, sessionChanged, unauthenticated } from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'
import {
  recordSecurityEvent,
  type SessionRevocationReason,
} from './securityEvents.js'
import { MAX_ACTIVE_SESSIONS_PER_USER } from './sessionPolicy.js'

type RefreshTokenClient = Pick<typeof prisma, 'refreshToken'>

// Keep this namespace distinct from deliveryKeyLock's 20260726 class ID. The
// lock is deliberately user-scoped: global revoke must serialize with every
// device family without acquiring a deadlock-prone set of family locks.
const REFRESH_SESSION_LOCK_CLASS = 20260727

/** Server-initiated terminal actions which must dominate an older rotation row. */
const EXPLICIT_SESSION_TERMINATION_REASONS: readonly SessionRevocationReason[] = [
  'logout',
  'single_session',
  'revoke_others',
  'revoke_all',
  'mfa_reconfigured',
  'mfa_break_glass_reset',
  'mfa_migration',
  'refresh_replay',
  'expired',
  'login_replaced',
  'session_limit',
]

export type SessionRequestMetadata = {
  ip?: string | null
  userAgent?: string | null
}

export type CreateRefreshTokenInput = {
  userId: number
  tokenHash: string
  expiresAt: Date
  absoluteExpiresAt?: Date | null
  ip?: string | null
  userAgent?: string | null
  deviceLabel?: string | null
  ipHint?: string | null
  /** Omit for a new device session; PostgreSQL supplies its UUID family ID. */
  sessionId?: string
  /** Supply only while rotating an existing family. */
  sessionStartedAt?: Date
  /** Supply only while rotating an existing family. */
  lastUsedAt?: Date
}

export type ActiveSessionSummary = {
  sessionId: string
  deviceLabel: string
  ipHint: string
  sessionStartedAt: Date
  lastUsedAt: Date
  current: boolean
}

function clientFor(tx?: Prisma.TransactionClient): RefreshTokenClient {
  return tx ?? prisma
}

/**
 * Serializes every mutation of one user's refresh-session state on the same
 * PostgreSQL transaction connection. Callers must re-read any pre-lock lookup
 * after this returns; an initial raw-token lookup is only safe for user ID
 * discovery. Transaction-scoped locks are released automatically at commit or
 * rollback and remain correct across multiple API processes.
 */
export async function lockUserRefreshSessionMutations(tx: Prisma.TransactionClient, userId: number) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(${REFRESH_SESSION_LOCK_CLASS}::int4, ${userId}::int4)
  `
}

/**
 * A family-level terminal marker matters because explicit revocation updates
 * only the active successor. Its historical predecessor can correctly retain
 * `refresh_rotation`, but must no longer escalate a later refresh into a
 * user-wide replay response.
 */
export async function hasExplicitRefreshSessionTermination(
  tx: Prisma.TransactionClient,
  userId: number,
  sessionId: string,
) {
  const marker = await tx.refreshToken.findFirst({
    where: {
      userId,
      sessionId,
      revoked: true,
      revokeReason: { in: [...EXPLICIT_SESSION_TERMINATION_REASONS] },
    },
    select: { id: true },
  })
  return marker !== null
}

/**
 * A rotated or legacy-null row can only be an active token theft / replay when
 * its family still holds an unexpired active successor. Otherwise, replaying a
 * dead or naturally expired predecessor must return 401 without revoking the
 * user's other active device sessions.
 */
export function activeRefreshTokenWhere(now: Date = new Date()): Prisma.RefreshTokenWhereInput {
  return {
    revoked: false,
    expiresAt: { gt: now },
    OR: [
      { absoluteExpiresAt: null },
      { absoluteExpiresAt: { gt: now } },
    ],
  }
}

export async function hasActiveRefreshSessionSuccessor(
  tx: Prisma.TransactionClient,
  userId: number,
  sessionId: string,
  now: Date = new Date(),
) {
  const active = await tx.refreshToken.findFirst({
    where: {
      userId,
      sessionId,
      ...activeRefreshTokenWhere(now),
    },
    select: { id: true },
  })
  return active !== null
}

/**
 * Enforces the per-user active family cap before a new login/register/MFA
 * family is inserted. Must be called inside the user's advisory-lock
 * transaction. Rotation never calls this because it stays in the same family.
 */
export async function enforceUserActiveSessionLimit(
  tx: Prisma.TransactionClient,
  userId: number,
  now: Date,
  metadata?: SessionRequestMetadata,
  maxActiveSessions: number = MAX_ACTIVE_SESSIONS_PER_USER,
) {
  const rows = await tx.refreshToken.findMany({
    where: { userId, ...activeRefreshTokenWhere(now) },
    select: { sessionId: true, lastUsedAt: true },
  })

  const byFamily = new Map<string, Date>()
  for (const row of rows) {
    const existing = byFamily.get(row.sessionId)
    if (!existing || row.lastUsedAt > existing) {
      byFamily.set(row.sessionId, row.lastUsedAt)
    }
  }

  if (byFamily.size < maxActiveSessions) return 0

  const evictCount = byFamily.size - maxActiveSessions + 1
  const evictedSessionIds = [...byFamily.entries()]
    .sort((left, right) => left[1].getTime() - right[1].getTime() || left[0].localeCompare(right[0]))
    .slice(0, evictCount)
    .map(([sessionId]) => sessionId)

  await tx.refreshToken.updateMany({
    where: { userId, sessionId: { in: evictedSessionIds }, revoked: false },
    data: { revoked: true, revokedAt: now, revokeReason: 'session_limit' },
  })

  await recordSecurityEvent({
    type: 'session_revoked',
    userId,
    ip: metadata?.ip,
    userAgent: metadata?.userAgent,
    detail: { reason: 'session_limit', revokedCount: evictedSessionIds.length },
  }, tx)

  return evictedSessionIds.length
}

/**
 * Writes one refresh-token row. Only minimized display summaries (`deviceLabel`,
 * `ipHint`) are persisted; legacy raw `ip` and `userAgent` columns are always
 * written as `null` by new code while remaining nullable for deploy compatibility.
 */
export async function createRefreshTokenRecord(input: CreateRefreshTokenInput, tx: Prisma.TransactionClient) {
  const deviceLabel = input.deviceLabel ?? sessionDeviceLabel(input.userAgent ?? null)
  const ipHint = input.ipHint ?? redactIpHint(input.ip ?? null)

  return tx.refreshToken.create({
    data: {
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      ...(input.absoluteExpiresAt === undefined ? {} : { absoluteExpiresAt: input.absoluteExpiresAt }),
      deviceLabel,
      ipHint,
      ip: null,
      userAgent: null,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.sessionStartedAt === undefined ? {} : { sessionStartedAt: input.sessionStartedAt }),
      ...(input.lastUsedAt === undefined ? {} : { lastUsedAt: input.lastUsedAt }),
    },
  })
}

async function assertCurrentSessionActive(
  userId: number,
  currentSessionId: string,
  tx?: Prisma.TransactionClient,
) {
  const now = new Date()
  const active = await clientFor(tx).refreshToken.findFirst({
    where: {
      userId,
      sessionId: currentSessionId,
      ...activeRefreshTokenWhere(now),
    },
    select: { id: true },
  })

  if (!active) throw unauthenticated('登录会话已失效，请重新登录')
}

/** Lists one safe summary per active device family, never raw token metadata. */
export async function listActiveSessions(userId: number, currentSessionId: string): Promise<ActiveSessionSummary[]> {
  const now = new Date()
  await assertCurrentSessionActive(userId, currentSessionId)

  const rows = await prisma.refreshToken.findMany({
    where: { userId, ...activeRefreshTokenWhere(now) },
    select: {
      sessionId: true,
      sessionStartedAt: true,
      lastUsedAt: true,
      deviceLabel: true,
      ipHint: true,
      ip: true,
      userAgent: true,
    },
    orderBy: { lastUsedAt: 'desc' },
  })

  // Rotation should leave one active row per family. Group defensively so a
  // future storage bug cannot leak duplicate "devices" into the UI.
  const bySessionId = new Map<string, typeof rows[number]>()
  for (const row of rows) {
    const existing = bySessionId.get(row.sessionId)
    if (!existing || row.lastUsedAt > existing.lastUsedAt) bySessionId.set(row.sessionId, row)
  }

  return [...bySessionId.values()]
    .map(row => ({
      sessionId: row.sessionId,
      deviceLabel: row.deviceLabel ?? sessionDeviceLabel(row.userAgent),
      ipHint: row.ipHint ?? redactIpHint(row.ip),
      sessionStartedAt: row.sessionStartedAt,
      lastUsedAt: row.lastUsedAt,
      current: row.sessionId === currentSessionId,
    }))
    .sort((left, right) => Number(right.current) - Number(left.current) || right.lastUsedAt.getTime() - left.lastUsedAt.getTime())
}

async function revokeFamily(
  input: {
    userId: number
    sessionId: string
    reason: 'logout' | 'single_session'
    metadata?: SessionRequestMetadata
  },
  tx: Prisma.TransactionClient,
) {
  const now = new Date()
  const result = await tx.refreshToken.updateMany({
    where: { userId: input.userId, sessionId: input.sessionId, revoked: false },
    data: { revoked: true, revokedAt: now, revokeReason: input.reason },
  })

  if (result.count > 0) {
    await recordSecurityEvent({
      type: 'session_revoked',
      userId: input.userId,
      sessionId: input.sessionId,
      ip: input.metadata?.ip,
      userAgent: input.metadata?.userAgent,
      detail: { reason: input.reason, revokedCount: 1 },
    }, tx)
  }

  return result.count
}

/** Revokes an owned target family, explicitly excluding the current family. */
export async function revokeOwnedNonCurrentSession(input: {
  userId: number
  currentSessionId: string
  targetSessionId: string
  metadata?: SessionRequestMetadata
}) {
  return prisma.$transaction(async tx => {
    await lockUserRefreshSessionMutations(tx, input.userId)
    await assertCurrentSessionActive(input.userId, input.currentSessionId, tx)

    if (input.targetSessionId === input.currentSessionId) {
      throw badRequest('当前设备请通过退出登录操作', 'CURRENT_SESSION_REQUIRES_LOGOUT')
    }

    const activeTarget = await tx.refreshToken.findFirst({
      where: {
        userId: input.userId,
        sessionId: input.targetSessionId,
        ...activeRefreshTokenWhere(new Date()),
      },
      select: { id: true },
    })
    if (!activeTarget) throw notFound('会话不存在')

    const revokedRows = await revokeFamily({
      userId: input.userId,
      sessionId: input.targetSessionId,
      reason: 'single_session',
      metadata: input.metadata,
    }, tx)
    if (revokedRows === 0) throw notFound('会话不存在')

    return { revokedCount: 1 }
  })
}

/** Revokes every active family except the one identified by the caller's sid. */
export async function revokeOtherSessions(input: {
  userId: number
  currentSessionId: string
  metadata?: SessionRequestMetadata
}) {
  return prisma.$transaction(async tx => {
    await lockUserRefreshSessionMutations(tx, input.userId)
    await assertCurrentSessionActive(input.userId, input.currentSessionId, tx)

    const activeFamilies = await tx.refreshToken.findMany({
      where: {
        userId: input.userId,
        sessionId: { not: input.currentSessionId },
        ...activeRefreshTokenWhere(new Date()),
      },
      distinct: ['sessionId'],
      select: { sessionId: true },
    })
    const sessionIds = activeFamilies.map(row => row.sessionId)
    if (sessionIds.length === 0) return { revokedCount: 0 }

    await tx.refreshToken.updateMany({
      where: { userId: input.userId, sessionId: { in: sessionIds }, revoked: false },
      data: { revoked: true, revokedAt: new Date(), revokeReason: 'revoke_others' },
    })
    await recordSecurityEvent({
      type: 'session_revoked',
      userId: input.userId,
      ip: input.metadata?.ip,
      userAgent: input.metadata?.userAgent,
      detail: { reason: 'revoke_others', revokedCount: sessionIds.length },
    }, tx)

    return { revokedCount: sessionIds.length }
  })
}

/** Used by the existing logout cookie flow to revoke its whole family. */
export async function revokeRefreshSessionByTokenHash(input: {
  tokenHash: string
  expectedSessionId?: string
  metadata?: SessionRequestMetadata
}) {
  const pointer = await prisma.refreshToken.findUnique({
    where: { tokenHash: input.tokenHash },
    select: { userId: true },
  })
  if (!pointer) return { revokedCount: 0 }

  return prisma.$transaction(async tx => {
    await lockUserRefreshSessionMutations(tx, pointer.userId)

    const token = await tx.refreshToken.findFirst({
      // A stale predecessor must still resolve its family after rotation so a
      // concurrent logout cannot leave the successor active.
      where: { tokenHash: input.tokenHash },
      select: { userId: true, sessionId: true },
    })
    if (!token) return { revokedCount: 0 }
    if (input.expectedSessionId && token.sessionId !== input.expectedSessionId) {
      throw sessionChanged()
    }

    const revokedRows = await revokeFamily({
      userId: token.userId,
      sessionId: token.sessionId,
      reason: 'logout',
      metadata: input.metadata,
    }, tx)
    return { revokedCount: revokedRows > 0 ? 1 : 0 }
  })
}

export async function revokeAllUserRefreshTokens(
  userId: number,
  tx?: Prisma.TransactionClient,
  revokeReason: SessionRevocationReason = 'revoke_all',
  metadata: SessionRequestMetadata = {},
) {
  const revokeInTransaction = async (transaction: Prisma.TransactionClient) => {
    await lockUserRefreshSessionMutations(transaction, userId)
    const now = new Date()
    const activeFamilies = await transaction.refreshToken.findMany({
      where: { userId, ...activeRefreshTokenWhere(now) },
      distinct: ['sessionId'],
      select: { sessionId: true },
    })
    await transaction.refreshToken.updateMany({
      where: { userId, ...activeRefreshTokenWhere(now) },
      data: { revoked: true, revokedAt: now, revokeReason },
    })
    await transaction.refreshToken.updateMany({
      where: { userId, revoked: false },
      data: { revoked: true, revokedAt: now, revokeReason: 'expired' },
    })
    const revokedFamilyCount = activeFamilies.length
    if (revokedFamilyCount > 0) {
      await recordSecurityEvent({
        type: 'session_revoked',
        userId,
        ip: metadata.ip,
        userAgent: metadata.userAgent,
        detail: { reason: revokeReason, revokedCount: revokedFamilyCount },
      }, transaction)
    }
    return revokedFamilyCount
  }

  if (tx) return revokeInTransaction(tx)
  return prisma.$transaction(revokeInTransaction)
}
