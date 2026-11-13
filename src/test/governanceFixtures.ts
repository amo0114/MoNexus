// Synthetic governance-v1 contract fixtures published by the backend
// (docs/api/governance-v1). Tests use `response` only, never the wrapper.
import capabilitiesOperator from '../../docs/api/governance-v1/capabilities-operator.json'
import refundRefundable from '../../docs/api/governance-v1/refund-refundable.json'
import refundSourceInsufficient from '../../docs/api/governance-v1/refund-source-insufficient.json'
import refundLegacyUnproven from '../../docs/api/governance-v1/refund-legacy-unproven.json'
import refundResumed from '../../docs/api/governance-v1/refund-resumed.json'
import stateConflict from '../../docs/api/governance-v1/state-conflict.json'
import permissionDenied from '../../docs/api/governance-v1/permission-denied.json'
import merchantRejected from '../../docs/api/governance-v1/merchant-rejected.json'
import merchantSuspended from '../../docs/api/governance-v1/merchant-suspended.json'
import userBannedLegacyIncomplete from '../../docs/api/governance-v1/user-banned-legacy-incomplete.json'
import exportQueued from '../../docs/api/governance-v1/export-queued.json'
import exportRunning from '../../docs/api/governance-v1/export-running.json'
import exportSucceeded from '../../docs/api/governance-v1/export-succeeded.json'
import exportFailed from '../../docs/api/governance-v1/export-failed.json'
import exportExpired from '../../docs/api/governance-v1/export-expired.json'
import offerRevision from '../../docs/api/governance-v1/offer-revision.json'
import auditAttempt from '../../docs/api/governance-v1/audit-attempt.json'
import auditUnknown from '../../docs/api/governance-v1/audit-unknown.json'
import auditSafe from '../../docs/api/governance-v1/audit-safe.json'
import type {
  GVAuditDetail,
  GVCapabilities,
  GVCursorPage,
  GVExportJob,
  GVMerchantApplication,
  GVOfferRevision,
  GVRefundDetail,
  GVRefundReviewResult,
  GVUserDetail,
} from '../types/governance'

const clone = <T>(value: T): T => structuredClone(value)

export const fx = {
  capabilitiesOperator: () => clone(capabilitiesOperator.response) as GVCapabilities,
  refundRefundable: () => clone(refundRefundable.response) as GVRefundDetail,
  refundSourceInsufficient: () => clone(refundSourceInsufficient.response) as GVRefundDetail,
  refundLegacyUnproven: () => clone(refundLegacyUnproven.response) as GVRefundDetail,
  refundResumed: () => clone(refundResumed.response) as GVRefundReviewResult,
  merchantRejected: () => clone(merchantRejected.response) as GVMerchantApplication,
  merchantSuspended: () => clone(merchantSuspended.response) as GVMerchantApplication,
  userBannedLegacyIncomplete: () => clone(userBannedLegacyIncomplete.response) as GVUserDetail,
  auditAttempt: () => clone(auditAttempt.response) as GVAuditDetail,
  auditUnknown: () => clone(auditUnknown.response) as GVAuditDetail,
  auditSafe: () => clone(auditSafe.response) as GVAuditDetail,
  offerRevisions: () => clone(offerRevision.response) as GVCursorPage<GVOfferRevision>,
  exports: () => [exportQueued, exportRunning, exportSucceeded, exportFailed, exportExpired].map((f) => clone(f.response) as GVExportJob),
}

/** Axios-shaped HTTP error carrying a contract error body. */
export function httpError(status: number, body: unknown = stateConflict.response) {
  return Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, response: { status, data: body } })
}

export const conflictError = () => httpError(409, stateConflict.response)
export const forbiddenError = () => httpError(403, permissionDenied.response)
/** Timeout / dropped connection: no response at all. */
export const networkError = () => Object.assign(new Error('timeout of 15000ms exceeded'), { isAxiosError: true, code: 'ECONNABORTED' })
