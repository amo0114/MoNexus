import { redactIpHint } from '../../lib/clientIp.js'
import {
  ALL_KNOWN_DEVICE_LABELS,
  isKnownDeviceLabel,
  normalizeStoredDeviceLabel,
  sessionDeviceLabel,
} from '../../lib/deviceHint.js'
import { defineLeasedCron } from '../../lib/leasedCron.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { resolveLegacyAbsoluteExpiresAt } from './sessionPolicy.js'
import { lockUserRefreshSessionMutations } from './sessionService.js'

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const RETENTION_INTERVAL_MS = ONE_DAY_MS
export const REFRESH_TOKEN_FAMILY_RETENTION_DAYS = 30
const CLEANUP_CURSOR_KEY = 'refresh_token_cleanup'
const DEFAULT_BATCH_SIZE = 200
const DEFAULT_MAX_FAMILIES_PER_RUN = 1_000
const DEFAULT_MAX_ROWS_SCANNED_PER_RUN = 50_000
const DEFAULT_MAX_SCRUB_BATCHES_PER_RUN = 25

export type RefreshFamilyCleanupCursor = {
  expiresAt: Date
  id: number
}

export type RefreshFamilyCleanupResult = {
  rowsScanned: number
  familiesChecked: number
  familiesDeleted: number
  rowsDeleted: number
  nextCursor: RefreshFamilyCleanupCursor | null
}

type CleanupPageRow = {
  id: number
  userId: number
  sessionId: string
  expiresAt: Date
  eligible: boolean
}

async function loadCleanupCursor(): Promise<RefreshFamilyCleanupCursor | null> {
  const saved = await prisma.authSessionRetentionCursor.findUnique({
    where: { key: CLEANUP_CURSOR_KEY },
    select: { cursorExpiresAt: true, cursorId: true },
  })
  if (!saved || !saved.cursorExpiresAt || saved.cursorId === null) return null
  return { expiresAt: saved.cursorExpiresAt, id: saved.cursorId }
}

async function saveCleanupCursor(cursor: RefreshFamilyCleanupCursor | null): Promise<void> {
  await prisma.authSessionRetentionCursor.upsert({
    where: { key: CLEANUP_CURSOR_KEY },
    create: {
      key: CLEANUP_CURSOR_KEY,
      cursorExpiresAt: cursor?.expiresAt ?? null,
      cursorId: cursor?.id ?? null,
    },
    update: {
      cursorExpiresAt: cursor?.expiresAt ?? null,
      cursorId: cursor?.id ?? null,
    },
  })
}

