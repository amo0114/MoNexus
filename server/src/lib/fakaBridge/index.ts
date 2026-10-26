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
  fakaRemoteOrderNoMatches,
} from './client.js'
export type { FakaBridgeClientOptions } from './client.js'

export { callFakaV2Capabilities, callFakaV2ResolveAccount, callFakaV2Subscription } from './accountV2.js'
export type { FakaV2Capabilities, FakaV2ResolvedAccount, FakaV2Subscription, FakaV2Result } from './accountV2.js'
export { callPaidResetPreview, callPaidReset, paidResetPayloadHash } from './paidResetV2.js'
export type { PaidResetPayload, PaidResetResult } from './paidResetV2.js'

export {
  fetchFakaCapacityForSku,
  getFakaCapacityForPublicRead,
  prewarmFakaCapacityForSkus,
  invalidateFakaCapacityCache,
  invalidateFakaCapacityFailures,
  getCachedFakaCapacityByPlanId,
  __clearFakaCapacityCacheForTests,
} from './capacity.js'
export type { FakaCapacitySnapshot } from './capacity.js'

export { periodFromFakaSku } from './skuPeriod.js'
export { parseFakaExpiredAt } from './expiredAt.js'
export {
  extractFakaSubscriptionResult,
  buildFakaDeliveryPayload,
  formatTrafficBytes,
  formatExpiryUnix,
  actionLabel,
  periodLabel,
  subscriptionFromPaidBody,
} from './subscriptionResult.js'






export {
  FAKA_ERROR,
  classifyFakaHttpFailure,
  classifyFakaRemoteStatus,
  isFakaNonRetryable,
  isFakaUncertainResult,
  isFakaProvisionSuccessStatus,
} from './errors.js'
export type { FakaErrorCode, FakaRemoteOpenClass } from './errors.js'

export { readTaskScheduleUtc, isLeaseExpiredUtc } from './scheduleUtc.js'

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
  FAKA_PROVISION_EMAIL_KEYS,
  resolveFakaProvisionEmail,
} from './provisionEmail.js'
