// T-MERCH-BE-003 — Promotion package/campaign module exports.
//
// This is the only public surface the CMI Integration Owner consumes to mount
// the routers and to reuse the shared idempotency canonicalizer (also used by
// T-MERCH-BE-004 billing). Importing this module must NOT open a DB connection
// or register any side effect (pure exports only).

export {
  CAMPAIGN_TRANSITIONS,
  OCCUPIED_PLACEMENT_STATUSES,
  PACKAGE_BOUNDS,
  PROMOTION_ERROR_CODES,
  UNCHARGED_STATUSES,
} from './constants.js'

export {
  CANONICAL_HASH_PATTERN,
  IDEMPOTENCY_KEY_PATTERN,
  canonicalizeCampaignAdjustment,
  canonicalizeCampaignCreate,
  normalizeCanonicalDateTime,
  normalizeCanonicalString,
  validateIdempotencyKey,
} from './idempotency.js'

export {
  toAdminCampaignDto,
  toAdminPackageDto,
  toMerchantCampaignDto,
  toMerchantPackageDto,
  type AdminCampaignDto,
  type AdminPackageDto,
  type CampaignRow,
  type MerchantCampaignDto,
  type MerchantPackageDto,
  type PackageRow,
} from './dto.js'

export { assertAllowedTransition } from './transitions.js'

export {
  assertPlacementFree,
  cancelMerchantCampaign,
  createCampaign,
  createPackage,
  listAdminCampaigns,
  listAdminPackages,
  listMerchantCampaigns,
  listMerchantPackages,
  rejectCampaign,
  resolveMerchantId,
  updatePackage,
  type CampaignCreateResult,
} from './service.js'

export { merchantPromotionRouter, adminPromotionRouter } from './routes.js'

export {
  recordCampaignRequest,
  recordCampaignTransition,
  recordPackageOutcome,
} from './metrics.js'

export {
  cancelCampaignSchema,
  createCampaignSchema,
  createPackageSchema,
  listCampaignsQuerySchema,
  listPackagesQuerySchema,
  rejectCampaignSchema,
  updatePackageSchema,
} from './schema.js'