async function fetchCleanupPage(input: {
  cutoff: Date
  now: Date
  cursor: RefreshFamilyCleanupCursor | null
  upperBound: RefreshFamilyCleanupCursor | null
  batchSize: number
}): Promise<CleanupPageRow[]> {
  if (input.cursor === null && input.upperBound === null) {
    return prisma.$queryRaw<CleanupPageRow[]>`
      WITH page AS (
        SELECT rt."id", rt."userId", rt."sessionId", rt."expiresAt"
        FROM "RefreshToken" rt
        WHERE rt."expiresAt" < ${input.cutoff}
        ORDER BY rt."expiresAt" ASC, rt."id" ASC
        LIMIT ${input.batchSize}
      )
      SELECT
        p."id",
        p."userId",
        p."sessionId",
        p."expiresAt",
        NOT EXISTS (
          SELECT 1
          FROM "RefreshToken" newer
          WHERE newer."userId" = p."userId"
            AND newer."sessionId" = p."sessionId"
            AND (
              newer."expiresAt" >= ${input.cutoff}
              OR (newer."revoked" = false AND newer."expiresAt" > ${input.now})
            )
        ) AS "eligible"
      FROM page p
      ORDER BY p."expiresAt" ASC, p."id" ASC
    `
  }

  if (input.cursor === null && input.upperBound !== null) {
    return prisma.$queryRaw<CleanupPageRow[]>`
      WITH page AS (
        SELECT rt."id", rt."userId", rt."sessionId", rt."expiresAt"
        FROM "RefreshToken" rt
        WHERE rt."expiresAt" < ${input.cutoff}
          AND (rt."expiresAt", rt."id") <= (${input.upperBound.expiresAt}, ${input.upperBound.id})
        ORDER BY rt."expiresAt" ASC, rt."id" ASC
        LIMIT ${input.batchSize}
      )
      SELECT
        p."id",
        p."userId",
        p."sessionId",
        p."expiresAt",
        NOT EXISTS (
          SELECT 1
          FROM "RefreshToken" newer
          WHERE newer."userId" = p."userId"
            AND newer."sessionId" = p."sessionId"
            AND (
              newer."expiresAt" >= ${input.cutoff}
              OR (newer."revoked" = false AND newer."expiresAt" > ${input.now})
            )
        ) AS "eligible"
      FROM page p
      ORDER BY p."expiresAt" ASC, p."id" ASC
    `
  }

  if (input.cursor !== null && input.upperBound === null) {
    return prisma.$queryRaw<CleanupPageRow[]>`
      WITH page AS (
        SELECT rt."id", rt."userId", rt."sessionId", rt."expiresAt"
        FROM "RefreshToken" rt
        WHERE rt."expiresAt" < ${input.cutoff}
          AND (rt."expiresAt", rt."id") > (${input.cursor.expiresAt}, ${input.cursor.id})
        ORDER BY rt."expiresAt" ASC, rt."id" ASC
        LIMIT ${input.batchSize}
      )
      SELECT
        p."id",
        p."userId",
        p."sessionId",
        p."expiresAt",
        NOT EXISTS (
          SELECT 1
          FROM "RefreshToken" newer
          WHERE newer."userId" = p."userId"
            AND newer."sessionId" = p."sessionId"
            AND (
              newer."expiresAt" >= ${input.cutoff}
              OR (newer."revoked" = false AND newer."expiresAt" > ${input.now})
            )
        ) AS "eligible"
      FROM page p
      ORDER BY p."expiresAt" ASC, p."id" ASC
    `
  }

  return prisma.$queryRaw<CleanupPageRow[]>`
    WITH page AS (
      SELECT rt."id", rt."userId", rt."sessionId", rt."expiresAt"
      FROM "RefreshToken" rt
      WHERE rt."expiresAt" < ${input.cutoff}
        AND (rt."expiresAt", rt."id") > (${input.cursor!.expiresAt}, ${input.cursor!.id})
        AND (rt."expiresAt", rt."id") <= (${input.upperBound!.expiresAt}, ${input.upperBound!.id})
      ORDER BY rt."expiresAt" ASC, rt."id" ASC
      LIMIT ${input.batchSize}
    )
    SELECT
      p."id",
      p."userId",
      p."sessionId",
      p."expiresAt",
      NOT EXISTS (
        SELECT 1
        FROM "RefreshToken" newer
        WHERE newer."userId" = p."userId"
          AND newer."sessionId" = p."sessionId"
          AND (
            newer."expiresAt" >= ${input.cutoff}
            OR (newer."revoked" = false AND newer."expiresAt" > ${input.now})
          )
      ) AS "eligible"
    FROM page p
    ORDER BY p."expiresAt" ASC, p."id" ASC
  `
}

/**
 * Deletes fully expired RefreshToken families after the retention grace period.
 *
 * Scans bounded pages via the composite `(expiresAt, id)` index while filtering
 * out clearly ineligible families (those still holding an active or within-grace
 * row) in PostgreSQL. Persists the exact last-processed `(expiresAt, id)` cursor
 * in `AuthSessionRetentionCursor` across runs and wraps cleanly back to `null`
 * upon reaching the tail, so neither family caps nor row-scan budgets can ever
 * cause cross-run starvation. Each eligible family is re-verified inside the
 * user's session advisory lock before whole-family deletion.
 */
