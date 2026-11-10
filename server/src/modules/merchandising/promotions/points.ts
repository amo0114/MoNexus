// T-MERCH-BE-004 — Promotion points helper — 最小独占区域
// (SPEC-MERCH-001 §5.4/§7.3/§7.4, D-MERCH-10/11/13, AC-MERCH-010/011/014/015,
// CHK-PROMO-004/005/008/009/011, CHK-SEC-003).
//
// This is the ONLY place in the promotions lane that reads/writes the real
// PointAccount balance and creates PointLog rows for promotion charging and
// refunding. Scope discipline (task T-MERCH-BE-004 "points helper 最小独占区域"):
//   - it never touches Order point debit/refund semantics;
//   - it never touches Settlement;
//   - it never writes a PointLog with an orderId (orderId IS NULL is part of the
//     frozen charge/refund contract in SPEC §5.4);
//   - every mutation is meant to run inside a single interactive `$transaction`
//     together with the campaign state change — a caller that uses these outside
//     a transaction breaks the MERCH-008 invariant.
//
// Concurrency guarantees (AC-MERCH-027 / CHK-PROMO-011):
//   - debit/refund go through wallet so concurrent charges cannot drive the
//     balance negative or past the hard cap, and a refund returns the charged sources;
//   - the campaign side (billing.ts) owns the `chargePointLogId` / `refundPointLogId`
//     UNIQUE links that make duplicate charge/refund impossible at the DB level.
//
// SECURITY: never log or return a balance history; the functions return only the
// point-log id / balance snapshot required by the caller. No secrets here.

import { Prisma } from '@prisma/client'
import { HttpError, notFound } from '../../../lib/httpError.js'
import { prisma } from '../../../lib/prisma.js'
import { refundInTx, spendInTx, type WalletContext } from '../../wallet/index.js'
import { assertSpendingNotRestricted } from '../../points/spendingPolicy.js'

/** 稳定 PointLog reason 模板（§7.3 / §7.4：charge 与 refund 均用固定文案，
 * 不允许审核长文本/内部 reason 进入 PointLog。CHK-SEC-003/004）。 */
export const PROMOTION_CHARGE_POINT_LOG_REASON = '推广活动扣款'
export const PROMOTION_REFUND_POINT_LOG_REASON = '推广活动退款'

/** 任何 DB handle（交互式事务或主 client）。 */
export type Db = typeof prisma | Prisma.TransactionClient

/** 数据库时钟。所有扣退/排期时间判定都锚定 DB now()，实例时钟不参与。 */
export async function dbNow(client: Db): Promise<Date> {
  const rows = await client.$queryRaw<{ now: Date }[]>`SELECT now() AS now`
  return rows[0].now
}

const chargeKey = (campaignId: number) => `promotion:${campaignId}:charge`

function promotionCtx(campaignId: number, userId: number, step: 'charge' | 'refund', reason: string): WalletContext {
  return {
    operationKey: `promotion:${campaignId}:${step}`,
    userId,
    source: { kind: 'promotion_campaign', id: campaignId },
    reasonCode: `promotion_${step}`,
    log: { reason, orderId: null }, // §5.4：charge/refund log 必须 orderId IS NULL
  }
}

/**
 * 条件扣款（§7.3 step 3/4）：余额不足返回 `{ ok: false }`（不扣、不写
 * PointLog、不部分扣款）→ 足额则同事务创建 PointLog(type='out', orderId=null)。
 *
 * 必须在交互式事务内调用；返回的 pointLogId 由调用方 CAS 到 campaign 的
 * `chargePointLogId`（UNIQUE）。
 */
export async function debitPointsForPromotionCharge(
  tx: Prisma.TransactionClient,
  campaignId: number,
  userId: number,
  amount: number,
): Promise<{ ok: true; pointLogId: number; balanceAfter: number } | { ok: false; balance: number }> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`promotion charge amount must be a positive integer, got ${amount}`)
  }
  await assertSpendingNotRestricted(userId, tx)
  let charged
  try {
    charged = await spendInTx(tx, promotionCtx(campaignId, userId, 'charge', PROMOTION_CHARGE_POINT_LOG_REASON), { amount })
  } catch (error) {
    if (error instanceof HttpError && error.code === 'POINT_INSUFFICIENT') {
      const account = await tx.pointAccount.findUnique({ where: { userId }, select: { balance: true } })
      if (!account) throw notFound('积分账户不存在')
      return { ok: false, balance: account.balance }
    }
    throw error
  }
  return { ok: true, pointLogId: charged!.pointLogId!, balanceAfter: charged!.balance }
}

/**
 * 退款入账（§7.4）：按扣款来源返还 → PointLog(type='refund', orderId=null)。
 * 调用方保证 refund ≤ 当前扣款（service 校验 + DB CHECK
 * `refundedPoints <= chargedPoints`）。迁移前的扣款没有 wallet 记录，以
 * campaign 的 chargePointLogId 为凭证按 legacy_unknown 返还。
 */
export async function creditPointsForPromotionRefund(
  tx: Prisma.TransactionClient,
  campaignId: number,
  userId: number,
  amount: number,
): Promise<{ pointLogId: number; balanceAfter: number }> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`promotion refund amount must be a positive integer, got ${amount}`)
  }
  const refunded = await refundInTx(tx, promotionCtx(campaignId, userId, 'refund', PROMOTION_REFUND_POINT_LOG_REASON), {
    originalKey: chargeKey(campaignId),
    amount,
    legacyAmount: amount,
  })
  return { pointLogId: refunded.pointLogId!, balanceAfter: refunded.balance }
}
