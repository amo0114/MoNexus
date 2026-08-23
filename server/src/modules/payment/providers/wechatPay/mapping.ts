import { createHash } from 'node:crypto'
import type { PaymentAttemptStatus, RechargeCurrency } from '../../../recharge/types.js'
import type { NormalizedPayment, NormalizedRefund } from '../types.js'

/** Official Native out_trade_no: 6-32 of digits, letters, _ - | * */
export const OUT_TRADE_NO_PATTERN = /^[0-9A-Za-z_\-|*]{6,32}$/

export const WECHAT_PAY_CNY = 'CNY' as const
export const WECHAT_PAY_NATIVE_METHOD = 'native'

export type WechatTradeState =
  | 'SUCCESS'
  | 'REFUND'
  | 'NOTPAY'
  | 'CLOSED'
  | 'REVOKED'
  | 'USERPAYING'
  | 'PAYERROR'

export type WechatRefundStatus = 'SUCCESS' | 'CLOSED' | 'PROCESSING' | 'ABNORMAL'

export type WechatAmount = {
  total?: number
  refund?: number
  currency?: string
}

export type WechatTransaction = {
  mchid?: string
  appid?: string
  out_trade_no?: string
  transaction_id?: string
  trade_state?: string
  trade_type?: string
  amount?: WechatAmount
  success_time?: string
}

export type WechatRefund = {
  mchid?: string
  out_trade_no?: string
  transaction_id?: string
  out_refund_no?: string
  refund_id?: string
  refund_status?: string
  status?: string
  amount?: WechatAmount
}

export function toOutTradeNo(stableId: string): string {
  const compact = stableId.replace(/-/g, '')
  if (OUT_TRADE_NO_PATTERN.test(compact)) return compact
  return createHash('sha256').update(stableId, 'utf8').digest('hex').slice(0, 32)
}

export function toFenInteger(amountMinor: bigint): number {
  if (amountMinor <= 0n) {
    throw new Error('amount.total must be a positive integer in fen')
  }
  if (amountMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('amount.total exceeds JSON integer range')
  }
  return Number(amountMinor)
}

export function fenToAmountMinor(total: unknown): bigint | null {
  if (typeof total !== 'number' || !Number.isInteger(total) || total <= 0) return null
  if (!Number.isSafeInteger(total)) return null
  return BigInt(total)
}

export function assertNativeCnyAmount(amountMinor: bigint, currency: RechargeCurrency): number {
  if (currency !== WECHAT_PAY_CNY) {
    throw new Error('WeChat Pay V1 Native accepts CNY only')
  }
  return toFenInteger(amountMinor)
}

export function mapTradeState(tradeState: string | undefined): PaymentAttemptStatus {
  switch (tradeState) {
    case 'SUCCESS':
    case 'REFUND':
      return 'succeeded'
    case 'NOTPAY':
      return 'requires_action'
    case 'USERPAYING':
      return 'processing'
    case 'CLOSED':
    case 'REVOKED':
      return 'cancelled'
    case 'PAYERROR':
      return 'failed'
    default:
      return 'unknown'
  }
}

export function mapRefundStatus(status: string | undefined): NormalizedRefund['status'] {
  switch (status) {
    case 'SUCCESS':
      return 'succeeded'
    case 'PROCESSING':
      return 'processing'
    case 'CLOSED':
    case 'ABNORMAL':
      return 'failed'
    default:
      return 'unknown'
  }
}

export function identityMatches(input: {
  mchid: string
  appid: string
  transaction: WechatTransaction
}): boolean {
  const { transaction } = input
  return transaction.mchid === input.mchid
    && transaction.appid === input.appid
    && typeof transaction.out_trade_no === 'string'
    && transaction.out_trade_no.length > 0
    && typeof transaction.transaction_id === 'string'
    && transaction.transaction_id.length > 0
    && transaction.amount?.currency === WECHAT_PAY_CNY
    && fenToAmountMinor(transaction.amount.total) != null
}

export function toNormalizedPayment(input: {
  providerAccountKey: string
  transaction: WechatTransaction
  expectedMchid: string
  expectedAppid: string
}): NormalizedPayment {
  const amountMinor = fenToAmountMinor(input.transaction.amount?.total) ?? 0n
  const matched = identityMatches({
    mchid: input.expectedMchid,
    appid: input.expectedAppid,
    transaction: input.transaction,
  })
  const mapped = mapTradeState(input.transaction.trade_state)
  const status: PaymentAttemptStatus = matched && mapped === 'succeeded' ? 'succeeded' : mapped === 'succeeded' ? 'unknown' : mapped
  const tradeState = input.transaction.trade_state ?? 'UNKNOWN'
  return {
    status,
    providerPaymentId: input.transaction.out_trade_no ?? '',
    providerOrderId: input.transaction.transaction_id ?? null,
    providerCaptureId: status === 'succeeded' ? input.transaction.transaction_id ?? null : null,
    amountMinor,
    currency: WECHAT_PAY_CNY,
    providerAccountKey: input.providerAccountKey,
    immutableStateVersion: `${tradeState}:${input.transaction.transaction_id ?? input.transaction.out_trade_no ?? ''}`,
    rawStatus: tradeState,
  }
}

export function refundStatusOf(row: WechatRefund): string | undefined {
  return row.refund_status ?? row.status
}
