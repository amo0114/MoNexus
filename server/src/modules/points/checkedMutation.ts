import { Prisma } from '@prisma/client'
import {
  badRequest,
  HttpError,
  notFound,
  pointBalanceConflict,
  pointBalanceHardCap,
  pointInsufficient,
} from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'

/** Frozen PointAccount total: balance + frozenBalance must stay within this cap. */
export const POINT_ACCOUNT_HARD_CAP = 2_000_000_000

/** Prisma Int column upper bound (PostgreSQL INTEGER). */
const PRISMA_INT_MAX = 2_147_483_647

export type PointMutationClient = Prisma.TransactionClient | typeof prisma

export type PointAccountBalances = {
  balance: number
  frozenBalance: number
}

type UpdatedRow = {
  balance: number | bigint
  frozenBalance: number | bigint
}

type UpdatedSandboxRow = {
  sandboxBalance: number | bigint
}

export function assertPositivePointAmount(amount: number): number {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > PRISMA_INT_MAX) {
    throw badRequest('积分数量不合法')
  }
  return amount
}

function asStoredInt(value: number | bigint): number {
  const n = typeof value === 'bigint' ? Number(value) : value
  if (!Number.isSafeInteger(n)) {
    throw pointBalanceConflict('积分账户数据异常，请联系管理员')
  }
  return n
}

function errorPayload(error: unknown): { code: string; pgCode: string; text: string } {
  const message = error instanceof Error ? error.message : String(error)
  const rec = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
  const code = rec.code != null ? String(rec.code) : ''
  const meta = rec.meta && typeof rec.meta === 'object' ? rec.meta as Record<string, unknown> : {}
  const pgCode = meta.code != null ? String(meta.code) : ''
  const text = [message, JSON.stringify(meta)].join(' ')
  return { code, pgCode, text }
}

function isCheckConstraintViolation(error: unknown): boolean {
  const { code, pgCode, text } = errorPayload(error)
  if (code === 'P2004' || code === '23514' || pgCode === '23514') return true
  return /23514/.test(text) || /check constraint/i.test(text)
}

/**
 * Map a PointAccount CHECK failure to a ledger HttpError. Race/0-row updates
 * stay in the diagnose helpers as POINT_BALANCE_CONFLICT.
 */
export function classifyPointAccountWriteError(error: unknown): HttpError | null {
  if (error instanceof HttpError) return error
  if (!isCheckConstraintViolation(error)) return null
  const { text } = errorPayload(error)
  if (
    /balance|frozen/i.test(text)
    && />=\s*0|negative|non.?neg/i.test(text)
    && !/hard.?cap|2000000000|2_000_000_000/i.test(text)
  ) {
    return pointInsufficient()
  }
  return pointBalanceHardCap()
}

export function mapPointAccountWriteError(error: unknown): never {
  const mapped = classifyPointAccountWriteError(error)
  if (mapped) throw mapped
  throw error
}

async function loadAccountOrThrow(client: PointMutationClient, userId: number) {
  const account = await client.pointAccount.findUnique({ where: { userId } })
  if (!account) throw notFound('积分账户不存在')
  return account
}

async function runConditionalUpdate(
  client: PointMutationClient,
  query: Promise<UpdatedRow[]>,
): Promise<PointAccountBalances | null> {
  try {
    const rows = await query
    if (rows.length === 0) return null
    return {
      balance: asStoredInt(rows[0].balance),
      frozenBalance: asStoredInt(rows[0].frozenBalance),
    }
  } catch (error) {
    mapPointAccountWriteError(error)
  }
}

async function diagnoseCreditFailure(
  client: PointMutationClient,
  userId: number,
  amount: number,
): Promise<never> {
  const account = await loadAccountOrThrow(client, userId)
  if (account.balance < 0 || account.frozenBalance < 0) {
    throw pointBalanceConflict('积分账户数据异常，请联系管理员')
  }
  const total = BigInt(account.balance) + BigInt(account.frozenBalance)
  if (total + BigInt(amount) > BigInt(POINT_ACCOUNT_HARD_CAP)) {
    throw pointBalanceHardCap()
  }
  throw pointBalanceConflict('积分入账失败，请重试')
}

async function diagnoseSpendFailure(
  client: PointMutationClient,
  userId: number,
  amount: number,
  conflictMessage: string,
): Promise<never> {
  const account = await loadAccountOrThrow(client, userId)
  if (account.balance < amount) throw pointInsufficient()
  throw pointBalanceConflict(conflictMessage)
}

async function diagnoseFrozenFailure(
  client: PointMutationClient,
  userId: number,
  amount: number,
): Promise<never> {
  await loadAccountOrThrow(client, userId)
  throw pointBalanceConflict('订单冻结积分状态异常，请联系管理员')
}

/** Credit available balance. Concurrent credits cannot both pass the cap predicate. */
export async function creditAvailablePoints(
  client: PointMutationClient,
  userId: number,
  amount: number,
): Promise<PointAccountBalances> {
  assertPositivePointAmount(amount)
  const updated = await runConditionalUpdate(
    client,
    client.$queryRaw<UpdatedRow[]>`
      UPDATE "PointAccount"
      SET "balance" = "balance" + ${amount}
      WHERE "userId" = ${userId}
        AND "balance" >= 0
        AND "frozenBalance" >= 0
        AND ("balance"::bigint + "frozenBalance"::bigint + ${BigInt(amount)})
          <= ${BigInt(POINT_ACCOUNT_HARD_CAP)}
      RETURNING "balance", "frozenBalance"`,
  )
  if (!updated) return diagnoseCreditFailure(client, userId, amount)
  return updated
}

