// merchantFinance owns merchant earnings: Settlement creation/voiding,
// settleability, settlement batches, after-sales reversals and merchant
// recovery. It writes points only through wallet and never calls back into
// order workflows; orders orchestrate it inside their own transaction.
export { createSettlementInTx, markSettlementPayableInTx, voidUnsettledInTx } from './settlements.js'
export {
  executeSettlementBatch,
  getSettlementBatch,
  listSettlementBatches,
  MAX_SETTLEMENT_BATCH_SIZE,
  previewSettlementBatch,
} from './batches.js'
export { applyRecoveryAction, listRecoveryCases, reverseForAfterSalesInTx, serializeRecoveryCase, type RecoveryActionKind } from './adjustments.js'
export { getMerchantFinanceSummary, listSettlementEntries } from './queries.js'
export { getSettlementEligibility } from './settlementPolicy.js'
