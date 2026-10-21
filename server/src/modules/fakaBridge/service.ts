// Public Faka business use cases. Implementations import their dependencies directly.
export {
  onFakaOrderRefundedInTx,
  scheduleFakaRevokeAttempt,
  processFakaRevokeTask,
  runFakaRevokeBatch,
  runFakaReconcileBatch,
  selectStuckFakaTasksForReconcile,
  syncFakaExpiresAtFromRemote,
  __setFakaLifecycleClientOverridesForTests,
} from './lifecycle.js'

export type { StuckFakaTaskRow } from './lifecycle.js'

export {
  sendProvisionEmailCode,
  confirmProvisionEmailCode,
  getProvisionEmailStatus,
  listBoundProvisionEmails,
  assertProvisionEmailTrusted,
  isProvisionEmailTrusted,
  peekProvisionEmailFromAnswers,
} from './provisionEmailProof.js'

export {
  createFakaBridgeTaskForOrder,
  scheduleFakaBridgeFirstAttempt,
} from './outbox.js'

export type { CreateFakaBridgeTaskInput } from './outbox.js'

export {
  processFakaBridgeTask,
  runFakaBridgeBatch,
  runFakaCapacityPrewarm,
  startFakaBridgeCron,
  stopFakaBridgeCron,
  __setFakaClientOverridesForTests,
  __setAfterClaimHookForTests,
} from './worker.js'

export type { ProcessOutcome } from './worker.js'
