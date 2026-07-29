/**
 * TIMESTAMP WITHOUT TIME ZONE columns on FakaBridgeTask store UTC wall clocks.
 * Evaluate due/lease with AT TIME ZONE 'UTC' against a bound JS Date (timestamptz),
 * matching runFakaBridgeBatch — so Asia/Shanghai (or any) session TZ cannot skew
 * claim, gate, revoke, or reconcile.
 */
import type { Prisma } from '@prisma/client'

type Tx = Prisma.TransactionClient | typeof import('../prisma.js').prisma

export type TaskScheduleUtc = {
  leaseExpired: boolean
  nextAttemptDue: boolean
}

/**
 * Read lease / nextAttempt due flags under UTC interpretation of bare timestamps.
 * Returns null if the task row is missing.
 */
export async function readTaskScheduleUtc(
  db: Tx,
  taskId: number,
  now: Date = new Date()
): Promise<TaskScheduleUtc | null> {
  // Bound ${now} is timestamptz; column AT TIME ZONE 'UTC' lifts bare TIMESTAMP → timestamptz.
  const rows = await db.$queryRaw<
    Array<{ lease_expired: boolean; next_due: boolean }>
  >`
    SELECT
      (
        "leaseUntil" IS NULL
        OR ("leaseUntil" AT TIME ZONE 'UTC') <= ${now}
      ) AS lease_expired,
      (
        ("nextAttemptAt" AT TIME ZONE 'UTC') <= ${now}
      ) AS next_due
    FROM "FakaBridgeTask"
    WHERE "id" = ${taskId}
  `
  if (rows.length === 0) return null
  return {
    leaseExpired: Boolean(rows[0].lease_expired),
    nextAttemptDue: Boolean(rows[0].next_due),
  }
}

/** True when lease is absent or expired (UTC). */
export async function isLeaseExpiredUtc(
  db: Tx,
  taskId: number,
  now: Date = new Date()
): Promise<boolean> {
  const s = await readTaskScheduleUtc(db, taskId, now)
  return s?.leaseExpired ?? true
}
