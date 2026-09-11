import { describe, expect, it } from 'vitest'
import {
  CATALOG_ERROR_CODES,
  CATEGORY_APPLICATION_RESOLUTION,
  CATEGORY_APPLICATION_STATUS,
  CATEGORY_CODE_PATTERN,
  CATEGORY_SEED_CODES,
  CATEGORY_STATUS,
  EXTERNAL_CATALOG_PROVIDER,
  PRODUCT_STATUS,
  READINESS_DETAIL_CODES,
  SEED_CATEGORY_CODE,
} from './catalog'

/**
 * Contract tests for the frozen catalog constants (T-CAT-FE-001A).
 *
 * Expected literals below are the exact values of the Foundation-frozen
 * `server/src/modules/catalog/constants.ts`; any drift fails this suite.
 */
describe('catalog frozen seed codes (spec §5.1)', () => {
  it('matches the seeded category codes exactly', () => {
    expect(SEED_CATEGORY_CODE).toEqual({
      NETWORK_NODE: 'network-node',
      SHARED_ACCOUNT: 'shared-account',
      RECHARGE_CARD: 'recharge-card',
      INVITE_CODE: 'invite-code',
      LEGACY_UNCLASSIFIED: 'legacy-unclassified',
    })
    expect(CATEGORY_SEED_CODES).toEqual([
      'network-node',
      'shared-account',
      'recharge-card',
      'invite-code',
      'legacy-unclassified',
    ])
  })
})

describe('category code pattern (spec §5.1)', () => {
  it('accepts valid stable ASCII codes', () => {
    for (const code of ['network-node', 'ab', 'a1', 'a_b-c', 'x'.repeat(64)]) {
      expect(code).toMatch(CATEGORY_CODE_PATTERN)
    }
  })

  it('rejects invalid codes', () => {
    for (const code of ['', 'a', 'Network', '1abc', '-a', 'a b', 'a'.repeat(65), 'a/é']) {
      expect(code).not.toMatch(CATEGORY_CODE_PATTERN)
    }
  })
})

describe('catalog frozen status unions', () => {
  it('pins category / application / product statuses', () => {
    expect(CATEGORY_STATUS).toEqual({ ACTIVE: 'active', INACTIVE: 'inactive' })
    expect(CATEGORY_APPLICATION_STATUS).toEqual({
      PENDING: 'pending',
      APPROVED: 'approved',
      REJECTED: 'rejected',
      WITHDRAWN: 'withdrawn',
    })
    expect(CATEGORY_APPLICATION_RESOLUTION).toEqual({
      CREATE_NEW: 'create_new',
      MAP_EXISTING: 'map_existing',
    })
    expect(PRODUCT_STATUS).toEqual({ DRAFT: 'draft', ACTIVE: 'active', INACTIVE: 'inactive' })
    expect(EXTERNAL_CATALOG_PROVIDER).toEqual({ FAKA_BRIDGE: 'faka_bridge' })
  })
})

describe('catalog frozen error codes (spec §6.1, §7.3-7.4, §9.3)', () => {
  it('pins the stable error code set', () => {
    expect(CATALOG_ERROR_CODES).toEqual({
      LEGACY_TYPE_WITH_CATEGORY_ID: 'LEGACY_TYPE_WITH_CATEGORY_ID',
      CATEGORY_APPLICATION_ALREADY_REVIEWED: 'CATEGORY_APPLICATION_ALREADY_REVIEWED',
      CATEGORY_APPLICATION_PENDING_DUPLICATE: 'CATEGORY_APPLICATION_PENDING_DUPLICATE',
      CATEGORY_APPLICATION_MAP_TARGET_INACTIVE: 'CATEGORY_APPLICATION_MAP_TARGET_INACTIVE',
      PRODUCT_NOT_READY: 'PRODUCT_NOT_READY',
      FAKA_SOURCE_CHANGED: 'FAKA_SOURCE_CHANGED',
      IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
      IDEMPOTENCY_KEY_INVALID: 'IDEMPOTENCY_KEY_INVALID',
      IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
      CATEGORY_CODE_IMMUTABLE: 'CATEGORY_CODE_IMMUTABLE',
      CATEGORY_CODE_TAKEN: 'CATEGORY_CODE_TAKEN',
      CATEGORY_LABEL_TAKEN: 'CATEGORY_LABEL_TAKEN',
      CATEGORY_REFERENCED: 'CATEGORY_REFERENCED',
      PRODUCT_TEMPLATE_INVALID: 'PRODUCT_TEMPLATE_INVALID',
      PRODUCT_EDITOR_UPGRADE_REQUIRED: 'PRODUCT_EDITOR_UPGRADE_REQUIRED',
      PRODUCT_LOGIN_REQUIRED: 'PRODUCT_LOGIN_REQUIRED',
      PRODUCT_CONTENT_CHANGED: 'PRODUCT_CONTENT_CHANGED',
      OFFER_CHANGED: 'OFFER_CHANGED',
      PRODUCT_TEMPLATE_LOCKED: 'PRODUCT_TEMPLATE_LOCKED',
      ASSURANCE_ALREADY_PENDING: 'ASSURANCE_ALREADY_PENDING',
      ASSURANCE_ALREADY_ACTIVE: 'ASSURANCE_ALREADY_ACTIVE',
      ASSURANCE_APPLICATION_CLOSED: 'ASSURANCE_APPLICATION_CLOSED',
      SHARE_LINK_CREATING: 'SHARE_LINK_CREATING',
      SHARE_LINK_UNAVAILABLE: 'SHARE_LINK_UNAVAILABLE',
    })
  })

  it('pins the readiness detail codes (spec §6.1)', () => {
    expect(READINESS_DETAIL_CODES).toEqual({
      COVER_REQUIRED: 'COVER_REQUIRED',
      CATEGORY_INACTIVE: 'CATEGORY_INACTIVE',
      OFFER_NOT_SELLABLE: 'OFFER_NOT_SELLABLE',
      EXTERNAL_IDENTITY_INVALID: 'EXTERNAL_IDENTITY_INVALID',
      TEMPLATE_FIELDS_REQUIRED: 'TEMPLATE_FIELDS_REQUIRED',
      PURCHASE_NOTES_REQUIRED: 'PURCHASE_NOTES_REQUIRED',
      AFTER_SALES_REQUIRED: 'AFTER_SALES_REQUIRED',
      FULFILLMENT_CONFIG_INVALID: 'FULFILLMENT_CONFIG_INVALID',
    })
  })
})
