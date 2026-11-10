import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { conflict, HttpError, notFound, pointBalanceConflict } from '../../lib/httpError.js'
import {
  assertPositivePointAmount,
  consumeHeldPoints,
  creditAvailablePoints,
  creditSandboxPoints,
  debitAvailablePoints,
  holdAvailablePoints,
  releaseHeldPoints,
  type PointAccountBalances,
} from './balance.js'
import { applyMovements, availableInLots, outstandingAllocations, pickLots, type Movement } from './allocation.js'
import type { LotFilter, WalletContext, WalletOperationKind, WalletOriginKind, WalletResult } from './types.js'

type Tx = Prisma.TransactionClient

const DEFAULT_LOG_TYPE: Partial<Record<WalletOperationKind, string>> = {
  credit: 'in',
  spend: 'out',
  reserve: 'hold',
  capture: 'out',
  reversal: 'out',
  release: 'release',
  refund: 'refund',
  legacy_refund: 'refund',
  sandbox_credit: 'sandbox_in',
}

function requestHash(kind: WalletOperationKind, ctx: WalletContext, params: Record<string, unknown>): string {
  const body = JSON.stringify({
    kind,
    userId: ctx.userId,
    source: [ctx.source.kind, String(ctx.source.id)],
    reasonCode: ctx.reasonCode,
    params,
  })
  return createHash('sha256').update(body).digest('hex')
}

type AccountRow = { balance: number; frozenBalance: number; walletInitializedAt: Date | null }

/**
 * Lock the account row; all lot writes for this user happen under this lock.
 * Accounts that predate wallet (or rows written directly, e.g. seed/test
 * fixtures before first use) get their unexplained balance recorded once as
 * legacy_unknown. After initialization a mismatch is an error, never resynced.
 */
async function lockAccount(tx: Tx, userId: number): Promise<AccountRow> {
  const rows = await tx.$queryRaw<AccountRow[]>`
    SELECT "balance", "frozenBalance", "walletInitializedAt"
    FROM "PointAccount" WHERE "userId" = ${userId} FOR UPDATE`
  const row = rows[0]
  if (!row) throw notFound('积分账户不存在')
  if (!row.walletInitializedAt) await initializeLegacyBalance(tx, userId, row)
  return row
}

async function initializeLegacyBalance(tx: Tx, userId: number, row: AccountRow) {
  const sums = await tx.pointLot.aggregate({
    where: { userId },
    _sum: { availablePoints: true, frozenPoints: true },
  })
  const gapAvailable = row.balance - (sums._sum.availablePoints ?? 0)
  const gapFrozen = row.frozenBalance - (sums._sum.frozenPoints ?? 0)
  if (gapAvailable < 0 || gapFrozen < 0) throw pointBalanceConflict('积分来源记录与余额不一致，请联系管理员')
  if (gapAvailable + gapFrozen > 0) {
    const operationKey = `wallet-init:${userId}`
    const op = await tx.walletOperation.create({
      data: {
        operationKey,
        kind: 'legacy_init',
        userId,
        amount: gapAvailable + gapFrozen,
        requestHash: createHash('sha256').update(`${operationKey}:${row.balance}:${row.frozenBalance}`).digest('hex'),
        sourceKind: 'migration',
        sourceId: 'wallet-v1',
        reasonCode: 'legacy_init',
        balanceAfter: row.balance,
        frozenAfter: row.frozenBalance,
      },
    })
    const lot = await tx.pointLot.create({
      data: {
        userId,
        originKind: 'legacy_unknown',
        sourceOperationId: op.id,
        issuedPoints: gapAvailable + gapFrozen,
        availablePoints: gapAvailable,
        frozenPoints: gapFrozen,
      },
    })
    await tx.walletAllocation.create({
      data: { operationId: op.id, lotId: lot.id, availableDelta: gapAvailable, frozenDelta: gapFrozen, consumedDelta: 0 },
    })
  }
  await tx.pointAccount.update({ where: { userId }, data: { walletInitializedAt: new Date() } })
}

async function findReplay(tx: Tx, operationKey: string, hash: string): Promise<WalletResult | null> {
  const existing = await tx.walletOperation.findUnique({ where: { operationKey } })
  if (!existing) return null
  if (existing.requestHash !== hash) {
    throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', '积分操作与已执行的记录参数不一致')
  }
  return {
    operationId: existing.id,
    pointLogId: existing.pointLogId,
    amount: existing.amount,
    balance: existing.balanceAfter,
    frozenBalance: existing.frozenAfter,
    replayed: true,
  }
}

