// governance-v1 contract types — mirror docs/api/governance-v1/openapi.json (GV* schemas).
// Field names and nullability follow the contract exactly; do not add derived fields here.

export const GOVERNANCE_CONTRACT_VERSION = 'governance-v1'

export type AdminPermission =
  | 'users.read'
  | 'users.ban'
  | 'points.read'
  | 'points.adjust'
  | 'merchants.read'
  | 'merchants.review'
  | 'merchants.suspend'
  | 'catalog.read'
  | 'catalog.write'
  | 'inventory.manage'
  | 'orders.read'
  | 'orders.delivery.read'
  | 'orders.resolve'
  | 'orders.after_sales.execute'
  | 'settlements.read'
  | 'settlements.execute'
  | 'payments.read'
  | 'payments.refunds.review'
  | 'payments.disputes.resolve'
  | 'audit.read'
  | 'audit.details.read'
  | 'exports.create'
  | 'wallet.integrity.read'
  | 'settings.manage'
  | 'admin.permissions.manage'
  | 'marketing.read'
  | 'marketing.write'
  | 'announcements.read'
  | 'announcements.write'
  | 'files.manage'
  | 'backups.manage'
  | 'ai.manage'
  | 'videos.read'
  | 'videos.manage'

export type MerchantCapability =
  | 'application.read'
  | 'application.resubmit'
  | 'history.read'
  | 'catalog.write'
  | 'inventory.write'
  | 'orders.accept'
  | 'orders.existing.write'
  | 'marketing.write'

export type GovernanceFeature =
  | 'refundReview'
  | 'merchantLifecycle'
  | 'accountBans'
  | 'userDetails'
  | 'inventoryTraceability'
  | 'exports'
  | 'walletIntegrity'

export interface GVCapabilities {
  contractVersion: typeof GOVERNANCE_CONTRACT_VERSION
  permissions: AdminPermission[]
  features: Record<GovernanceFeature, boolean>
  limits: { pageSize: number; exportRows: number; exportBytes: number; exportRetentionSeconds: number }
}

export interface GVBlocker {
  code: string
  message: string
}

export interface GVPageInfo {
  nextCursor: string | null
  hasNextPage: boolean
}

export interface GVCursorPage<T> {
  items: T[]
  pageInfo: GVPageInfo
  asOf: string
}

export type MerchantLifecycleStatus = 'pending' | 'active' | 'suspended' | 'rejected'
export type AccountStatus = 'active' | 'banned'
export type GVUserRole = 'user' | 'merchant' | 'admin'

/** Increment on login / current-user DTOs. Absent on backends without governance-v1. */
export interface GVMerchantContext {
  merchantStatus: MerchantLifecycleStatus | null
  merchantLifecycleVersion: number | null
  merchantCapabilities: MerchantCapability[]
}

// ── Recharge refund review ───────────────────────────────────────────────

export type GVRefundStatus =
  | 'requested'
  | 'points_held'
  | 'processing'
  | 'manual_review'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type GVRefundReviewAction = 'resume' | 'reject'

export interface GVRefundAction {
  id: string
  refundId: string
  kind: GVRefundReviewAction
  actorUserId: number
  reasonCode: string
  note: string
  evidenceRef: string | null
  fromStatus: string
  toStatus: string
  expectedReviewVersion: number
  createdAt: string
}

export interface GVRefundQualification {
  sourceKind: 'recharge' | 'legacy_unknown'
  /** Decimal strings, recharge serialization. */
  requiredPoints: string
  availablePoints: string
  asOf: string
}

export interface GVRefundDetail {
  id: string
  rechargeOrderId: string
  userId: number
  status: GVRefundStatus
  amountMinor: string
  currency: string
  pointsToReverse: string
  reasonCode: string | null
  reviewVersion: number
  qualification: GVRefundQualification
  allowedActions: GVRefundReviewAction[]
  blockers: GVBlocker[]
  history: GVRefundAction[]
  createdAt: string
  updatedAt: string
}

export interface GVRefundReviewInput {
  action: GVRefundReviewAction
  expectedReviewVersion: number
  reasonCode: string
  note: string
  evidenceRef?: string | null
}

export interface GVRefundReviewResult {
  refund: GVRefundDetail
  reviewAction: GVRefundAction
  replayed: boolean
}

// ── Merchant lifecycle ───────────────────────────────────────────────────

export type GVMerchantAction = 'submit' | 'resubmit' | 'approve' | 'reject' | 'suspend' | 'restore'

export interface GVApplicationInput {
  name: string
  description: string
  contactEmail: string
  contactPhone: string
  expectedLifecycleVersion: number
}

