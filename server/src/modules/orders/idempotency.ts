import { createHmac, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { HttpError } from '../../lib/httpError.js'
import { config } from '../../config/index.js'

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
  return new HttpError(
    409,
    'CONFLICT',
    '该幂等键已用于内容不同的兑换请求，请先在订单中心确认结果后重试'
  )
}

function inFlight(): HttpError {
  return new HttpError(409, 'CONFLICT', '相同的兑换请求正在处理中，请稍后查看订单')
}

export type IdempotencyFingerprint = {
  productId: number
  expectedPrice?: number
  purchaseFormVersion?: string
  formAnswers?: Record<string, string>
}

/**
 * 请求指纹：同一 key 只能对应一份提交内容。答案 A 超时后改成答案 B 重试，
 * 必须 409 提示检查订单，而不是静默重放 A 的订单（人工履约场景下
 * "买家以为提交了 B、商家收到 A"比重复扣款更危险）。
 * 用 HMAC 而非明文/裸哈希存储，低熵答案无法通过本表被枚举还原。
 */
export function computeRequestDigest(fingerprint: IdempotencyFingerprint): string {
  const answers = fingerprint.formAnswers ?? {}
  const canonicalAnswers = Object.keys(answers)
    .sort()
    .map(key => [key, (answers[key] ?? '').trim()])
    .filter(([, value]) => value !== '')
  const canonical = JSON.stringify({
    productId: fingerprint.productId,
    expectedPrice: fingerprint.expectedPrice ?? null,
    purchaseFormVersion: fingerprint.purchaseFormVersion ?? null,
    answers: canonicalAnswers,
  })
  return createHmac('sha256', config.jwtSecret).update(canonical).digest('hex')
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
 * The claim also pins the full request fingerprint (see computeRequestDigest):
 * the same key arriving with a different product, price, form version or
 * answers is rejected instead of silently replaying an unrelated submission.
 */
export async function claimIdempotencyKey(
  userId: number,
  key: string,
  fingerprint: IdempotencyFingerprint
): Promise<IdempotencyClaim> {
  const now = new Date()
  const claimToken = randomUUID()
  const requestDigest = computeRequestDigest(fingerprint)
  try {
    await prisma.idempotencyRecord.create({
      data: {
        userId,
        key,
        productId: fingerprint.productId,
        requestDigest,
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
  if (!existing) return claimIdempotencyKey(userId, key, fingerprint)

  // P1 遗留记录（迁移为既有行回填 requestDigest = ''）没有 HMAC 指纹，
  // 直接比较摘要会让部署后仍在重放窗口内的旧 key 误判为"内容不同"。
  // 空摘要即哨兵：退回 P1 语义，仅按 productId 校验——商品不同则冲突，
  // 商品相同则照常重放/继续。新记录始终写入非空摘要，不会命中此分支。
  if (existing.requestDigest === '') {
    if (existing.productId !== fingerprint.productId) throw keyMismatch()
  } else if (existing.requestDigest !== requestDigest) {
    throw keyMismatch()
  }

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
