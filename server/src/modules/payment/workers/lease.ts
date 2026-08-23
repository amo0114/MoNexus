import { randomUUID } from 'node:crypto'
import { prisma } from '../../../lib/prisma.js'

export const DEFAULT_LEASE_MS = 30_000

export type LeaseClaim = {
  id: string
  leaseToken: string
}

export function newLeaseToken(): string {
  return randomUUID()
}

export function isPaymentDeadlock(error: unknown): boolean {
  const rec = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
  const code = rec.code != null ? String(rec.code) : ''
  const meta = rec.meta && typeof rec.meta === 'object' ? rec.meta as Record<string, unknown> : {}
  const text = [code, meta.code, rec.message].map(item => item == null ? '' : String(item)).join(' ')
  return code === 'P2034' || code === '40P01' || /40P01|deadlock/i.test(text)
}

function leaseUntil(ms: number): Date {
  return new Date(Date.now() + ms)
}

/** Claim a PaymentEvent. Expired owners lose the row; only the new token can commit. */
export async function claimPaymentEvent(
  id: string,
  leaseMs = DEFAULT_LEASE_MS,
): Promise<LeaseClaim | null> {
  const leaseToken = newLeaseToken()
  const until = leaseUntil(leaseMs)
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "PaymentEvent"
    SET
      "status" = 'processing',
      "attempts" = "attempts" + 1,
      "leaseToken" = ${leaseToken}::uuid,
      "leaseUntil" = ${until},
      "lastErrorCode" = NULL
    WHERE "id" = ${id}::uuid
      AND "status" IN ('received', 'processing', 'failed')
      AND "nextAttemptAt" <= NOW()
      AND ("leaseUntil" IS NULL OR "leaseUntil" < NOW())
    RETURNING "id"`
  return rows[0] ? { id: rows[0].id, leaseToken } : null
}

export async function claimNextPaymentEvent(leaseMs = DEFAULT_LEASE_MS): Promise<LeaseClaim | null> {
  const leaseToken = newLeaseToken()
  const until = leaseUntil(leaseMs)
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "PaymentEvent"
    SET
      "status" = 'processing',
      "attempts" = "attempts" + 1,
      "leaseToken" = ${leaseToken}::uuid,
      "leaseUntil" = ${until},
      "lastErrorCode" = NULL
    WHERE "id" = (
      SELECT "id" FROM "PaymentEvent"
      WHERE "status" IN ('received', 'processing', 'failed')
        AND "nextAttemptAt" <= NOW()
        AND ("leaseUntil" IS NULL OR "leaseUntil" < NOW())
      ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING "id"`
  return rows[0] ? { id: rows[0].id, leaseToken } : null
}

export async function commitPaymentEvent(
  id: string,
  leaseToken: string,
  status: 'processed' | 'ignored' | 'failed' | 'reconcile_required',
  lastErrorCode?: string | null,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "PaymentEvent"
    SET
      "status" = ${status},
      "processedAt" = CASE WHEN ${status} IN ('processed', 'ignored', 'reconcile_required') THEN NOW() ELSE "processedAt" END,
      "leaseToken" = NULL,
      "leaseUntil" = NULL,
      "lastErrorCode" = ${lastErrorCode ?? null},
      "nextAttemptAt" = CASE
        WHEN ${status} = 'failed' THEN NOW() + (LEAST("attempts", 8) * interval '2 seconds')
        ELSE "nextAttemptAt"
      END
    WHERE "id" = ${id}::uuid
      AND "leaseToken" = ${leaseToken}::uuid
    RETURNING "id"`
  return rows.length === 1
}

export async function claimCreditTask(
  id: string,
  leaseMs = DEFAULT_LEASE_MS,
): Promise<LeaseClaim | null> {
  const leaseToken = newLeaseToken()
  const until = leaseUntil(leaseMs)
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "RechargeCreditTask"
    SET
      "status" = 'processing',
      "attempts" = "attempts" + 1,
      "leaseToken" = ${leaseToken}::uuid,
      "leaseUntil" = ${until},
      "lastErrorCode" = NULL
    WHERE "id" = ${id}::uuid
      AND "status" IN ('pending', 'processing', 'failed')
      AND "nextAttemptAt" <= NOW()
      AND ("leaseUntil" IS NULL OR "leaseUntil" < NOW())
    RETURNING "id"`
  return rows[0] ? { id: rows[0].id, leaseToken } : null
}

export async function claimNextCreditTask(leaseMs = DEFAULT_LEASE_MS): Promise<LeaseClaim | null> {
  const leaseToken = newLeaseToken()
  const until = leaseUntil(leaseMs)
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "RechargeCreditTask"
    SET
      "status" = 'processing',
      "attempts" = "attempts" + 1,
      "leaseToken" = ${leaseToken}::uuid,
      "leaseUntil" = ${until},
      "lastErrorCode" = NULL
    WHERE "id" = (
      SELECT "id" FROM "RechargeCreditTask"
      WHERE "status" IN ('pending', 'processing', 'failed')
        AND "nextAttemptAt" <= NOW()
        AND ("leaseUntil" IS NULL OR "leaseUntil" < NOW())
      ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING "id"`
  return rows[0] ? { id: rows[0].id, leaseToken } : null
}

export async function commitCreditTask(
  id: string,
  leaseToken: string,
  status: 'succeeded' | 'failed' | 'reconcile_required',
  lastErrorCode?: string | null,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "RechargeCreditTask"
    SET
      "status" = ${status},
      "completedAt" = CASE WHEN ${status} IN ('succeeded', 'reconcile_required') THEN NOW() ELSE NULL END,
      "leaseToken" = NULL,
      "leaseUntil" = NULL,
      "lastErrorCode" = ${lastErrorCode ?? null},
      "nextAttemptAt" = CASE
        WHEN ${status} = 'failed' THEN NOW() + (LEAST("attempts", 8) * interval '2 seconds')
        ELSE "nextAttemptAt"
      END
    WHERE "id" = ${id}::uuid
      AND "leaseToken" = ${leaseToken}::uuid
    RETURNING "id"`
  return rows.length === 1
}

export async function expireLeaseForTests(kind: 'event' | 'creditTask', id: string) {
  if (kind === 'event') {
    await prisma.paymentEvent.update({
      where: { id },
      data: { leaseUntil: new Date(Date.now() - 1000) },
    })
    return
  }
  await prisma.rechargeCreditTask.update({
    where: { id },
    data: { leaseUntil: new Date(Date.now() - 1000) },
  })
}