export interface GVApplicationRevision {
  id: string
  merchantId: number
  version: number
  name: string
  description: string
  contactEmail: string
  contactPhone: string
  submittedAt: string
  submittedByUserId: number | null
  isLegacyBaseline: boolean
}

export interface GVMerchantEvent {
  id: string
  merchantId: number
  applicationRevisionId: string | null
  action: GVMerchantAction
  fromStatus: string | null
  toStatus: string
  reasonCode: string
  note: string
  actorUserId: number | null
  versionAfter: number
  createdAt: string
}

export interface GVMerchantApplication {
  merchantId: number | null
  status: MerchantLifecycleStatus | null
  lifecycleVersion: number
  applicationVersion: number
  currentApplication: GVApplicationRevision | null
  history: GVMerchantEvent[]
  merchantCapabilities: MerchantCapability[]
  allowedActions: GVMerchantAction[]
  blockers: GVBlocker[]
}

export interface GVDecisionInput {
  expectedLifecycleVersion: number
  applicationVersion: number
  reasonCode: string
  note: string
  evidenceRef?: string | null
}

// ── Users, bans, audit ───────────────────────────────────────────────────

export interface GVBan {
  id: string
  userId: number
  version: number
  reasonCode: string
  reason: string | null
  startsAt: string | null
  expiresAt: string | null
  createdByUserId: number | null
  source: 'admin' | 'legacy'
  releasedAt: string | null
  releasedByUserId: number | null
  releaseReason: string | null
  createdAt: string
  effective: boolean
}

export interface GVBanInput {
  reasonCode: string
  reason: string
  expiresAt: string | null
}

export interface GVBanReleaseInput {
  expectedVersion: number
  reason: string
}

export type LegacyCompleteness = 'complete' | 'partial' | 'unknown'

export interface GVUserIdentity {
  id: number
  email: string
  nickname: string | null
  avatarUrl: string | null
  role: GVUserRole
  status: '正常' | '已封禁'
  accountStatus: AccountStatus
  emailVerified: string | null
  createdAt: string
  updatedAt: string
  lastLoginAt: string | null
}

export interface GVUserStats {
  orderCount: number
  chargedPoints: number
  refundedPoints: number
  netSpentPoints: number
  legacyCompleteness: LegacyCompleteness
}

export interface GVWalletSource {
  origin: string
  availablePoints: number
  frozenPoints: number
}

export interface GVUserWallet {
  balance: number
  frozenBalance: number
  sources: GVWalletSource[]
}

export interface GVUserListItem {
  id: number
  email: string
  nickname: string | null
  role: GVUserRole
  status: '正常' | '已封禁'
  accountStatus: AccountStatus
  emailVerified: string | null
  createdAt: string
  lastLoginAt: string | null
  merchantStatus: MerchantLifecycleStatus | null
  pointAccount: { balance: number } | null
  orderCount: number
  chargedPoints: number
  refundedPoints: number
  netSpentPoints: number
  legacyCompleteness: LegacyCompleteness
}

export interface GVUserList {
  items: GVUserListItem[]
  total: number
  page: number
  pageSize: number
}

export type GVUserSort = 'createdAt' | 'lastLoginAt' | 'orderCount' | 'netSpentPoints'

export interface GVUserListQuery {
  page?: number
  pageSize?: number
  q?: string
  accountStatus?: AccountStatus
  role?: GVUserRole
  merchantStatus?: MerchantLifecycleStatus
  emailVerified?: boolean
  registeredFrom?: string
  registeredTo?: string
  lastLoginFrom?: string
  lastLoginTo?: string
  sort?: GVUserSort
  direction?: 'asc' | 'desc'
}

export type GVUserSection = 'orders' | 'pointLogs' | 'sessions' | 'referrals' | 'securityEvents' | 'audit'

export interface GVUserDetail {
  user: GVUserIdentity
  ban: GVBan | null
  merchant: { id: number; name: string; status: MerchantLifecycleStatus; lifecycleVersion: number } | null
  /** null = caller lacks points.read; never render as 0. */
  wallet: GVUserWallet | null
  stats: GVUserStats | null
  invites: { inviterUserId: number | null; inviteeCount: number }
  activity: { lastLoginAt: string | null; lastSessionUsedAt: string | null; lastActiveDay: string | null }
  sections: Record<GVUserSection, boolean>
  asOf: string
}

export type GVShopOrderStatus = 'pending' | 'processing' | 'delivered' | 'disputed' | 'closed' | 'refunded'

export interface GVUserOrder {
  id: number
  orderNo: string | null
  productName: string
  status: GVShopOrderStatus
  price: number
  chargedPoints: number
  refundedPoints: number
  createdAt: string
}