export async function cleanupExpiredRefreshTokenFamilies(options: {
  now?: Date
  retentionDays?: number
  batchSize?: number
  maxFamiliesPerRun?: number
  maxRowsScanned?: number
} = {}): Promise<RefreshFamilyCleanupResult> {
  const now = options.now ?? new Date()
  const retentionDays = options.retentionDays ?? REFRESH_TOKEN_FAMILY_RETENTION_DAYS
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const maxFamiliesPerRun = options.maxFamiliesPerRun ?? DEFAULT_MAX_FAMILIES_PER_RUN
  const maxRowsScanned = options.maxRowsScanned ?? DEFAULT_MAX_ROWS_SCANNED_PER_RUN

  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
    throw new Error('retentionDays must be a positive integer')
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error('batchSize must be a positive integer')
  }
  if (!Number.isSafeInteger(maxFamiliesPerRun) || maxFamiliesPerRun < 1) {
    throw new Error('maxFamiliesPerRun must be a positive integer')
  }
  if (!Number.isSafeInteger(maxRowsScanned) || maxRowsScanned < 1) {
    throw new Error('maxRowsScanned must be a positive integer')
  }

  const cutoff = new Date(now.getTime() - retentionDays * ONE_DAY_MS)
  const seenFamilies = new Set<string>()
  const initialCursor = await loadCleanupCursor()
  let cursor = initialCursor
  let wrappedFromTail = false
  let reachedEnd = false
  let rowsScanned = 0
  let familiesChecked = 0
  let familiesDeleted = 0
  let rowsDeleted = 0

  while (familiesChecked < maxFamiliesPerRun && rowsScanned < maxRowsScanned) {
    const remainingRowBudget = maxRowsScanned - rowsScanned
    const pageLimit = Math.min(batchSize, remainingRowBudget)
    const upperBound = wrappedFromTail ? initialCursor : null
    const candidates = await fetchCleanupPage({ cutoff, now, cursor, upperBound, batchSize: pageLimit })
    if (candidates.length === 0) {
      if (!wrappedFromTail && initialCursor !== null) {
        wrappedFromTail = true
        cursor = null
        continue
      }
      reachedEnd = true
      break
    }

    let exhaustedFamilyBudget = false
    for (const candidate of candidates) {
      if (familiesChecked >= maxFamiliesPerRun) {
        exhaustedFamilyBudget = true
        break
      }
      rowsScanned += 1
      cursor = { expiresAt: candidate.expiresAt, id: candidate.id }

      if (!candidate.eligible) continue
      const familyKey = `${candidate.userId}:${candidate.sessionId}`
      if (seenFamilies.has(familyKey)) continue
      seenFamilies.add(familyKey)
      familiesChecked += 1

      const deletedCount = await prisma.$transaction(async tx => {
        await lockUserRefreshSessionMutations(tx, candidate.userId)
        const blocking = await tx.refreshToken.findFirst({
          where: {
            userId: candidate.userId,
            sessionId: candidate.sessionId,
            OR: [
              { expiresAt: { gte: cutoff } },
              { revoked: false, expiresAt: { gt: now } },
            ],
          },
          select: { id: true },
        })
        if (blocking) return 0

        const deleted = await tx.refreshToken.deleteMany({
          where: {
            userId: candidate.userId,
            sessionId: candidate.sessionId,
          },
        })
        return deleted.count
      })

      if (deletedCount > 0) {
        familiesDeleted += 1
        rowsDeleted += deletedCount
      }
    }

    if (!exhaustedFamilyBudget && candidates.length < pageLimit) {
      if (!wrappedFromTail && initialCursor !== null) {
        // Reached the tail after starting mid-table; wrap once up to
        // `initialCursor` using any remaining budget in this run.
        wrappedFromTail = true
        cursor = null
        continue
      }
      reachedEnd = true
      break
    }
  }

  const nextCursor = reachedEnd ? null : cursor
  await saveCleanupCursor(nextCursor)

  return { rowsScanned, familiesChecked, familiesDeleted, rowsDeleted, nextCursor }
}

/**
 * Lock-free online primary-key batched backfill for legacy active RefreshToken
 * rows whose `absoluteExpiresAt` is still NULL after the metadata-only DDL
 * migration.
 *
 * - Groups candidates by `userId` and updates each user in its own short
 *   transaction after acquiring `lockUserRefreshSessionMutations(tx, userId)`,
 *   matching the universal lock order of all session writers (deadlock-free
 *   with `revokeAllUserRefreshTokens`, `changePassword`, and refresh rotation).
 * - Reuses `resolveLegacyAbsoluteExpiresAt` from `sessionPolicy.ts` so outcome
 *   is identical regardless of whether backfill or refresh runs first.
 */