async function record(
  tx: Tx,
  ctx: WalletContext,
  input: {
    kind: WalletOperationKind
    hash: string
    amount: number
    balances: PointAccountBalances
    logBalanceAfter?: number
    logAmount?: number
    parentOperationId?: number
    movements?: Movement[]
    newLot?: { origin: WalletOriginKind; policyVersion?: string | null }
  },
): Promise<WalletResult> {
  const log = await tx.pointLog.create({
    data: {
      userId: ctx.userId,
      type: ctx.log.type ?? DEFAULT_LOG_TYPE[input.kind] ?? input.kind,
      amount: input.logAmount ?? input.amount,
      balanceAfter: input.logBalanceAfter ?? input.balances.balance,
      reason: ctx.log.reason,
      orderId: ctx.log.orderId ?? null,
      growthEligible: ctx.log.growthEligible ?? false,
    },
    select: { id: true },
  })
  const op = await tx.walletOperation.create({
    data: {
      operationKey: ctx.operationKey,
      kind: input.kind,
      userId: ctx.userId,
      amount: input.amount,
      requestHash: input.hash,
      sourceKind: ctx.source.kind,
      sourceId: String(ctx.source.id),
      reasonCode: ctx.reasonCode,
      actorUserId: ctx.actorUserId ?? null,
      parentOperationId: input.parentOperationId ?? null,
      balanceAfter: input.balances.balance,
      frozenAfter: input.balances.frozenBalance,
      pointLogId: log.id,
    },
    select: { id: true },
  })
  const movements = [...(input.movements ?? [])]
  if (input.newLot && input.amount > 0) {
    const lot = await tx.pointLot.create({
      data: {
        userId: ctx.userId,
        originKind: input.newLot.origin,
        sourceOperationId: op.id,
        issuedPoints: input.amount,
        availablePoints: input.amount,
        policyVersion: input.newLot.policyVersion ?? null,
      },
      select: { id: true },
    })
    // The new lot is created with its balance; only the allocation row is recorded.
    await tx.walletAllocation.create({
      data: { operationId: op.id, lotId: lot.id, availableDelta: input.amount, frozenDelta: 0, consumedDelta: 0 },
    })
  }
  if (movements.length > 0) {
    await applyMovements(tx, movements)
    await tx.walletAllocation.createMany({
      data: movements.map(m => ({
        operationId: op.id,
        lotId: m.lotId,
        availableDelta: m.availableDelta,
        frozenDelta: m.frozenDelta,
        consumedDelta: m.consumedDelta,
        parentAllocationId: m.parentAllocationId ?? null,
      })),
    })
  }
  return {
    operationId: op.id,
    pointLogId: log.id,
    amount: input.amount,
    balance: input.balances.balance,
    frozenBalance: input.balances.frozenBalance,
    replayed: false,
  }
}

async function loadParent(tx: Tx, ctx: WalletContext, key: string, kinds: WalletOperationKind[]) {
  const parent = await tx.walletOperation.findUnique({ where: { operationKey: key } })
  if (!parent) return null
  // A reference to another user's or another kind of operation is never followed.
  if (parent.userId !== ctx.userId || !kinds.includes(parent.kind as WalletOperationKind)) {
    throw conflict('积分原始记录不匹配')
  }
  return parent
}

/** New points from a source. amount 0 records the log only (e.g. a zero-configured reward). */
export async function creditInTx(
  tx: Tx,
  ctx: WalletContext,
  input: { amount: number; origin: WalletOriginKind; policyVersion?: string | null },
): Promise<WalletResult> {
  if (input.amount !== 0) assertPositivePointAmount(input.amount)
  const account = await lockAccount(tx, ctx.userId)
  const hash = requestHash('credit', ctx, { amount: input.amount, origin: input.origin })
  const replay = await findReplay(tx, ctx.operationKey, hash)
  if (replay) return replay
  const balances = input.amount > 0 ? await creditAvailablePoints(tx, ctx.userId, input.amount) : account
  return record(tx, ctx, { kind: 'credit', hash, amount: input.amount, balances, newLot: input })
}

/**
 * Consume available points (available -> consumed). With allowPartial the
 * command takes what the filtered lots hold and returns null when nothing.
 */
