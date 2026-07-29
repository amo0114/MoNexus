export {
  buildFakaSignPayload,
  signFakaParams,
  withFakaSignature,
  fakaSignaturesEqual,
} from './sign.js'
export type { FakaSignableParams, FakaSignableValue } from './sign.js'

export {
  callFakaOrderPaid,
  callFakaOrderStatus,
  callFakaOrderRevoke,
  callFakaPlanCapacity,
  callFakaSetPlanCapacity,
  callFakaPlanCatalog,
  isFakaBridgeConfigured,
  buildFakaExternalOrderNo,
  defaultFakaTransport,
} from './client.js'
export type { FakaBridgeClientOptions } from './client.js'

export {
  fetchFakaCapacityForSku,
  invalidateFakaCapacityCache,
  invalidateFakaCapacityFailures,
  rememberFakaCapacityPlanSnapshot,
  getCachedFakaCapacityByPlanId,
  __clearFakaCapacityCacheForTests,
} from './capacity.js'
export type { FakaCapacitySnapshot } from './capacity.js'

export { periodFromFakaSku } from './skuPeriod.js'

export {
  onFakaOrderRefundedInTx,
  scheduleFakaRevokeAttempt,
  processFakaRevokeTask,
  runFakaRevokeBatch,
  runFakaReconcileBatch,
  __setFakaLifecycleClientOverridesForTests,
} from './lifecycle.js'

export {
  sendProvisionEmailCode,
  confirmProvisionEmailCode,
  getProvisionEmailStatus,
  listBoundProvisionEmails,
  assertProvisionEmailTrusted,
  isProvisionEmailTrusted,
  peekProvisionEmailFromAnswers,
} from './provisionEmailProof.js'

export { FAKA_ERROR, classifyFakaHttpFailure, isFakaNonRetryable } from './errors.js'
export type { FakaErrorCode } from './errors.js'

export type {
  FakaOrderPaidRequest,
  FakaOrderPaidResponse,
  FakaOrderStatusResponse,
  FakaOrderRevokeResponse,
  FakaPlanCapacityResponse,
  FakaPlanCatalogResponse,
  FakaPlanCatalogItem,
  FakaHttpResult,
  FakaTransport,
} from './types.js'

export {
  FAKA_EXTERNAL_INTEGRATION,
  normalizeFakaOfferIntegration,
  isFakaBridgeOffer,
  assertOfferProvisionMutex,
} from './offerIntegration.js'
export type {
  FakaExternalIntegration,
  FakaOfferIntegrationInput,
  NormalizedFakaOfferIntegration,
} from './offerIntegration.js'

export {
  createFakaBridgeTaskForOrder,
  scheduleFakaBridgeFirstAttempt,
} from './outbox.js'
export type { CreateFakaBridgeTaskInput } from './outbox.js'

export {
  FAKA_PROVISION_EMAIL_KEYS,
  resolveFakaProvisionEmail,
} from './provisionEmail.js'

export {
  processFakaBridgeTask,
  runFakaBridgeBatch,
  startFakaBridgeCron,
  stopFakaBridgeCron,
  __setFakaClientOverridesForTests,
} from './worker.js'
export type { ProcessOutcome } from './worker.js'