export interface GVPointLog {
  id: number
  userId: number
  type: string
  amount: number
  balanceAfter: number
  reason: string | null
  orderId: number | null
  operationId: number | null
  origin: string | null
  createdAt: string
}

export interface GVSession {
  id: string
  deviceName: string | null
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string
  revoked: boolean
}

export interface GVReferral {
  id: number
  inviterUserId: number
  inviteeUserId: number
  status: string
  createdAt: string
}

export interface GVSecurityEvent {
  id: number
  type: string
  createdAt: string
}

export interface GVAuditSummary {
  id: number
  adminId: number
  action: string
  actionCode: string | null
  targetType: string | null
  targetId: number | null
  createdAt: string
}

export interface GVAuditSafe {
  reasonCode?: string
  reason?: string
  note?: string
  fromStatus?: string
  toStatus?: string
  versionAfter?: number
  count?: number
}

/** What the audit row proves happened (contract 1.0.3); never inferred from the action text. */
export type GVAuditOperationState = 'attempt' | 'committed' | 'sent' | 'failed' | 'rejected' | 'rate_limited' | 'unknown'

export interface GVAuditDetail extends GVAuditSummary {
  detailSchemaVersion: number | null
  detailSafe: GVAuditSafe | null
  detailAvailability: 'available' | 'legacy_detail_unavailable'
  operationState: GVAuditOperationState
  requestId: string | null
}

// ── Inventory and offer revisions ────────────────────────────────────────

export interface GVInventoryBatch {
  id: string
  productId: number
  offerId: number
  merchantId: number | null
  actorUserId: number | null
  importedCount: number
  availableCount: number
  soldCount: number
  voidCount: number
  createdAt: string
}

export interface GVInventoryBatchDetail {
  batch: GVInventoryBatch
  orders: Array<{ id: number; orderNo: string | null }>
  pageInfo: GVPageInfo
}

export interface GVVoidBatchResult {
  batch: GVInventoryBatch
  voidedCount: number
  replayed: boolean
}

export interface GVReasonInput {
  reasonCode: string
  note: string
}

export interface GVCommercialSnapshot {
  name?: string
  price?: number
  originalPrice?: number | null
  validityDays?: number | null
  status?: string
  fulfillmentType?: string
  inventoryMode?: string
  isDefault?: boolean
  autoProvision?: boolean
  externalSkuId?: string | null
}

export interface GVOfferRevision {
  id: string
  offerId: number
  revision: number
  actorType: 'user' | 'system' | 'migration'
  actorUserId: number | null
  sourceRef: string | null
  reasonCode: string
  /** null for the offer's first recorded revision (creation). */
  beforeSafe: GVCommercialSnapshot | null
  afterSafe: GVCommercialSnapshot
  changedFields: string[]
  createdAt: string
}

// ── Exports and wallet integrity ─────────────────────────────────────────

export type GVExportKind = 'users' | 'orders' | 'point_logs'
export type GVExportStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'expired'

export interface GVExportFilters {
  q?: string
  userId?: number
  accountStatus?: AccountStatus
  role?: GVUserRole
  merchantStatus?: MerchantLifecycleStatus
  emailVerified?: boolean
  from?: string
  to?: string
  status?: string
  type?: string
  orderNo?: string
}

export interface GVExportInput {
  kind: GVExportKind
  filters: GVExportFilters
}

export interface GVExportJob {
  id: string
  kind: GVExportKind
  requestedByUserId: number
  status: GVExportStatus
  phase: 'materializing' | 'uploading' | null
  snapshotAt: string | null
  rowCount: number | null
  byteSize: number | null
  errorCode: string | null
  createdAt: string
  completedAt: string | null
  expiresAt: string | null
}

export interface GVExportDownload {
  url: string
  expiresAt: string
}

export interface GVIntegrityRun {
  id: string
  status: 'running' | 'succeeded' | 'failed'
  upperUserId: number
  cursorUserId: number
  scannedCount: number
  startedAt: string
  completedAt: string | null
  errorCode: string | null
}

export interface GVIntegrityIssue {
  id: string
  userId: number
  type: 'balance_source_mismatch' | 'frozen_source_mismatch'
  accountValue: number
  sourceValue: number
  status: 'open' | 'resolved'
  firstSeenAt: string
  lastSeenAt: string
  lastVerifiedAt: string | null
  note: string | null
}

// ── Admin authorization (super only) ─────────────────────────────────────

export type AdminTier = 'super' | 'operator'

export interface GVAuthorization {
  userId: number
  tier: AdminTier
  version: number
  permissions: AdminPermission[]
  updatedAt: string
}

export interface GVAuthorizationInput {
  tier: AdminTier
  expectedVersion: number
  permissions: AdminPermission[]
  reason: string
}