export async function spendInTx(
  tx: Tx,
  ctx: WalletContext,
  input: { amount: number } & LotFilter & { allowPartial?: boolean },
): Promise<WalletResult | null> {
  assertPositivePointAmount(input.amount)
  const account = await lockAccount(tx, ctx.userId)
  const hash = requestHash('spend', ctx, { amount: input.amount, origins: input.origins ?? null, partial: !!input.allowPartial })
  const replay = await findReplay(tx, ctx.operationKey, hash)
  if (replay) return replay
  let amount = input.amount
  if (input.allowPartial) {
    amount = Math.min(amount, account.balance, await availableInLots(tx, ctx.userId, input))
    if (amount === 0) return null
  }
  const balances = await debitAvailablePoints(tx, ctx.userId, amount)
  const picks = await pickLots(tx, ctx.userId, amount, 'availablePoints', input)
  return record(tx, ctx, {
    kind: 'spend',
    hash,
    amount,
    balances,
    movements: picks.map(p => ({ lotId: p.lotId, availableDelta: -p.points, frozenDelta: 0, consumedDelta: p.points })),
  })
}

/** Freeze available points (available -> frozen) on fixed lots for a later capture/release. */
export async function reserveInTx(
  tx: Tx,
  ctx: WalletContext,
  input: { amount: number } & LotFilter,
): Promise<WalletResult> {
  assertPositivePointAmount(input.amount)
  await lockAccount(tx, ctx.userId)
  const hash = requestHash('reserve', ctx, { amount: input.amount, origins: input.origins ?? null, only: input.onlySourceOperationIds ?? null })
  const replay = await findReplay(tx, ctx.operationKey, hash)
  if (replay) return replay
  const balances = await holdAvailablePoints(tx, ctx.userId, input.amount)
  const picks = await pickLots(tx, ctx.userId, input.amount, 'availablePoints', input)
  return record(tx, ctx, {
    kind: 'reserve',
    hash,
    amount: input.amount,
    balances,
    movements: picks.map(p => ({ lotId: p.lotId, availableDelta: -p.points, frozenDelta: p.points, consumedDelta: 0 })),
  })
}

/**
 * Settle the outstanding part of a reserve, on the same lots it froze.
 * `legacyAmount` covers freezes made before wallet existed: they are taken from
 * the account's legacy_init lot only, never from a newer reservation.
 */
async function settleReserve(
  tx: Tx,
  ctx: WalletContext,
  kind: 'capture' | 'reversal' | 'release',
  input: { reserveKey: string; legacyAmount?: number },
): Promise<WalletResult> {
  await lockAccount(tx, ctx.userId)
  const hash = requestHash(kind, ctx, { reserveKey: input.reserveKey, legacyAmount: input.legacyAmount ?? null })
  const replay = await findReplay(tx, ctx.operationKey, hash)
  if (replay) return replay
  const toAvailable = kind === 'release'
  const reserve = await loadParent(tx, ctx, input.reserveKey, ['reserve'])

  let parts: Array<{ lotId: number; points: number; parentAllocationId: number | null }>
  if (reserve) {
    parts = (await outstandingAllocations(tx, reserve.id, 'frozenDelta'))
      .map(a => ({ lotId: a.lotId, points: a.points, parentAllocationId: a.allocationId }))
  } else if (input.legacyAmount != null) {
    assertPositivePointAmount(input.legacyAmount)
    parts = (await pickLots(tx, ctx.userId, input.legacyAmount, 'frozenPoints', { legacyOnly: true }))
      .map(p => ({ ...p, parentAllocationId: null }))
  } else {
    throw conflict('找不到对应的冻结积分记录')
  }
  const amount = parts.reduce((sum, p) => sum + p.points, 0)
  if (amount <= 0) throw conflict('冻结积分已处理')
  const balances = toAvailable
    ? await releaseHeldPoints(tx, ctx.userId, amount)
    : await consumeHeldPoints(tx, ctx.userId, amount)
  return record(tx, ctx, {
    kind,
    hash,
    amount,
    balances,
    parentOperationId: reserve?.id,
    movements: parts.map(p => ({
      lotId: p.lotId,
      availableDelta: toAvailable ? p.points : 0,
      frozenDelta: -p.points,
      consumedDelta: toAvailable ? 0 : p.points,
      parentAllocationId: p.parentAllocationId,
    })),
  })
}

export function captureInTx(tx: Tx, ctx: WalletContext, input: { reserveKey: string; legacyAmount?: number }) {
  return settleReserve(tx, ctx, 'capture', input)
}

/** Points withdrawn because the funding payment was refunded/charged back (not a purchase). */
export function reverseReservedInTx(tx: Tx, ctx: WalletContext, input: { reserveKey: string; legacyAmount?: number }) {
  return settleReserve(tx, ctx, 'reversal', input)
}