/** Credit the isolated administrator sandbox bucket. It is never spendable. */
export async function creditSandboxPoints(
  client: PointMutationClient,
  userId: number,
  amount: number,
): Promise<{ sandboxBalance: number }> {
  assertPositivePointAmount(amount)
  let rows: UpdatedSandboxRow[]
  try {
    rows = await client.$queryRaw<UpdatedSandboxRow[]>`
      UPDATE "PointAccount"
      SET "sandboxBalance" = "sandboxBalance" + ${amount}
      WHERE "userId" = ${userId}
        AND "sandboxBalance" >= 0
        AND ("sandboxBalance"::bigint + ${BigInt(amount)}) <= ${BigInt(POINT_ACCOUNT_HARD_CAP)}
      RETURNING "sandboxBalance"`
  } catch (error) {
    mapPointAccountWriteError(error)
  }
  if (rows.length === 1) {
    return { sandboxBalance: asStoredInt(rows[0].sandboxBalance) }
  }
  const account = await loadAccountOrThrow(client, userId)
  if (account.sandboxBalance < 0) {
    throw pointBalanceConflict('沙箱积分账户数据异常，请联系管理员')
  }
  if (BigInt(account.sandboxBalance) + BigInt(amount) > BigInt(POINT_ACCOUNT_HARD_CAP)) {
    throw pointBalanceHardCap('沙箱积分余额已达到上限')
  }
  throw pointBalanceConflict('沙箱积分入账失败，请重试')
}

/** Debit available balance. Rejects when available points are insufficient. */
export async function debitAvailablePoints(
  client: PointMutationClient,
  userId: number,
  amount: number,
): Promise<PointAccountBalances> {
  assertPositivePointAmount(amount)
  const updated = await runConditionalUpdate(
    client,
    client.$queryRaw<UpdatedRow[]>`
      UPDATE "PointAccount"
      SET "balance" = "balance" - ${amount}
      WHERE "userId" = ${userId}
        AND "balance" >= ${amount}
        AND "frozenBalance" >= 0
      RETURNING "balance", "frozenBalance"`,
  )
  if (!updated) {
    return diagnoseSpendFailure(client, userId, amount, '积分扣减失败，请重试')
  }
  return updated
}

/**
 * Move available points into frozenBalance. Total is unchanged, so the hard
 * cap still holds if it already did; still reject Int overflow on frozen.
 */
export async function holdAvailablePoints(
  client: PointMutationClient,
  userId: number,
  amount: number,
): Promise<PointAccountBalances> {
  assertPositivePointAmount(amount)
  const updated = await runConditionalUpdate(
    client,
    client.$queryRaw<UpdatedRow[]>`
      UPDATE "PointAccount"
      SET "balance" = "balance" - ${amount},
          "frozenBalance" = "frozenBalance" + ${amount}
      WHERE "userId" = ${userId}
        AND "balance" >= ${amount}
        AND "frozenBalance" >= 0
        AND ("frozenBalance"::bigint + ${BigInt(amount)}) <= ${BigInt(PRISMA_INT_MAX)}
      RETURNING "balance", "frozenBalance"`,
  )
  if (!updated) {
    return diagnoseSpendFailure(client, userId, amount, '积分冻结失败，请重试')
  }
  return updated
}

/** Consume a hold: frozenBalance decreases, available balance is unchanged. */
export async function consumeHeldPoints(
  client: PointMutationClient,
  userId: number,
  amount: number,
): Promise<PointAccountBalances> {
  assertPositivePointAmount(amount)
  const updated = await runConditionalUpdate(
    client,
    client.$queryRaw<UpdatedRow[]>`
      UPDATE "PointAccount"
      SET "frozenBalance" = "frozenBalance" - ${amount}
      WHERE "userId" = ${userId}
        AND "frozenBalance" >= ${amount}
      RETURNING "balance", "frozenBalance"`,
  )
  if (!updated) return diagnoseFrozenFailure(client, userId, amount)
  return updated
}

/** Release a hold back to available balance. Total is unchanged, so this must
 *  not refuse pre-existing over-cap rows. */
export async function releaseHeldPoints(
  client: PointMutationClient,
  userId: number,
  amount: number,
): Promise<PointAccountBalances> {
  assertPositivePointAmount(amount)
  const updated = await runConditionalUpdate(
    client,
    client.$queryRaw<UpdatedRow[]>`
      UPDATE "PointAccount"
      SET "frozenBalance" = "frozenBalance" - ${amount},
          "balance" = "balance" + ${amount}
      WHERE "userId" = ${userId}
        AND "frozenBalance" >= ${amount}
        AND "balance" >= 0
        AND ("balance"::bigint + ${BigInt(amount)}) <= ${BigInt(PRISMA_INT_MAX)}
      RETURNING "balance", "frozenBalance"`,
  )
  if (!updated) return diagnoseFrozenFailure(client, userId, amount)
  return updated
}