export async function backfillLegacyRefreshTokenAbsoluteExpiry(options: {
  now?: Date
  batchSize?: number
  maxBatches?: number
} = {}): Promise<number> {
  const now = options.now ?? new Date()
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_SCRUB_BATCHES_PER_RUN
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error('batchSize must be a positive integer')
  }
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1) {
    throw new Error('maxBatches must be a positive integer')
  }

  let lastId = 0
  let totalBackfilled = 0

  for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
    const candidates = await prisma.refreshToken.findMany({
      where: {
        id: { gt: lastId },
        revoked: false,
        expiresAt: { gt: now },
        absoluteExpiresAt: null,
      },
      select: { id: true, userId: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    })

    if (candidates.length === 0) break

    const rowIdsByUser = new Map<number, number[]>()
    for (const candidate of candidates) {
      const ids = rowIdsByUser.get(candidate.userId)
      if (ids) ids.push(candidate.id)
      else rowIdsByUser.set(candidate.userId, [candidate.id])
    }

    for (const [userId, rowIds] of rowIdsByUser) {
      const userBackfilled = await prisma.$transaction(async tx => {
        await lockUserRefreshSessionMutations(tx, userId)
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { role: true },
        })
        if (!user) return 0

        const liveRows = await tx.refreshToken.findMany({
          where: {
            id: { in: rowIds },
            userId,
            revoked: false,
            expiresAt: { gt: now },
            absoluteExpiresAt: null,
          },
          select: { id: true, sessionStartedAt: true, expiresAt: true },
          orderBy: { id: 'asc' },
        })

        let count = 0
        for (const row of liveRows) {
          const absoluteExpiresAt = resolveLegacyAbsoluteExpiresAt({
            role: user.role,
            sessionStartedAt: row.sessionStartedAt,
            expiresAt: row.expiresAt,
          })
          if (user.role === 'admin') {
            const tightenedExpiresAt = row.expiresAt.getTime() <= absoluteExpiresAt.getTime()
              ? row.expiresAt
              : absoluteExpiresAt
            const alreadyPastCap = tightenedExpiresAt.getTime() <= now.getTime()
            const updated = await tx.refreshToken.updateMany({
              where: { id: row.id, userId, revoked: false, absoluteExpiresAt: null },
              data: {
                absoluteExpiresAt,
                expiresAt: tightenedExpiresAt,
                ...(alreadyPastCap ? { revoked: true, revokedAt: now, revokeReason: 'expired' } : {}),
              },
            })
            count += updated.count
          } else {
            const updated = await tx.refreshToken.updateMany({
              where: { id: row.id, userId, revoked: false, absoluteExpiresAt: null },
              data: { absoluteExpiresAt },
            })
            count += updated.count
          }
        }
        return count
      })

      totalBackfilled += userBackfilled
    }

    lastId = candidates[candidates.length - 1]!.id
    if (candidates.length < batchSize) break
  }

  return totalBackfilled
}

/**
 * Interruptible, idempotent primary-key batched backfill that populates
 * `deviceLabel` / `ipHint` and clears legacy raw `ip` / `userAgent` columns on
 * historical RefreshToken rows. Updates are scoped to one user per transaction
 * under `lockUserRefreshSessionMutations` to prevent deadlocks with concurrent
 * session revocations.
 */
export async function scrubLegacyRefreshTokenMetadata(options: {
  batchSize?: number
  maxBatches?: number
} = {}): Promise<number> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_SCRUB_BATCHES_PER_RUN
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error('batchSize must be a positive integer')
  }
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1) {
    throw new Error('maxBatches must be a positive integer')
  }

  let lastId = 0
  let totalScrubbed = 0

  for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
    const candidates = await prisma.refreshToken.findMany({
      where: {
        id: { gt: lastId },
        OR: [{ ip: { not: null } }, { userAgent: { not: null } }],
      },
      select: { id: true, userId: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    })

    if (candidates.length === 0) break

    const rowIdsByUser = new Map<number, number[]>()
    for (const candidate of candidates) {
      const ids = rowIdsByUser.get(candidate.userId)
      if (ids) ids.push(candidate.id)
      else rowIdsByUser.set(candidate.userId, [candidate.id])
    }

    for (const [userId, rowIds] of rowIdsByUser) {
      const userScrubbed = await prisma.$transaction(async tx => {
        await lockUserRefreshSessionMutations(tx, userId)
        const rows = await tx.refreshToken.findMany({
          where: {
            id: { in: rowIds },
            userId,
            OR: [{ ip: { not: null } }, { userAgent: { not: null } }],
          },
          select: {
            id: true,
            ip: true,
            userAgent: true,
            deviceLabel: true,
            ipHint: true,
          },
          orderBy: { id: 'asc' },
        })

        let count = 0
        for (const row of rows) {
          const updated = await tx.refreshToken.updateMany({
            where: {
              id: row.id,
              userId,
              OR: [{ ip: { not: null } }, { userAgent: { not: null } }],
            },
            data: {
              deviceLabel: row.deviceLabel ?? sessionDeviceLabel(row.userAgent),
              ipHint: row.ipHint ?? redactIpHint(row.ip),
              ip: null,
              userAgent: null,
            },
          })
          count += updated.count
        }
        return count
      })

      totalScrubbed += userScrubbed
    }

    lastId = candidates[candidates.length - 1]!.id
    if (candidates.length < batchSize) break
  }

  return totalScrubbed
}

