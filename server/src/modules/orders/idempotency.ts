import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { HttpError } from '../../lib/httpError.js'

// processing 记录的孤儿窗口：正常请求几秒内终态化（completed 或删除），
// 超过该窗口仍是 processing 的只可能是进程崩溃残留，允许同 key 重试接管。
const PROCESSING_TTL_MS = 15 * 60 * 1000
// completed 记录的重放保留期：期内同 key 重放返回原订单，期满由 cron 清理。
export const COMPLETED_RETENTION_MS = 24 * 60 * 60 * 1000

export type IdempotencyClaim =
  | { kind: 'claimed'; claimToken: string }
  | { kind: 'replay'; orderId: number }

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

function keyMismatch(): HttpError {
  return new HttpError(409, 'CONFLICT', '该幂等键已用于其他商品的兑换请求，请刷新后重试')
}

function inFlight(): HttpError {
  return new HttpError(409, 'CONFLICT', '相同的兑换请求正在处理中，请稍后查看订单')
}

/**
 * Claim a checkout intent before opening the order transaction. The database
 * unique constraint on (userId, key) is the concurrency backstop; this
 * function only classifies the conflict:
 * - fresh key            -> claimed, caller proceeds to create the order
 * - completed record     -> replay, caller returns the original order
 * - live processing      -> 409, a concurrent submit of the same intent is running
 * - expired processing   -> orphan from a crashed process, taken over in place
 *
 * Every claim (fresh or takeover) carries a new random claimToken lease.
 * complete / release only act when the token still matches, so a holder that
 * stalled past the TTL and lost its lease can neither finish its order nor
 * delete the record of the request that took over.
 *
 * The claim also pins the request fingerprint (productId): the same key
 * arriving with a different product is rejected instead of silently replaying
 * an unrelated order.
 */
export async function claimIdempotencyKey(
  userId: number,
  key: string,
  productId: number
): Promise<IdempotencyClaim> {
  const now = new Date()
  const claimToken = randomUUID()
  try {
    await prisma.idempotencyRecord.create({
      data: {
        userId,
        key,
        productId,
        claimToken,
        status: 'processing',
        expiresAt: new Date(now.getTime() + PROCESSING_TTL_MS),
      },
    })
    return { kind: 'claimed', claimToken }
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
  }

  const existing = await prisma.idempotencyRecord.findUnique({
    where: { userId_key: { userId, key } },
  })
  // The record was deleted between the failed insert and this read (the
  // competing request failed and released its claim). Retrying is safe.
  if (!existing) return claimIdempotencyKey(userId, key, productId)

  if (existing.productId !== productId) throw keyMismatch()

  if (existing.status === 'completed' && existing.orderId != null) {
    return { kind: 'replay', orderId: existing.orderId }
  }

  if (existing.expiresAt <= now) {
    // Conditional update: only one of several waiters becomes the new lease
    // holder, and the token swap revokes the stalled holder's lease.
    const takeover = await prisma.idempotencyRecord.updateMany({
      where: {
        id: existing.id,
        status: 'processing',
        claimToken: existing.claimToken,
        expiresAt: existing.expiresAt,
      },
      data: { claimToken, expiresAt: new Date(now.getTime() + PROCESSING_TTL_MS) },
    })
    if (takeover.count === 1) return { kind: 'claimed', claimToken }
  }

  throw inFlight()
}

/**
 * Mark the claim completed inside the order transaction so that "order exists"
 * and "key is replayable" commit atomically. Throws (rolling the order back)
 * when the lease token no longer matches — the claim was taken over while this
 * request was stalled, and the takeover's order is the one that must win.
 */
export async function completeIdempotencyClaim(
  tx: Prisma.TransactionClient,
  userId: number,
  key: string,
  claimToken: string,
  orderId: number
) {
  const completed = await tx.idempotencyRecord.updateMany({
    where: { userId, key, status: 'processing', claimToken },
    data: {
      status: 'completed',
      orderId,
      expiresAt: new Date(Date.now() + COMPLETED_RETENTION_MS),
    },
  })
  if (completed.count !== 1) throw inFlight()
}

/**
 * Free the key after the order transaction rolled back (insufficient stock,
 * price change, ...) so the user can retry the same intent. Token-scoped: a
 * revoked holder cannot delete the record now owned by the takeover request.
 * Best-effort — a leaked processing record is reclaimed via the TTL anyway.
 */
export async function releaseIdempotencyClaim(userId: number, key: string, claimToken: string) {
  try {
    await prisma.idempotencyRecord.deleteMany({
      where: { userId, key, claimToken, status: 'processing' },
    })
  } catch {
    // 泄漏的 processing 记录会在 TTL 后被接管，这里不再向上抛错。
  }
}

/** Cron helper: drop records whose replay window is over. */
export async function cleanupExpiredIdempotencyRecords(): Promise<number> {
  const result = await prisma.idempotencyRecord.deleteMany({
    where: { status: 'completed', expiresAt: { lt: new Date() } },
  })
  return result.count
}