export function releaseInTx(tx: Tx, ctx: WalletContext, input: { reserveKey: string; legacyAmount?: number }) {
  return settleReserve(tx, ctx, 'release', input)
}

/**
 * Return consumed points to the lots they came from. Rewards stay rewards and
 * unknown stays unknown. `amount` defaults to everything still unreturned.
 *
 * `legacyAmount` is the restricted path for consumption that predates wallet
 * (no original operation exists): the caller has proven the old debit and its
 * refund eligibility; the returned points become a new legacy_unknown lot. The
 * shared operationKey (one refund per order/charge) bounds it to once.
 */
export async function refundInTx(
  tx: Tx,
  ctx: WalletContext,
  input: { originalKey: string; amount?: number; legacyAmount?: number },
): Promise<WalletResult> {
  if (input.amount != null) assertPositivePointAmount(input.amount)
  await lockAccount(tx, ctx.userId)
  const hash = requestHash('refund', ctx, {
    originalKey: input.originalKey,
    amount: input.amount ?? null,
    legacyAmount: input.legacyAmount ?? null,
  })
  const replay = await findReplay(tx, ctx.operationKey, hash)
  if (replay) return replay
  const original = await loadParent(tx, ctx, input.originalKey, ['spend', 'capture', 'reversal'])

  if (!original) {
    if (input.legacyAmount == null) throw conflict('找不到原扣款记录，不能退还')
    assertPositivePointAmount(input.legacyAmount)
    const balances = await creditAvailablePoints(tx, ctx.userId, input.legacyAmount)
    return record(tx, ctx, {
      kind: 'legacy_refund',
      hash,
      amount: input.legacyAmount,
      balances,
      newLot: { origin: 'legacy_unknown' },
    })
  }

  const outstanding = await outstandingAllocations(tx, original.id, 'consumedDelta')
  const total = outstanding.reduce((sum, a) => sum + a.points, 0)
  const amount = input.amount ?? total
  if (amount <= 0 || amount > total) throw conflict('退还积分超过原扣款可退额度')
  const movements: Movement[] = []
  let left = amount
  for (const a of outstanding) {
    if (left === 0) break
    const take = Math.min(left, a.points)
    movements.push({ lotId: a.lotId, availableDelta: take, frozenDelta: 0, consumedDelta: -take, parentAllocationId: a.allocationId })
    left -= take
  }
  const balances = await creditAvailablePoints(tx, ctx.userId, amount)
  return record(tx, ctx, { kind: 'refund', hash, amount, balances, parentOperationId: original.id, movements })
}

/**
 * Ledger row without a balance change. Only for the pre-frozenBalance order
 * compatibility path, whose "hold" never reserved anything to give back.
 */
export async function noteInTx(tx: Tx, ctx: WalletContext, input: { logAmount: number }): Promise<WalletResult> {
  const account = await lockAccount(tx, ctx.userId)
  const hash = requestHash('note', ctx, { logAmount: input.logAmount })
  const replay = await findReplay(tx, ctx.operationKey, hash)
  if (replay) return replay
  return record(tx, ctx, { kind: 'note', hash, amount: 0, logAmount: input.logAmount, balances: account })
}

/** Administrator sandbox bucket: isolated from real lots and never spendable. */
export async function creditSandboxInTx(tx: Tx, ctx: WalletContext, input: { amount: number }): Promise<WalletResult> {
  assertPositivePointAmount(input.amount)
  const account = await lockAccount(tx, ctx.userId)
  const hash = requestHash('sandbox_credit', ctx, { amount: input.amount })
  const replay = await findReplay(tx, ctx.operationKey, hash)
  if (replay) return replay
  const { sandboxBalance } = await creditSandboxPoints(tx, ctx.userId, input.amount)
  return record(tx, ctx, {
    kind: 'sandbox_credit',
    hash,
    amount: input.amount,
    balances: account,
    logBalanceAfter: sandboxBalance,
  })
}

/** Create the account row if missing (merchant payees may never have had one). */
export async function ensureAccountInTx(tx: Tx, userId: number) {
  await tx.pointAccount.upsert({
    where: { userId },
    create: { userId, balance: 0, walletInitializedAt: new Date() },
    update: {},
  })
}

/** Lock several accounts in a deterministic order before a multi-account use case. */
export async function lockAccountsInTx(tx: Tx, userIds: number[]) {
  for (const userId of [...new Set(userIds)].sort((a, b) => a - b)) {
    await lockAccount(tx, userId)
  }
}
