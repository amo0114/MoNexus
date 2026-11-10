// wallet is the only owner of real point balances, lots, allocations and
// PointLog rows. It enforces point-level invariants only; business eligibility
// (refundable? settleable? paid?) stays with the calling module.
export {
  captureInTx,
  creditInTx,
  creditSandboxInTx,
  ensureAccountInTx,
  lockAccountsInTx,
  noteInTx,
  refundInTx,
  releaseInTx,
  reserveInTx,
  reverseReservedInTx,
  spendInTx,
} from './commands.js'
export {
  accountSources,
  availablePointsIn,
  findOperationByKey,
  findWalletInvariantViolations,
  orderPaymentComposition,
  type SourceComposition,
} from './queries.js'
export { POINT_ACCOUNT_HARD_CAP } from './balance.js'
export type { LotFilter, WalletContext, WalletOriginKind, WalletResult } from './types.js'
