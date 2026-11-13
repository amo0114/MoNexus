import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { HttpError, badRequest } from '../../lib/httpError.js'

export function governanceConflict(
  code:
    | 'STATE_CONFLICT'
    | 'APPLICATION_VERSION_CHANGED'
    | 'REFUND_SOURCE_INSUFFICIENT'
    | 'LEGACY_SOURCE_UNPROVEN'
    | 'RECONCILIATION_REQUIRED'
    | 'IDEMPOTENCY_KEY_REUSED'
    | 'EXPORT_LIMIT_EXCEEDED',
  message: string,
) {
  return new HttpError(409, code, message)
}
export const reasonInput = z
  .object({
    reasonCode: z.string().trim().min(1).max(80),
    note: z.string().trim().min(1).max(1000),
  })
  .strict()
export const requestKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9:._-]+$/)
export function parseRequestKey(value: unknown): string {
  return requestKey.parse(value)
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    )
  return value
}
export function requestHash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}
export async function commandInTx<T>(
  tx: Prisma.TransactionClient,
  actorUserId: number,
  scope: string,
  key: string,
  input: unknown,
  execute: () => Promise<T>,
): Promise<T> {
  const id = `${actorUserId}:${key}`
  const hash = requestHash({ scope, input })
  // The receipt and side effects are committed together; failed commands leave no success receipt.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`governance-command:${id}`}, 0))`
  const prior = await tx.adminCommandReceipt.findUnique({ where: { id } })
  if (prior) {
    if (prior.scope !== scope || prior.requestHash !== hash)
      throw governanceConflict('IDEMPOTENCY_KEY_REUSED', '幂等键已经用于另一项操作')
    const replay = prior.resultSafe as T
    return replay && typeof replay === 'object' && 'replayed' in replay
      ? { ...replay, replayed: true }
      : replay
  }
  const result = await execute()
  await tx.adminCommandReceipt.create({
    data: {
      id,
      actorUserId,
      scope,
      requestHash: hash,
      resultSafe: JSON.parse(JSON.stringify(result)),
    },
  })
  return result
}
export async function writeGovernanceAudit(
  tx: Prisma.TransactionClient,
  actor: number,
  actionCode: string,
  targetType: string,
  targetId: number | null,
  detailSafe: Prisma.InputJsonObject,
) {
  const labels: Record<string, string> = {
    'account.ban.created': '封禁用户',
    'account.ban.released': '解封用户',
    'merchant.approve': '审核通过商家',
    'merchant.reject': '拒绝商家入驻',
    'merchant.suspend': '停用商家',
    'merchant.restore': '恢复商家',
  }
  await tx.adminLog.create({
    data: {
      adminUserId: actor,
      action: labels[actionCode] ?? actionCode,
      detail:
        actionCode === 'merchant.reject'
          ? `拒绝原因: ${detailSafe.note}`
          : typeof detailSafe.reason === 'string'
            ? detailSafe.reason
            : typeof detailSafe.note === 'string'
              ? detailSafe.note
              : null,
      actionCode,
      targetType,
      targetId,
      detailSchemaVersion: 1,
      detailSafe,
    },
  })
}
export const cursorQuery = z.object({
  cursor: z.string().max(2048).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export function decodeCursor(
  value: string | undefined,
  scope: string,
  idKind?: 'integer' | 'uuid',
): { time: Date; id: string | number } | null {
  if (!value) return null
  try {
    const p = JSON.parse(Buffer.from(value, 'base64url').toString())
    if (
      (idKind === 'integer' && typeof p.id !== 'number') ||
      (idKind === 'uuid' && typeof p.id !== 'string') ||
      p.scope !== scope ||
      !['number', 'string'].includes(typeof p.id) ||
      (typeof p.id === 'number'
        ? !Number.isSafeInteger(p.id) || p.id <= 0
        : !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.id)) ||
      !p.time ||
      !Number.isFinite(new Date(p.time).getTime())
    )
      throw Error()
    return { id: p.id, time: new Date(p.time) }
  } catch {
    throw badRequest('分页游标无效或筛选已经变化')
  }
}
export function cursorPage<T extends { id: number | string; createdAt: Date }>(
  rows: T[],
  pageSize: number,
  scope: string,
) {
  const hasNextPage = rows.length > pageSize
  const items = rows.slice(0, pageSize)
  const tail = items.at(-1)
  return {
    items,
    pageInfo: {
      hasNextPage,
      nextCursor:
        hasNextPage && tail
          ? Buffer.from(
              JSON.stringify({ scope, id: tail.id, time: tail.createdAt.toISOString() }),
            ).toString('base64url')
          : null,
    },
    asOf: new Date().toISOString(),
  }
}