/**
 * Interruptible, idempotent primary-key batched rewrite of historical raw
 * FileGrantLog.userAgent values to fixed whitelisted client summaries.
 * Already-summarized rows are recognized and left untouched.
 */
export async function scrubLegacyFileGrantUserAgents(options: {
  batchSize?: number
  maxBatches?: number
} = {}): Promise<number> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_SCRUB_BATCHES_PER_RUN
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error('batchSize must be a positive integer')
  }
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1) {
    throw new Error('maxBatches must be a positive integer')
  }

  let lastId = 0
  let totalScrubbed = 0

  for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
    const rows = await prisma.fileGrantLog.findMany({
      where: {
        id: { gt: lastId },
        userAgent: { not: null, notIn: [...ALL_KNOWN_DEVICE_LABELS] },
      },
      select: {
        id: true,
        userAgent: true,
      },
      orderBy: { id: 'asc' },
      take: batchSize,
    })

    if (rows.length === 0) break

    const toRewrite = rows.filter(row => row.userAgent !== null && !isKnownDeviceLabel(row.userAgent))
    if (toRewrite.length > 0) {
      const batchScrubbed = await prisma.$transaction(async tx => {
        let count = 0
        for (const row of toRewrite) {
          const summary = normalizeStoredDeviceLabel(row.userAgent)
          const updated = await tx.fileGrantLog.updateMany({
            where: { id: row.id, userAgent: row.userAgent },
            data: { userAgent: summary },
          })
          count += updated.count
        }
        return count
      })
      totalScrubbed += batchScrubbed
    }

    lastId = rows[rows.length - 1]!.id
    if (rows.length < batchSize) break
  }

  return totalScrubbed
}

export async function runAuthSessionRetentionTick(now: Date = new Date()) {
  const absoluteBackfilled = await backfillLegacyRefreshTokenAbsoluteExpiry({ now })
  const cleanup = await cleanupExpiredRefreshTokenFamilies({ now })
  const refreshTokensScrubbed = await scrubLegacyRefreshTokenMetadata()
  const fileGrantLogsScrubbed = await scrubLegacyFileGrantUserAgents()

  if (
    absoluteBackfilled > 0
    || cleanup.rowsDeleted > 0
    || refreshTokensScrubbed > 0
    || fileGrantLogsScrubbed > 0
  ) {
    logger.info(
      {
        absoluteBackfilled,
        rowsScanned: cleanup.rowsScanned,
        familiesDeleted: cleanup.familiesDeleted,
        rowsDeleted: cleanup.rowsDeleted,
        refreshTokensScrubbed,
        fileGrantLogsScrubbed,
      },
      'auth session retention and legacy client-metadata scrub completed',
    )
  }

  return {
    absoluteBackfilled,
    ...cleanup,
    refreshTokensScrubbed,
    fileGrantLogsScrubbed,
  }
}

const sessionRetentionCron = defineLeasedCron({
  name: 'authSessionRetention',
  intervalMs: RETENTION_INTERVAL_MS,
  run: async () => {
    await runAuthSessionRetentionTick()
  },
})

export function startAuthSessionRetentionCron() {
  sessionRetentionCron.start()
}

export function stopAuthSessionRetentionCron() {
  sessionRetentionCron.stop()
}
