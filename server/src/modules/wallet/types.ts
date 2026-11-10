/** Where a lot's points originally came from. Not a withdrawal entitlement. */
export type WalletOriginKind =
  | 'recharge'
  | 'reward'
  | 'merchant_settlement'
  | 'admin_adjustment'
  | 'legacy_unknown'

export type WalletOperationKind =
  | 'credit'
  | 'spend'
  | 'reserve'
  | 'capture'
  | 'release'
  | 'refund'
  | 'reversal'
  | 'note'
  | 'sandbox_credit'
  | 'legacy_init'
  | 'legacy_refund'

export type WalletLog = {
  /** PointLog.type kept for display compatibility; defaults from the operation kind. */
  type?: string
  reason: string
  orderId?: number | null
  /** Reward-like credits only; recharge/settlement/refund never count toward growth. */
  growthEligible?: boolean
}

/**
 * Every mutation is identified by a business-derived key. The same key with the
 * same parameters replays the stored result; different parameters are rejected.
 */
export type WalletContext = {
  operationKey: string
  userId: number
  source: { kind: string; id: string | number }
  reasonCode: string
  actorUserId?: number | null
  log: WalletLog
}

export type LotFilter = {
  /** Restrict to these origins (e.g. merchant clawback only touches merchant_settlement). */
  origins?: WalletOriginKind[]
  /** Use lots created by these operations first, then the rest in entry order. */
  preferSourceOperationIds?: number[]
  /** Only lots created by these operations (e.g. a recharge refund reverses its own lot). */
  onlySourceOperationIds?: number[]
}

export type WalletResult = {
  operationId: number
  pointLogId: number | null
  amount: number
  balance: number
  frozenBalance: number
  replayed: boolean
}
