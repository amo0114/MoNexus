import { createHmac, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { HttpError } from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'
import type { RechargeIdempotencyScope } from './types.js'

const PROCESSING_TTL_MS = 15 * 60 * 1000
export const RECHARGE_IDEMPOTENCY_COMPLETED_RETENTION_MS = 24 * 60 * 60 * 1000

export type RechargeIdempotencyClaim =
  | { kind: 'claimed'; claimToken: string; takeover: boolean }
  | { kind: 'replay'; resultType: string; resultId: string }
  | { kind: 'in_flight' }

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

function keyMismatch(): HttpError {
  return new HttpError(409, 'CONFLICT', '该幂等键已用于内容不同的充值请求')
}

export function rechargeIdempotencyInFlight(): HttpError {
  return new HttpError(409, 'CONFLICT', '相同的充值请求正在处理中，请稍后查看结果')
}

export function computeRechargeRequestDigest(canonical: unknown): string {
  return createHmac('sha256', config.jwtSecret).update(JSON.stringify(canonical)).digest('hex')
}

export async function claimRechargeIdempotency(input: {
  userId: number
  scope: RechargeIdempotencyScope
  key: string
  requestDigest: string
  resultType: string
}): Promise<RechargeIdempotencyClaim> {
  const now = new Date()
  const claimToken = randomUUID()
  try {
    await prisma.rechargeIdempotencyRecord.create({
      data: {
        userId: input.userId,
        scope: input.scope,
        key: input.key,
        requestDigest: input.requestDigest,
        status: 'processing',
        claimToken,
        resultType: input.resultType,
        expiresAt: new Date(now.getTime() + PROCESSING_TTL_MS),
      },
    })
    return { kind: 'claimed', claimToken, takeover: false }
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
  }

  const existing = await prisma.rechargeIdempotencyRecord.findUnique({
    where: {
      userId_scope_key: { userId: input.userId, scope: input.scope, key: input.key },
    },
  })
  if (!existing) return claimRechargeIdempotency(input)
  if (existing.requestDigest !== input.requestDigest) throw keyMismatch()

  if (existing.status === 'completed' && existing.resultId) {
    if (existing.expiresAt <= now) {
      throw new HttpError(409, 'IDEMPOTENCY_KEY_EXPIRED', '幂等键已过期，请确认结果后重新发起')
    }
    return { kind: 'replay', resultType: existing.resultType, resultId: existing.resultId }
  }

  if (existing.status === 'processing' && existing.expiresAt <= now) {
    const takeover = await prisma.rechargeIdempotencyRecord.updateMany({
      where: {
        id: existing.id,
        status: 'processing',
        claimToken: existing.claimToken,
        expiresAt: existing.expiresAt,
        requestDigest: input.requestDigest,
      },
      data: {
        claimToken,
        expiresAt: new Date(now.getTime() + PROCESSING_TTL_MS),
      },
    })
    if (takeover.count === 1) return { kind: 'claimed', claimToken, takeover: true }
  }

  return { kind: 'in_flight' }
}

export async function completeRechargeIdempotencyClaim(
  tx: Prisma.TransactionClient | typeof prisma,
  input: {
    userId: number
    scope: RechargeIdempotencyScope
    key: string
    claimToken: string
    resultId: string
  },
) {
  const completed = await tx.rechargeIdempotencyRecord.updateMany({
    where: {
      userId: input.userId,
      scope: input.scope,
      key: input.key,
      status: 'processing',
      claimToken: input.claimToken,
    },
    data: {
      status: 'completed',
      resultId: input.resultId,
      expiresAt: new Date(Date.now() + RECHARGE_IDEMPOTENCY_COMPLETED_RETENTION_MS),
    },
  })
  if (completed.count !== 1) throw rechargeIdempotencyInFlight()
}

export async function releaseRechargeIdempotencyClaim(input: {
  userId: number
  scope: RechargeIdempotencyScope
  key: string
  claimToken: string
}) {
  try {
    await prisma.rechargeIdempotencyRecord.deleteMany({
      where: {
        userId: input.userId,
        scope: input.scope,
        key: input.key,
        claimToken: input.claimToken,
        status: 'processing',
      },
    })
  } catch {
    // TTL takeover reclaims leaked processing rows.
  }
}
