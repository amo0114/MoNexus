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
import { lockUserRefreshSessionMutations } from './sessionService.js'

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const RETENTION_INTERVAL_MS = ONE_DAY_MS
export const REFRESH_TOKEN_FAMILY_RETENTION_DAYS = 30
const DEFAULT_BATCH_SIZE = 200
const DEFAULT_MAX_FAMILIES_PER_RUN = 1_000
const DEFAULT_MAX_SCRUB_BATCHES_PER_RUN = 25

export type RefreshFamilyCleanupResult = {
  familiesChecked: number
  familiesDeleted: number
  rowsDeleted: number
}

/**
 * Deletes fully expired RefreshToken families after the retention grace period.
 *
 * Scans rows by the composite `(expiresAt, id)` index with an advancing cursor
 * so historical predecessor rows of still-active families never stall cleanup.
 * Each candidate family is re-verified inside the user's session advisory lock
 * before the whole family is deleted atomically.
 */
export async function cleanupExpiredRefreshTokenFamilies(options: {
  now?: Date
  retentionDays?: number
  batchSize?: number
  maxFamiliesPerRun?: number
} = {}): Promise<RefreshFamilyCleanupResult> {
  const now = options.now ?? new Date()
  const retentionDays = options.retentionDays ?? REFRESH_TOKEN_FAMILY_RETENTION_DAYS
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const maxFamiliesPerRun = options.maxFamiliesPerRun ?? DEFAULT_MAX_FAMILIES_PER_RUN

  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
    throw new Error('retentionDays must be a positive integer')
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error('batchSize must be a positive integer')
  }
  if (!Number.isSafeInteger(maxFamiliesPerRun) || maxFamiliesPerRun < 1) {
    throw new Error('maxFamiliesPerRun must be a positive integer')
  }

  const cutoff = new Date(now.getTime() - retentionDays * ONE_DAY_MS)
  const seenFamilies = new Set<string>()
  let cursor: { expiresAt: Date; id: number } | null = null
  let familiesChecked = 0
  let familiesDeleted = 0
  let rowsDeleted = 0

  while (familiesChecked < maxFamiliesPerRun) {
    const afterCursor = cursor
    const candidates: Array<{ id: number; userId: number; sessionId: string; expiresAt: Date }> = await prisma.refreshToken.findMany({
      where: {
        expiresAt: { lt: cutoff },
        ...(afterCursor
          ? {
              OR: [
                { expiresAt: { gt: afterCursor.expiresAt } },
                { AND: [{ expiresAt: afterCursor.expiresAt }, { id: { gt: afterCursor.id } }] },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        userId: true,
        sessionId: true,
        expiresAt: true,
      },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: batchSize,
    })

    if (candidates.length === 0) break

    for (const candidate of candidates) {
      if (familiesChecked >= maxFamiliesPerRun) break
      const familyKey = `${candidate.userId}:${candidate.sessionId}`
      if (seenFamilies.has(familyKey)) continue
      seenFamilies.add(familyKey)
      familiesChecked += 1

      const deletedCount = await prisma.$transaction(async tx => {
        await lockUserRefreshSessionMutations(tx, candidate.userId)
        // Re-verify under lock that NO row in the family is active or within
        // the retention grace window (nor has an absolute ceiling still within grace).
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

    const last = candidates[candidates.length - 1]!
    cursor = { expiresAt: last.expiresAt, id: last.id }
    if (candidates.length < batchSize) break
  }

  return { familiesChecked, familiesDeleted, rowsDeleted }
}

/**
 * Interruptible, idempotent primary-key batched backfill that populates
 * `deviceLabel` / `ipHint` and clears legacy raw `ip` / `userAgent` columns on
 * historical RefreshToken rows in the same batch transaction.
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
    const rows = await prisma.refreshToken.findMany({
      where: {
        id: { gt: lastId },
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
      take: batchSize,
    })

    if (rows.length === 0) break

    const batchScrubbed = await prisma.$transaction(async tx => {
      let count = 0
      for (const row of rows) {
        const updated = await tx.refreshToken.updateMany({
          where: {
            id: row.id,
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

    totalScrubbed += batchScrubbed
    lastId = rows[rows.length - 1]!.id
    if (rows.length < batchSize) break
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
  const cleanup = await cleanupExpiredRefreshTokenFamilies({ now })
  const refreshTokensScrubbed = await scrubLegacyRefreshTokenMetadata()
  const fileGrantLogsScrubbed = await scrubLegacyFileGrantUserAgents()

  if (cleanup.rowsDeleted > 0 || refreshTokensScrubbed > 0 || fileGrantLogsScrubbed > 0) {
    logger.info(
      {
        familiesDeleted: cleanup.familiesDeleted,
        rowsDeleted: cleanup.rowsDeleted,
        refreshTokensScrubbed,
        fileGrantLogsScrubbed,
      },
      'auth session retention and legacy client-metadata scrub completed',
    )
  }

  return {
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
