/**
 * e2e/catalog-xboard-import.spec.ts
 *
 * Catalog ↔ XBoard (external import board) integration spec — happy-path
 * browser E2E (preview → confirm → admin products list back-check).
 *
 * This file defines the shared typed guards, fixtures, and response parsers
 * that the xboard import test() case builds on, and hosts one real-UI test:
 * an admin previews and confirms a sanitized Xboard draft, then the refreshed
 * admin product list is re-verified against a strict typed DTO and the real
 * DOM table.
 *
 * HTTP response predicates (method + exact pathname; empty search where noted):
 *   - isCatalogResponse        GET  /api/admin/faka/catalog
 *   - isRegistryResponse       GET  /api/config/registry
 *   - isImportPreviewResponse  POST /api/admin/faka/import/preview
 *   - isImportResponse         POST /api/admin/faka/import
 *   - isAdminProductsResponse  GET  /api/admin/products (empty URL search)
 *
 * Response parsers (strict, reject extra keys, throw clear errors):
 *   - parseFakaCatalogResponse      GET /api/admin/faka/catalog payload
 *   - parseCategoryRegistryResponse GET /api/config/registry payload
 *   - parseAdminProductsResponse    GET /api/admin/products payload
 *     (allows extra server keys; every required field is type-validated)
 *
 * XBoard fixture reset:
 *   - resetXboardFixture() POSTs http://127.0.0.1:3106/__fixture/reset
 *     with no body, strictly validates the JSON payload
 *     { success: true, action: "reset", sourceHash: <64-char lowercase hex> },
 *     and returns sourceHash. Every unexpected response throws a fixed error.
 */

import { expect, test, type Page, type Request, type Response } from '@playwright/test';
import { SEED_ACCOUNTS, loginAs } from './helpers';

const XBOARD_FIXTURE_RESET_URL = 'http://127.0.0.1:3106/__fixture/reset';

const FIXTURE_RESET_ERROR_MESSAGE =
  'XBoard fixture reset failed: unexpected response from __fixture/reset';

// ---------------------------------------------------------------------------
// Primitive guards
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}

/**
 * Asserts that `value` is a plain record whose key set is exactly `keys`.
 * Uses `context` to build a clear error on any mismatch; on success narrows
 * to the record.
 */
function assertExactKeys(
  value: unknown,
  keys: readonly string[],
  context: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    const kind =
      value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value;
    throw new Error(`${context}: expected a plain object, got ${kind}`);
  }
  const actual = Object.keys(value);
  const missing = keys.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !keys.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${context}: expected exactly [${keys.join(', ')}], missing [${missing.join(', ')}], ` +
        `unexpected [${extra.join(', ')}]`,
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP response predicates
// ---------------------------------------------------------------------------

/**
 * Builds a predicate matching a response whose request method and URL
 * pathname are exactly the given values.
 */
function exactResponse(method: string, pathname: string): (response: Response) => boolean {
  return (response: Response) =>
    response.request().method() === method && new URL(response.url()).pathname === pathname;
}

export const isCatalogResponse = exactResponse('GET', '/api/admin/faka/catalog');
export const isRegistryResponse = exactResponse('GET', '/api/config/registry');
export const isImportPreviewResponse = exactResponse('POST', '/api/admin/faka/import/preview');
export const isImportResponse = exactResponse('POST', '/api/admin/faka/import');

/**
 * Matches the admin products list response: GET with exact pathname
 * /api/admin/products and an empty URL search string. The real UI refresh
 * triggered by onImported() after a successful import sends no query params.
 */
export const isAdminProductsResponse = (response: Response): boolean =>
  response.request().method() === 'GET'
  && new URL(response.url()).pathname === '/api/admin/products'
  && new URL(response.url()).search === '';

// ---------------------------------------------------------------------------
// XBoard fixture reset
// ---------------------------------------------------------------------------

/**
 * Resets the XBoard fixture server. Returns the reported sourceHash on
 * success; throws the fixed FIXTURE_RESET_ERROR_MESSAGE on any failure.
 */
export async function resetXboardFixture(): Promise<string> {
  const response = await fetch(XBOARD_FIXTURE_RESET_URL, { method: 'POST' });
  if (!response.ok) {
    throw new Error(FIXTURE_RESET_ERROR_MESSAGE);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(FIXTURE_RESET_ERROR_MESSAGE);
  }

  assertExactKeys(payload, ['success', 'action', 'sourceHash'], FIXTURE_RESET_ERROR_MESSAGE);
  if (payload.success !== true || payload.action !== 'reset') {
    throw new Error(FIXTURE_RESET_ERROR_MESSAGE);
  }
  if (typeof payload.sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(payload.sourceHash)) {
    throw new Error(FIXTURE_RESET_ERROR_MESSAGE);
  }
  return payload.sourceHash;
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

export interface FakaCatalogPeriod {
  period: string;
  price: number;
  sku_alias: string;
}

export interface FakaCatalogNamedSku {
  sku: string;
  period: string;
}

export interface FakaCatalogPlan {
  plan_id: number;
  name: string;
  show: boolean;
  sell: boolean;
  capacity_limit: number | null;
  active_users: number;
  remaining: number | null;
  periods: FakaCatalogPeriod[];
  named_skus: FakaCatalogNamedSku[];
}

export interface FakaCatalogResponse {
  plans: FakaCatalogPlan[];
}

/**
 * Strictly parses the Faka catalog response payload.
 * Top level must be exactly { plans }; `plans` must be a non-empty array.
 * Each plan must be exactly { plan_id, name, show, sell, capacity_limit,
 * active_users, remaining, periods, named_skus } with:
 *   - plan_id: positive integer, unique across plans
 *   - name: non-empty string
 *   - show/sell: booleans
 *   - capacity_limit/remaining: null or non-negative integer
 *   - active_users: non-negative integer
 *   - periods: non-empty array of exactly { period, price, sku_alias } with
 *     non-empty string period/sku_alias, non-negative integer price, and
 *     period/sku_alias each unique within the plan
 *   - named_skus: array of exactly { sku, period } with non-empty strings,
 *     no repeated sku and no repeated (sku, period) pair within the plan
 * Rejects any extra key. Returns a fully typed object.
 */
export function parseFakaCatalogResponse(value: unknown): FakaCatalogResponse {
  assertExactKeys(value, ['plans'], 'Faka catalog response');
  const plans: unknown[] = value.plans;
  if (!Array.isArray(plans) || plans.length === 0) {
    throw new Error('Faka catalog response: "plans" must be a non-empty array');
  }

  const planIds = new Set<number>();
  const parsedPlans: FakaCatalogPlan[] = [];
  for (const plan of plans) {
    assertExactKeys(
      plan,
      [
        'plan_id',
        'name',
        'show',
        'sell',
        'capacity_limit',
        'active_users',
        'remaining',
        'periods',
        'named_skus',
      ],
      'Faka catalog response: plan',
    );

    if (!isPositiveInteger(plan.plan_id)) {
      throw new Error('Faka catalog response: plan.plan_id must be a positive integer');
    }
    if (planIds.has(plan.plan_id)) {
      throw new Error(`Faka catalog response: duplicate plan_id ${plan.plan_id}`);
    }
    planIds.add(plan.plan_id);

    if (typeof plan.name !== 'string' || plan.name.length === 0) {
      throw new Error('Faka catalog response: plan.name must be a non-empty string');
    }
    if (typeof plan.show !== 'boolean') {
      throw new Error('Faka catalog response: plan.show must be a boolean');
    }
    if (typeof plan.sell !== 'boolean') {
      throw new Error('Faka catalog response: plan.sell must be a boolean');
    }
    if (!isNullableNonNegativeInteger(plan.capacity_limit)) {
      throw new Error('Faka catalog response: plan.capacity_limit must be null or a non-negative integer');
    }
    if (!isNonNegativeInteger(plan.active_users)) {
      throw new Error('Faka catalog response: plan.active_users must be a non-negative integer');
    }
    if (!isNullableNonNegativeInteger(plan.remaining)) {
      throw new Error('Faka catalog response: plan.remaining must be null or a non-negative integer');
    }

    const periods: unknown[] = plan.periods;
    if (!Array.isArray(periods) || periods.length === 0) {
      throw new Error('Faka catalog response: plan.periods must be a non-empty array');
    }
    const seenPeriods = new Set<string>();
    const seenSkuAliases = new Set<string>();
    const parsedPeriods: FakaCatalogPeriod[] = [];
    for (const period of periods) {
      assertExactKeys(
        period,
        ['period', 'price', 'sku_alias'],
        'Faka catalog response: plan.periods item',
      );
      if (typeof period.period !== 'string' || period.period.length === 0) {
        throw new Error('Faka catalog response: period.period must be a non-empty string');
      }
      if (seenPeriods.has(period.period)) {
        throw new Error(`Faka catalog response: duplicate period "${period.period}" within a plan`);
      }
      seenPeriods.add(period.period);
      if (!isNonNegativeInteger(period.price)) {
        throw new Error('Faka catalog response: period.price must be a non-negative integer');
      }
      if (typeof period.sku_alias !== 'string' || period.sku_alias.length === 0) {
        throw new Error('Faka catalog response: period.sku_alias must be a non-empty string');
      }
      if (seenSkuAliases.has(period.sku_alias)) {
        throw new Error(`Faka catalog response: duplicate sku_alias "${period.sku_alias}" within a plan`);
      }
      seenSkuAliases.add(period.sku_alias);
      parsedPeriods.push({
        period: period.period,
        price: period.price,
        sku_alias: period.sku_alias,
      });
    }

    const namedSkus: unknown[] = plan.named_skus;
    if (!Array.isArray(namedSkus)) {
      throw new Error('Faka catalog response: plan.named_skus must be an array');
    }
    const seenSkus = new Set<string>();
    const seenPairs = new Set<string>();
    const parsedNamedSkus: FakaCatalogNamedSku[] = [];
    for (const namedSku of namedSkus) {
      assertExactKeys(
        namedSku,
        ['sku', 'period'],
        'Faka catalog response: plan.named_skus item',
      );
      if (typeof namedSku.sku !== 'string' || namedSku.sku.length === 0) {
        throw new Error('Faka catalog response: named_skus.sku must be a non-empty string');
      }
      if (seenSkus.has(namedSku.sku)) {
        throw new Error(`Faka catalog response: duplicate sku "${namedSku.sku}" within a plan`);
      }
      seenSkus.add(namedSku.sku);
      if (typeof namedSku.period !== 'string' || namedSku.period.length === 0) {
        throw new Error('Faka catalog response: named_skus.period must be a non-empty string');
      }
      const pairKey = `${namedSku.sku}\u0000${namedSku.period}`;
      if (seenPairs.has(pairKey)) {
        throw new Error(
          `Faka catalog response: duplicate (sku, period) pair "${namedSku.sku}" / "${namedSku.period}" within a plan`,
        );
      }
      seenPairs.add(pairKey);
      parsedNamedSkus.push({ sku: namedSku.sku, period: namedSku.period });
    }

    parsedPlans.push({
      plan_id: plan.plan_id,
      name: plan.name,
      show: plan.show,
      sell: plan.sell,
      capacity_limit: plan.capacity_limit,
      active_users: plan.active_users,
      remaining: plan.remaining,
      periods: parsedPeriods,
      named_skus: parsedNamedSkus,
    });
  }

  return { plans: parsedPlans };
}

export interface CategoryRegistryItem {
  id: number;
  code: string;
  label: string;
  iconKey: string | null;
  sortOrder: number;
}

/**
 * Strictly parses the category registry response payload.
 * The top level may carry other (frozen) keys — only `productCategories` is
 * inspected and must be a non-empty array. Each item must be exactly
 * { id, code, label, iconKey, sortOrder } with:
 *   - id: positive integer, unique across items
 *   - code/label: non-empty strings
 *   - iconKey: string or null
 *   - sortOrder: integer
 * Rejects any extra key. Returns a fully typed array.
 */
export function parseCategoryRegistryResponse(value: unknown): CategoryRegistryItem[] {
  if (!isRecord(value)) {
    throw new Error('Category registry response: expected a plain object');
  }
  const productCategories: unknown[] = value.productCategories;
  if (!Array.isArray(productCategories) || productCategories.length === 0) {
    throw new Error('Category registry response: "productCategories" must be a non-empty array');
  }

  const ids = new Set<number>();
  const items: CategoryRegistryItem[] = [];
  for (const item of productCategories) {
    assertExactKeys(
      item,
      ['id', 'code', 'label', 'iconKey', 'sortOrder'],
      'Category registry response: productCategories item',
    );
    if (!isPositiveInteger(item.id)) {
      throw new Error('Category registry response: item.id must be a positive integer');
    }
    if (ids.has(item.id)) {
      throw new Error(`Category registry response: duplicate id ${item.id}`);
    }
    ids.add(item.id);
    if (typeof item.code !== 'string' || item.code.length === 0) {
      throw new Error('Category registry response: item.code must be a non-empty string');
    }
    if (typeof item.label !== 'string' || item.label.length === 0) {
      throw new Error('Category registry response: item.label must be a non-empty string');
    }
    if (item.iconKey !== null && typeof item.iconKey !== 'string') {
      throw new Error('Category registry response: item.iconKey must be a string or null');
    }
    if (!isInteger(item.sortOrder)) {
      throw new Error('Category registry response: item.sortOrder must be an integer');
    }
    items.push({
      id: item.id,
      code: item.code,
      label: item.label,
      iconKey: item.iconKey,
      sortOrder: item.sortOrder,
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Faka import request parsers
// ---------------------------------------------------------------------------

export interface FakaImportOffer {
  period: string;
  pricePoints: number;
  sku?: string;
  offerName?: string;
  validityDays?: number | null;
}

export interface FakaImportRequest {
  planId: number;
  productName: string;
  categoryId: number;
  cover: { mode: 'category_default' };
  offers: FakaImportOffer[];
}

export interface FakaConfirmRequest extends FakaImportRequest {
  sourceHash: string;
}

/**
 * Asserts that `value` is a plain record containing every key in `required`
 * and no key outside the union of `required` and `optional`.
 */
function assertSubsetKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  context: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    const kind =
      value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value;
    throw new Error(`${context}: expected a plain object, got ${kind}`);
  }
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !allowed.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${context}: expected keys [${required.join(', ')}] with optional [${optional.join(', ')}], ` +
        `missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]`,
    );
  }
}

/**
 * Parses the shared Faka import fields `{ planId, productName, categoryId,
 * cover, offers }` (exactly those five keys) that both the import and confirm
 * request parsers build on. See parseFakaImportRequest for the field rules.
 */
function parseFakaImportFields(value: unknown, context: string): FakaImportRequest {
  assertExactKeys(
    value,
    ['planId', 'productName', 'categoryId', 'cover', 'offers'],
    context,
  );

  if (!isPositiveInteger(value.planId)) {
    throw new Error(`${context}: planId must be a positive integer`);
  }
  const planId = value.planId;
  if (!isPositiveInteger(value.categoryId)) {
    throw new Error(`${context}: categoryId must be a positive integer`);
  }
  const categoryId = value.categoryId;
  if (typeof value.productName !== 'string' || value.productName.length === 0) {
    throw new Error(`${context}: productName must be a non-empty string`);
  }
  const productName = value.productName;

  assertExactKeys(value.cover, ['mode'], `${context}: cover`);
  if (value.cover.mode !== 'category_default') {
    throw new Error(`${context}: cover.mode must be "category_default"`);
  }

  const offers: unknown[] = value.offers;
  if (!Array.isArray(offers) || offers.length === 0) {
    throw new Error(`${context}: "offers" must be a non-empty array`);
  }

  const seenPeriods = new Set<string>();
  const seenSkus = new Set<string>();
  const parsedOffers: FakaImportOffer[] = [];
  for (const offer of offers) {
    assertSubsetKeys(
      offer,
      ['period', 'pricePoints'],
      ['sku', 'offerName', 'validityDays'],
      `${context}: offers item`,
    );

    const period = offer.period;
    if (typeof period !== 'string' || period.length === 0) {
      throw new Error(`${context}: offers item period must be a non-empty string`);
    }
    if (seenPeriods.has(period)) {
      throw new Error(`${context}: duplicate period "${period}" in offers`);
    }
    seenPeriods.add(period);

    if (!isPositiveInteger(offer.pricePoints)) {
      throw new Error(`${context}: offers item pricePoints must be a positive integer`);
    }
    const pricePoints = offer.pricePoints;

    let sku: string | undefined;
    if (Object.prototype.hasOwnProperty.call(offer, 'sku')) {
      if (typeof offer.sku !== 'string' || offer.sku.length === 0) {
        throw new Error(`${context}: offers item sku must be a non-empty string when present`);
      }
      sku = offer.sku;
      if (seenSkus.has(sku)) {
        throw new Error(`${context}: duplicate sku "${sku}" in offers`);
      }
      seenSkus.add(sku);
    }

    let offerName: string | undefined;
    if (Object.prototype.hasOwnProperty.call(offer, 'offerName')) {
      if (typeof offer.offerName !== 'string' || offer.offerName.length === 0) {
        throw new Error(`${context}: offers item offerName must be a non-empty string when present`);
      }
      offerName = offer.offerName;
    }

    let validityDays: number | null | undefined;
    if (Object.prototype.hasOwnProperty.call(offer, 'validityDays')) {
      if (offer.validityDays !== null && !isPositiveInteger(offer.validityDays)) {
        throw new Error(`${context}: offers item validityDays must be a positive integer or null when present`);
      }
      validityDays = offer.validityDays;
    }

    parsedOffers.push({
      period,
      pricePoints,
      ...(sku !== undefined ? { sku } : {}),
      ...(offerName !== undefined ? { offerName } : {}),
      ...(validityDays !== undefined ? { validityDays } : {}),
    });
  }

  return {
    planId,
    productName,
    categoryId,
    cover: { mode: 'category_default' },
    offers: parsedOffers,
  };
}

/**
 * Strictly parses a Faka import request payload.
 * Top level must be exactly { planId, productName, categoryId, cover, offers }:
 *   - planId/categoryId: positive integers
 *   - productName: non-empty string
 *   - cover: exactly { mode } with mode === "category_default"
 *   - offers: non-empty array; each item must contain period (non-empty string,
 *     unique across offers) and pricePoints (positive integer), and may contain
 *     sku (non-empty string, unique across offers when present), offerName
 *     (non-empty string), validityDays (positive integer or null). Any other
 *     key is rejected. Returns a fully typed object that only carries the
 *     optional keys that were actually present.
 */
export function parseFakaImportRequest(value: unknown): FakaImportRequest {
  return parseFakaImportFields(value, 'Faka import request');
}

/**
 * Strictly parses a Faka confirm request payload. Same shape as the import
 * request plus a sourceHash that must be a 64-character lowercase hex string.
 * Reuses the shared field parser by splitting the exact base fields out of the
 * payload, so the extra sourceHash key does not trip the base key check.
 */
export function parseFakaConfirmRequest(value: unknown): FakaConfirmRequest {
  assertExactKeys(
    value,
    ['planId', 'productName', 'categoryId', 'cover', 'offers', 'sourceHash'],
    'Faka confirm request',
  );
  if (typeof value.sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.sourceHash)) {
    throw new Error('Faka confirm request: sourceHash must be a 64-character lowercase hex string');
  }
  const base: Record<string, unknown> = {
    planId: value.planId,
    productName: value.productName,
    categoryId: value.categoryId,
    cover: value.cover,
    offers: value.offers,
  };
  const parsed = parseFakaImportFields(base, 'Faka confirm request');
  return { ...parsed, sourceHash: value.sourceHash };
}

// ---------------------------------------------------------------------------
// Faka import preview response parser
// ---------------------------------------------------------------------------

export interface FakaPreviewCapacity {
  limit: number | null;
  activeUsers: number;
  remaining: number | null;
  sellable: boolean;
}

export interface FakaPreviewCover {
  imageUrl: string;
  images: string[];
}

export interface FakaPreviewOffer {
  period: string;
  sku: string;
  offerName: string;
  pricePoints: number;
  validityDays: number | null;
}

export interface FakaPreviewIssue {
  code: string;
  field: string;
  message: string;
}

export interface FakaPreviewResponse {
  sourceHash: string;
  capacity: FakaPreviewCapacity;
  productName: string;
  plainDescription: string;
  richDescription: string | null;
  cover: FakaPreviewCover | null;
  offers: FakaPreviewOffer[];
  issues: FakaPreviewIssue[];
  canConfirm: boolean;
}

/**
 * Strictly parses the Faka import preview response payload.
 * Top level must be exactly { sourceHash, capacity, productName,
 * plainDescription, richDescription, cover, offers, issues, canConfirm }:
 *   - sourceHash: 64-character lowercase hex string
 *   - capacity: exactly { limit, activeUsers, remaining, sellable } with
 *     limit/remaining null or non-negative integer, activeUsers non-negative
 *     integer, sellable boolean
 *   - productName: non-empty string
 *   - plainDescription: string
 *   - richDescription: string or null
 *   - cover: null or exactly { imageUrl, images } with non-empty string
 *     imageUrl and non-empty string array images whose first item equals
 *     imageUrl and contains no duplicates
 *   - offers: array; each item exactly { period, sku, offerName,
 *     pricePoints, validityDays } with non-empty strings period/sku/offerName,
 *     positive integer pricePoints, validityDays positive integer or null, and
 *     period/sku each unique across items
 *   - issues: array; each item exactly { code, field, message } with non-empty
 *     strings
 *   - canConfirm: boolean
 * Rejects any extra key. Returns a fully typed object.
 */
export function parseFakaPreviewResponse(value: unknown): FakaPreviewResponse {
  assertExactKeys(
    value,
    [
      'sourceHash',
      'capacity',
      'productName',
      'plainDescription',
      'richDescription',
      'cover',
      'offers',
      'issues',
      'canConfirm',
    ],
    'Faka preview response',
  );

  if (typeof value.sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.sourceHash)) {
    throw new Error('Faka preview response: sourceHash must be a 64-character lowercase hex string');
  }
  if (typeof value.productName !== 'string' || value.productName.length === 0) {
    throw new Error('Faka preview response: productName must be a non-empty string');
  }
  if (typeof value.plainDescription !== 'string') {
    throw new Error('Faka preview response: plainDescription must be a string');
  }
  if (value.richDescription !== null && typeof value.richDescription !== 'string') {
    throw new Error('Faka preview response: richDescription must be a string or null');
  }
  if (typeof value.canConfirm !== 'boolean') {
    throw new Error('Faka preview response: canConfirm must be a boolean');
  }

  assertExactKeys(
    value.capacity,
    ['limit', 'activeUsers', 'remaining', 'sellable'],
    'Faka preview response: capacity',
  );
  if (!isNullableNonNegativeInteger(value.capacity.limit)) {
    throw new Error('Faka preview response: capacity.limit must be null or a non-negative integer');
  }
  if (!isNonNegativeInteger(value.capacity.activeUsers)) {
    throw new Error('Faka preview response: capacity.activeUsers must be a non-negative integer');
  }
  if (!isNullableNonNegativeInteger(value.capacity.remaining)) {
    throw new Error('Faka preview response: capacity.remaining must be null or a non-negative integer');
  }
  if (typeof value.capacity.sellable !== 'boolean') {
    throw new Error('Faka preview response: capacity.sellable must be a boolean');
  }

  let cover: FakaPreviewCover | null = null;
  if (value.cover !== null) {
    assertExactKeys(value.cover, ['imageUrl', 'images'], 'Faka preview response: cover');
    if (typeof value.cover.imageUrl !== 'string' || value.cover.imageUrl.length === 0) {
      throw new Error('Faka preview response: cover.imageUrl must be a non-empty string');
    }
    if (!Array.isArray(value.cover.images)) {
      throw new Error('Faka preview response: cover.images must be a non-empty array');
    }
    if (value.cover.images.length === 0) {
      throw new Error('Faka preview response: cover.images must be a non-empty array');
    }
    const rawImages: unknown[] = value.cover.images;
    const seenImages = new Set<string>();
    const parsedImages: string[] = [];
    for (const image of rawImages) {
      if (typeof image !== 'string' || image.length === 0) {
        throw new Error('Faka preview response: cover.images must contain only non-empty strings');
      }
      if (seenImages.has(image)) {
        throw new Error(`Faka preview response: duplicate image "${image}" in cover.images`);
      }
      seenImages.add(image);
      parsedImages.push(image);
    }
    if (parsedImages[0] !== value.cover.imageUrl) {
      throw new Error('Faka preview response: cover.images[0] must equal cover.imageUrl');
    }
    cover = { imageUrl: value.cover.imageUrl, images: parsedImages };
  }

  if (!Array.isArray(value.offers)) {
    throw new Error('Faka preview response: offers must be an array');
  }
  const rawOffers: unknown[] = value.offers;
  const seenPeriods = new Set<string>();
  const seenSkus = new Set<string>();
  const parsedOffers: FakaPreviewOffer[] = [];
  for (const offer of rawOffers) {
    assertExactKeys(
      offer,
      ['period', 'sku', 'offerName', 'pricePoints', 'validityDays'],
      'Faka preview response: offers item',
    );
    if (typeof offer.period !== 'string' || offer.period.length === 0) {
      throw new Error('Faka preview response: offers item period must be a non-empty string');
    }
    if (seenPeriods.has(offer.period)) {
      throw new Error(`Faka preview response: duplicate period "${offer.period}" in offers`);
    }
    seenPeriods.add(offer.period);
    if (typeof offer.sku !== 'string' || offer.sku.length === 0) {
      throw new Error('Faka preview response: offers item sku must be a non-empty string');
    }
    if (seenSkus.has(offer.sku)) {
      throw new Error(`Faka preview response: duplicate sku "${offer.sku}" in offers`);
    }
    seenSkus.add(offer.sku);
    if (typeof offer.offerName !== 'string' || offer.offerName.length === 0) {
      throw new Error('Faka preview response: offers item offerName must be a non-empty string');
    }
    if (!isPositiveInteger(offer.pricePoints)) {
      throw new Error('Faka preview response: offers item pricePoints must be a positive integer');
    }
    if (offer.validityDays !== null && !isPositiveInteger(offer.validityDays)) {
      throw new Error('Faka preview response: offers item validityDays must be a positive integer or null');
    }
    parsedOffers.push({
      period: offer.period,
      sku: offer.sku,
      offerName: offer.offerName,
      pricePoints: offer.pricePoints,
      validityDays: offer.validityDays,
    });
  }
  const offers = parsedOffers;

  if (!Array.isArray(value.issues)) {
    throw new Error('Faka preview response: issues must be an array');
  }
  const rawIssues: unknown[] = value.issues;
  const parsedIssues: FakaPreviewIssue[] = [];
  for (const issue of rawIssues) {
    assertExactKeys(issue, ['code', 'field', 'message'], 'Faka preview response: issues item');
    if (typeof issue.code !== 'string' || issue.code.length === 0) {
      throw new Error('Faka preview response: issues item code must be a non-empty string');
    }
    if (typeof issue.field !== 'string' || issue.field.length === 0) {
      throw new Error('Faka preview response: issues item field must be a non-empty string');
    }
    if (typeof issue.message !== 'string' || issue.message.length === 0) {
      throw new Error('Faka preview response: issues item message must be a non-empty string');
    }
    parsedIssues.push({ code: issue.code, field: issue.field, message: issue.message });
  }

  return {
    sourceHash: value.sourceHash,
    capacity: {
      limit: value.capacity.limit,
      activeUsers: value.capacity.activeUsers,
      remaining: value.capacity.remaining,
      sellable: value.capacity.sellable,
    },
    productName: value.productName,
    plainDescription: value.plainDescription,
    richDescription: value.richDescription,
    cover,
    offers,
    issues: parsedIssues,
    canConfirm: value.canConfirm,
  };
}

// ---------------------------------------------------------------------------
// Faka import response parser + idempotency key
// ---------------------------------------------------------------------------

export interface FakaImportResponseOffer {
  period: string;
  sku: string;
  offerName: string;
  pricePoints: number;
}

export interface FakaImportResponse {
  productId: number;
  offerCount: number;
  offers: FakaImportResponseOffer[];
  replayed: boolean;
}

/**
 * Reads the mandatory `idempotency-key` request header and validates it.
 * The value must be a string; after trimming OWS (space/tab) it must match
 * `[A-Za-z0-9._:-]{1,128}`. Returns the trimmed value, otherwise throws.
 */
export function readIdempotencyKey(request: Request): string {
  const header = request.headers()['idempotency-key'];
  if (typeof header !== 'string') {
    throw new Error('idempotency-key header is required');
  }
  const trimmed = header.replace(/^[ \t]+|[ \t]+$/g, '');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(trimmed)) {
    throw new Error('idempotency-key header must match [A-Za-z0-9._:-]{1,128}');
  }
  return trimmed;
}

/**
 * Strictly parses the first Faka import response payload.
 * Top level must be exactly { productId, offerCount, offers, replayed }:
 *   - productId: positive integer
 *   - offerCount: positive integer
 *   - replayed: boolean (the parser does not enforce a specific value; the
 *     test asserts the expected replay semantics)
 *   - offers: array whose length must equal offerCount; each item exactly
 *     { period, sku, offerName, pricePoints } with non-empty strings
 *     period/sku/offerName, positive integer pricePoints, and period/sku
 *     each unique across items
 * Rejects any extra key. Returns a fully typed object.
 */
export function parseFakaImportResponse(value: unknown): FakaImportResponse {
  assertExactKeys(
    value,
    ['productId', 'offerCount', 'offers', 'replayed'],
    'Faka import response',
  );

  if (!isPositiveInteger(value.productId)) {
    throw new Error('Faka import response: productId must be a positive integer');
  }
  if (!isPositiveInteger(value.offerCount)) {
    throw new Error('Faka import response: offerCount must be a positive integer');
  }
  if (typeof value.replayed !== 'boolean') {
    throw new Error('Faka import response: replayed must be a boolean');
  }

  if (!Array.isArray(value.offers)) {
    throw new Error('Faka import response: offers must be an array');
  }
  const rawOffers: unknown[] = value.offers;
  if (rawOffers.length !== value.offerCount) {
    throw new Error('Faka import response: offers.length must equal offerCount');
  }

  const seenPeriods = new Set<string>();
  const seenSkus = new Set<string>();
  const parsedOffers: FakaImportResponseOffer[] = [];
  for (const offer of rawOffers) {
    assertExactKeys(
      offer,
      ['period', 'sku', 'offerName', 'pricePoints'],
      'Faka import response: offers item',
    );
    if (typeof offer.period !== 'string' || offer.period.length === 0) {
      throw new Error('Faka import response: offers item period must be a non-empty string');
    }
    if (seenPeriods.has(offer.period)) {
      throw new Error(`Faka import response: duplicate period "${offer.period}" in offers`);
    }
    seenPeriods.add(offer.period);
    if (typeof offer.sku !== 'string' || offer.sku.length === 0) {
      throw new Error('Faka import response: offers item sku must be a non-empty string');
    }
    if (seenSkus.has(offer.sku)) {
      throw new Error(`Faka import response: duplicate sku "${offer.sku}" in offers`);
    }
    seenSkus.add(offer.sku);
    if (typeof offer.offerName !== 'string' || offer.offerName.length === 0) {
      throw new Error('Faka import response: offers item offerName must be a non-empty string');
    }
    if (!isPositiveInteger(offer.pricePoints)) {
      throw new Error('Faka import response: offers item pricePoints must be a positive integer');
    }
    parsedOffers.push({
      period: offer.period,
      sku: offer.sku,
      offerName: offer.offerName,
      pricePoints: offer.pricePoints,
    });
  }

  return {
    productId: value.productId,
    offerCount: value.offerCount,
    offers: parsedOffers,
    replayed: value.replayed,
  };
}

// ---------------------------------------------------------------------------
// Admin products response parser (typed DTO)
// ---------------------------------------------------------------------------

/**
 * Asserts that `value` is a plain record containing at least every key in
 * `required`. Extra keys are allowed — the admin products wire DTO carries
 * fields this card does not care about; every required field is
 * type-validated by the caller.
 */
function assertHasKeys(
  value: unknown,
  required: readonly string[],
  context: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    const kind =
      value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value;
    throw new Error(`${context}: expected a plain object, got ${kind}`);
  }
  const missing = required.filter((key) => !(key in value));
  if (missing.length > 0) {
    throw new Error(`${context}: missing [${missing.join(', ')}]`);
  }
}

export interface AdminProductCapacityDto {
  sku: string;
  planId: number | null;
  capacityLimit: number | null;
  activeUsers: number | null;
  remaining: number | null;
  sellable: boolean;
  source: 'xboard' | 'unavailable';
}

export interface AdminProductOfferDto {
  id: number;
  name: string;
  status: string;
  isDefault: boolean;
  price: number;
  externalIntegration: string | null;
  externalSku: string | null;
}

export interface AdminProductDto {
  id: number;
  name: string;
  status: string;
  categoryId: number;
  merchantId: number | null;
  imageUrl: string | null;
  images: string[];
  price: number;
  fakaBridge: boolean;
  fakaCapacity: AdminProductCapacityDto | null;
  offers: AdminProductOfferDto[];
}

/**
 * Strictly parses a GET /api/admin/products response body (a JSON array).
 * Server product/offer objects may carry extra keys this card does not care
 * about, but every required field below is type-guarded:
 *   - product: id (positive integer, unique), name (non-empty string),
 *     status (non-empty string), categoryId (positive integer),
 *     merchantId (positive integer or null), imageUrl (non-empty string or
 *     null), images (array of non-empty strings), price (positive integer),
 *     fakaBridge (boolean), fakaCapacity (null or validated snapshot),
 *     offers (array of validated offers)
 *   - fakaCapacity (when not null): sku (non-empty string), planId (positive
 *     integer or null), capacityLimit/activeUsers/remaining (null or
 *     non-negative integer), sellable (boolean), source ("xboard" |
 *     "unavailable"). An optional `reason` is ignored.
 *   - offer: id (positive integer, unique), name (non-empty string), status
 *     (non-empty string), isDefault (boolean), price (positive integer),
 *     externalIntegration/externalSku (string or null).
 * Returns a fully typed minimal DTO.
 */
export function parseAdminProductsResponse(value: unknown): AdminProductDto[] {
  if (!Array.isArray(value)) {
    throw new Error('Admin products response: expected a JSON array');
  }
  const rawProducts: unknown[] = value;

  const parsedProducts: AdminProductDto[] = [];
  const seenProductIds = new Set<number>();

  for (const product of rawProducts) {
    assertHasKeys(
      product,
      [
        'id',
        'name',
        'status',
        'categoryId',
        'merchantId',
        'imageUrl',
        'images',
        'price',
        'fakaBridge',
        'fakaCapacity',
        'offers',
      ],
      'Admin products response: product',
    );

    if (!isPositiveInteger(product.id)) {
      throw new Error('Admin products response: product.id must be a positive integer');
    }
    if (seenProductIds.has(product.id)) {
      throw new Error(`Admin products response: duplicate product id ${product.id}`);
    }
    seenProductIds.add(product.id);

    if (typeof product.name !== 'string' || product.name.length === 0) {
      throw new Error('Admin products response: product.name must be a non-empty string');
    }
    if (typeof product.status !== 'string' || product.status.length === 0) {
      throw new Error('Admin products response: product.status must be a non-empty string');
    }
    if (!isPositiveInteger(product.categoryId)) {
      throw new Error('Admin products response: product.categoryId must be a positive integer');
    }
    if (product.merchantId !== null && !isPositiveInteger(product.merchantId)) {
      throw new Error('Admin products response: product.merchantId must be a positive integer or null');
    }
    if (product.imageUrl !== null && (typeof product.imageUrl !== 'string' || product.imageUrl.length === 0)) {
      throw new Error('Admin products response: product.imageUrl must be a non-empty string or null');
    }
    if (!isPositiveInteger(product.price)) {
      throw new Error('Admin products response: product.price must be a positive integer');
    }
    if (typeof product.fakaBridge !== 'boolean') {
      throw new Error('Admin products response: product.fakaBridge must be a boolean');
    }

    if (!Array.isArray(product.images)) {
      throw new Error('Admin products response: product.images must be an array');
    }
    const rawImages: unknown[] = product.images;
    const images: string[] = [];
    for (const image of rawImages) {
      if (typeof image !== 'string' || image.length === 0) {
        throw new Error('Admin products response: product.images must contain only non-empty strings');
      }
      images.push(image);
    }

    let fakaCapacity: AdminProductCapacityDto | null = null;
    if (product.fakaCapacity !== null) {
      assertHasKeys(
        product.fakaCapacity,
        ['sku', 'planId', 'capacityLimit', 'activeUsers', 'remaining', 'sellable', 'source'],
        'Admin products response: product.fakaCapacity',
      );
      const capacity = product.fakaCapacity;
      if (typeof capacity.sku !== 'string' || capacity.sku.length === 0) {
        throw new Error('Admin products response: fakaCapacity.sku must be a non-empty string');
      }
      if (capacity.planId !== null && !isPositiveInteger(capacity.planId)) {
        throw new Error('Admin products response: fakaCapacity.planId must be a positive integer or null');
      }
      if (!isNullableNonNegativeInteger(capacity.capacityLimit)) {
        throw new Error('Admin products response: fakaCapacity.capacityLimit must be null or a non-negative integer');
      }
      if (!isNullableNonNegativeInteger(capacity.activeUsers)) {
        throw new Error('Admin products response: fakaCapacity.activeUsers must be null or a non-negative integer');
      }
      if (!isNullableNonNegativeInteger(capacity.remaining)) {
        throw new Error('Admin products response: fakaCapacity.remaining must be null or a non-negative integer');
      }
      if (typeof capacity.sellable !== 'boolean') {
        throw new Error('Admin products response: fakaCapacity.sellable must be a boolean');
      }
      if (capacity.source !== 'xboard' && capacity.source !== 'unavailable') {
        throw new Error('Admin products response: fakaCapacity.source must be "xboard" or "unavailable"');
      }
      fakaCapacity = {
        sku: capacity.sku,
        planId: capacity.planId,
        capacityLimit: capacity.capacityLimit,
        activeUsers: capacity.activeUsers,
        remaining: capacity.remaining,
        sellable: capacity.sellable,
        source: capacity.source,
      };
    }

    if (!Array.isArray(product.offers)) {
      throw new Error('Admin products response: product.offers must be an array');
    }
    const rawOffers: unknown[] = product.offers;
    const seenOfferIds = new Set<number>();
    const offers: AdminProductOfferDto[] = [];
    for (const offer of rawOffers) {
      assertHasKeys(
        offer,
        ['id', 'name', 'status', 'isDefault', 'price', 'externalIntegration', 'externalSku'],
        'Admin products response: offers item',
      );
      if (!isPositiveInteger(offer.id)) {
        throw new Error('Admin products response: offers item id must be a positive integer');
      }
      if (seenOfferIds.has(offer.id)) {
        throw new Error(`Admin products response: duplicate offer id ${offer.id}`);
      }
      seenOfferIds.add(offer.id);
      if (typeof offer.name !== 'string' || offer.name.length === 0) {
        throw new Error('Admin products response: offers item name must be a non-empty string');
      }
      if (typeof offer.status !== 'string' || offer.status.length === 0) {
        throw new Error('Admin products response: offers item status must be a non-empty string');
      }
      if (typeof offer.isDefault !== 'boolean') {
        throw new Error('Admin products response: offers item isDefault must be a boolean');
      }
      if (!isPositiveInteger(offer.price)) {
        throw new Error('Admin products response: offers item price must be a positive integer');
      }
      if (offer.externalIntegration !== null && typeof offer.externalIntegration !== 'string') {
        throw new Error('Admin products response: offers item externalIntegration must be a string or null');
      }
      if (offer.externalSku !== null && typeof offer.externalSku !== 'string') {
        throw new Error('Admin products response: offers item externalSku must be a string or null');
      }
      offers.push({
        id: offer.id,
        name: offer.name,
        status: offer.status,
        isDefault: offer.isDefault,
        price: offer.price,
        externalIntegration: offer.externalIntegration,
        externalSku: offer.externalSku,
      });
    }

    parsedProducts.push({
      id: product.id,
      name: product.name,
      status: product.status,
      categoryId: product.categoryId,
      merchantId: product.merchantId,
      imageUrl: product.imageUrl,
      images,
      price: product.price,
      fakaBridge: product.fakaBridge,
      fakaCapacity,
      offers,
    });
  }

  return parsedProducts;
}
export async function ensureNetworkNodeDefaultCoverViaUi(page: Page): Promise<void> {
  const waitForCategoryList = () => page.waitForResponse((response) =>
    response.request().method() === 'GET'
    && new URL(response.url()).pathname === '/api/admin/product-categories'
  );
  const initialListPromise = waitForCategoryList();
  await page.getByRole('button', { name: '目录治理', exact: true }).click();
  const initialList = await initialListPromise;
  if (initialList.status() !== 200) throw new Error('initial category list failed');

  const pagination = page.getByTestId('admin-category-pagination');
  await pagination.waitFor({ state: 'visible' });
  let categoryId = '';
  while (true) {
    const row = page.locator('tbody tr').filter({ hasText: 'network-node' }).first();
    if (await row.isVisible()) {
      const testId = await row.getAttribute('data-testid');
      const match = /^category-row-([1-9][0-9]*)$/.exec(testId ?? '');
      if (!match) throw new Error('network-node row test id is invalid');
      categoryId = match[1];
      await page.getByTestId(`category-edit-${categoryId}`).click();
      break;
    }
    const nextButton = pagination.getByRole('button', { name: '下一页' });
    if (await nextButton.isDisabled()) throw new Error('network-node category not found');
    const nextListPromise = waitForCategoryList();
    await nextButton.click();
    const nextList = await nextListPromise;
    if (nextList.status() !== 200) throw new Error('next category list failed');
  }

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  const codeInput = dialog.getByTestId('category-form-code');
  const label = (await dialog.getByTestId('category-form-label').inputValue()).trim();
  const description = (await dialog.getByTestId('category-form-description').inputValue()).trim() || null;
  const iconKey = (await dialog.getByTestId('category-form-icon').inputValue()).trim() || null;
  const sortRaw = await dialog.getByTestId('category-form-sort').inputValue();
  if (await codeInput.inputValue() !== 'network-node' || !(await codeInput.isDisabled())) {
    throw new Error('network-node edit form is invalid');
  }
  if (!label || !/^(0|[1-9][0-9]*)$/.test(sortRaw)) throw new Error('category form is invalid');
  const sortOrder = Number(sortRaw);
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 1000000) {
    throw new Error('category sort is invalid');
  }
  await dialog.getByTestId('category-form-cover').fill('/assets/network.webp');

  let requestCount = 0;
  const onUpdate = (request: Request) => {
    if (request.method() === 'PATCH'
      && new URL(request.url()).pathname === `/api/admin/product-categories/${categoryId}`) {
      requestCount += 1;
    }
  };
  page.on('request', onUpdate);
  try {
    const updatePromise = page.waitForResponse((response) =>
      response.request().method() === 'PATCH'
      && new URL(response.url()).pathname === `/api/admin/product-categories/${categoryId}`
    );
    await dialog.getByTestId('category-form-submit').click();
    const update = await updatePromise;
    if (update.status() !== 200) throw new Error('category update failed');
    const body: unknown = update.request().postDataJSON();
    assertExactKeys(body, ['label', 'description', 'iconKey', 'defaultCoverUrl', 'sortOrder'], 'category update request');
    if (body.label !== label || body.description !== description || body.iconKey !== iconKey
      || body.defaultCoverUrl !== '/assets/network.webp' || body.sortOrder !== sortOrder) {
      throw new Error('category update payload mismatch');
    }
    if (requestCount !== 1) throw new Error('category update duplicate submit');
    await page.locator('[data-toast-card]', { hasText: '分类已更新' }).waitFor({ state: 'visible' });
    await dialog.waitFor({ state: 'detached' });
  } finally {
    page.off('request', onUpdate);
  }
}
test.describe.serial('Catalog Xboard import', () => {
  test('admin previews and confirms a sanitized Xboard draft via the real UI', async ({ page }) => {
    await resetXboardFixture();
    await loginAs(page, SEED_ACCOUNTS.admin);
    await page.goto('/admin');
    await ensureNetworkNodeDefaultCoverViaUi(page);

    await page.getByRole('button', { name: '商品与库存', exact: true }).click();

    const catalogResponsePromise = page.waitForResponse(isCatalogResponse);
    const registryResponsePromise = page.waitForResponse(isRegistryResponse);
    await page.getByTestId('admin-faka-import-open').click();

    const [catalogResponse, registryResponse] = await Promise.all([
      catalogResponsePromise,
      registryResponsePromise,
    ]);
    expect(catalogResponse.status()).toBe(200);
    expect(registryResponse.status()).toBe(200);

    const catalogBody: unknown = await catalogResponse.json();
    const catalog = parseFakaCatalogResponse(catalogBody);
    const goldPlan = catalog.plans.find((plan) => plan.plan_id === 77);
    expect(goldPlan).toEqual({
      plan_id: 77,
      name: 'Gold Plan',
      show: true,
      sell: true,
      capacity_limit: 200,
      active_users: 12,
      remaining: 188,
      periods: [
        { period: 'monthly', price: 3000, sku_alias: 'gold-monthly' },
        { period: 'yearly', price: 30000, sku_alias: 'gold-yearly' },
      ],
      named_skus: [
        { sku: 'gold-monthly', period: 'monthly' },
        { sku: 'gold-yearly', period: 'yearly' },
      ],
    });

    const registryBody: unknown = await registryResponse.json();
    const categories = parseCategoryRegistryResponse(registryBody);
    const networkNode = categories.find((category) => category.code === 'network-node');
    if (!networkNode) {
      throw new Error('active category registry is missing network-node');
    }

    await page.getByTestId('admin-faka-import-plan').selectOption('77');
    await page.getByTestId('product-category-select').selectOption(String(networkNode.id));

    const expectedRequest: FakaImportRequest = {
      planId: 77,
      productName: 'Gold Plan',
      categoryId: networkNode.id,
      cover: { mode: 'category_default' },
      offers: [
        { period: 'monthly', sku: 'gold-monthly', offerName: '月付', pricePoints: 300000 },
        { period: 'yearly', sku: 'gold-yearly', offerName: '年付', pricePoints: 3000000 },
      ],
    };

    const previewResponsePromise = page.waitForResponse(isImportPreviewResponse);
    await page.getByTestId('admin-faka-import-preview-submit').click();
    const previewResponse = await previewResponsePromise;
    expect(previewResponse.status()).toBe(200);
    const previewRequestBody: unknown = previewResponse.request().postDataJSON();
    expect(parseFakaImportRequest(previewRequestBody)).toEqual(expectedRequest);

    const previewBody: unknown = await previewResponse.json();
    const preview = parseFakaPreviewResponse(previewBody);
    expect(preview.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.capacity).toEqual({ limit: 200, activeUsers: 12, remaining: 188, sellable: true });
    expect(preview.productName).toBe('Gold Plan');
    expect(preview.cover).toEqual({ imageUrl: '/assets/network.webp', images: ['/assets/network.webp'] });
    expect(preview.offers).toEqual([
      { period: 'monthly', sku: 'gold-monthly', offerName: '月付', pricePoints: 300000, validityDays: null },
      { period: 'yearly', sku: 'gold-yearly', offerName: '年付', pricePoints: 3000000, validityDays: null },
    ]);
    expect(preview.issues).toEqual([]);
    expect(preview.canConfirm).toBe(true);

    const safeServerRichDescription = preview.richDescription ?? '';
    expect(safeServerRichDescription).toContain('Gold Plan');
    expect(safeServerRichDescription).toContain('每月 200GB 高速流量');
    expect(safeServerRichDescription).not.toMatch(/<script|<img|onerror|evil\.example\.com|javascript:/i);

    await expect(page.getByTestId('admin-faka-preview-result')).toBeVisible();
    const richPreview = page.getByTestId('admin-faka-rich-preview');
    await expect(richPreview).toBeVisible();
    await expect(richPreview).toContainText('Gold Plan');
    await expect(richPreview).toContainText('每月 200GB 高速流量');
    expect(await richPreview.innerHTML()).not.toMatch(/<script|<img|onerror|evil\.example\.com|javascript:/i);

    let confirmRequestCount = 0;
    const onConfirmRequest = (request: Request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/admin/faka/import') {
        confirmRequestCount += 1;
      }
    };
    page.on('request', onConfirmRequest);

    try {
      const importResponsePromise = page.waitForResponse(isImportResponse);
      // Capture the real admin products list refresh triggered by onImported()
      // after confirm — no direct business-API write and no browser reload.
      const productsResponsePromise = page.waitForResponse(isAdminProductsResponse);
      await page.getByTestId('admin-faka-import-submit').click({ clickCount: 2 });
      const importResponse = await importResponsePromise;
      expect(importResponse.status()).toBe(200);
      expect(confirmRequestCount).toBe(1);

      const confirmRequestBody: unknown = importResponse.request().postDataJSON();
      expect(parseFakaConfirmRequest(confirmRequestBody)).toEqual({ ...expectedRequest, sourceHash: preview.sourceHash });
      expect(readIdempotencyKey(importResponse.request())).not.toHaveLength(0);

      const importBody: unknown = await importResponse.json();
      const imported = parseFakaImportResponse(importBody);
      expect(imported.replayed).toBe(false);
      expect(imported.offerCount).toBe(2);
      expect(imported.offers).toEqual(preview.offers.map((offer) => ({
        period: offer.period,
        sku: offer.sku,
        offerName: offer.offerName,
        pricePoints: offer.pricePoints,
      })));

      const successMessage = `已创建 Xboard 商品草稿 #${imported.productId}（2 个规格）`;
      await expect(page.locator('[data-toast-card]').filter({ hasText: successMessage })).toBeVisible();
      await page.getByTestId('admin-faka-import-preview').waitFor({ state: 'detached' });

      // --- Admin products list back-check after the real onImported() refresh ---
      const productsResponse = await productsResponsePromise;
      expect(productsResponse.status()).toBe(200);
      const productsBody: unknown = await productsResponse.json();
      const products = parseAdminProductsResponse(productsBody);

      const importedProducts = products.filter((candidate) => candidate.id === imported.productId);
      expect(importedProducts).toHaveLength(1);
      const product = importedProducts[0]!;
      expect(product.id).toBe(imported.productId);
      expect(product.name).toBe('Gold Plan');
      expect(product.status).toBe('draft');
      expect(product.categoryId).toBe(networkNode.id);
      expect(product.merchantId).toBeNull();
      expect(product.imageUrl).toBe('/assets/network.webp');
      expect(product.images).toEqual(['/assets/network.webp']);
      expect(product.price).toBe(300000);
      expect(product.fakaBridge).toBe(true);
      expect(product.fakaCapacity).toEqual({
        sku: 'gold-monthly',
        planId: 77,
        capacityLimit: 200,
        activeUsers: 12,
        remaining: 188,
        sellable: true,
        source: 'xboard',
      });

      expect(product.offers).toHaveLength(2);
      expect(product.offers.filter((offer) => offer.isDefault)).toHaveLength(1);
      const monthlyOffer = product.offers.find((offer) => offer.externalSku === 'gold-monthly');
      const yearlyOffer = product.offers.find((offer) => offer.externalSku === 'gold-yearly');
      const assertOffer = (
        offer: AdminProductOfferDto | undefined,
        expected: { name: string; isDefault: boolean; price: number; externalSku: string },
      ) => {
        if (!offer) {
          throw new Error(`admin products back-check: missing offer "${expected.externalSku}"`);
        }
        expect(offer.id).toBeGreaterThan(0);
        expect(offer.name).toBe(expected.name);
        expect(offer.status).toBe('active');
        expect(offer.isDefault).toBe(expected.isDefault);
        expect(offer.price).toBe(expected.price);
        expect(offer.externalIntegration).toBe('faka_bridge');
        expect(offer.externalSku).toBe(expected.externalSku);
      };
      assertOffer(monthlyOffer, { name: '月付', isDefault: true, price: 300000, externalSku: 'gold-monthly' });
      assertOffer(yearlyOffer, { name: '年付', isDefault: false, price: 3000000, externalSku: 'gold-yearly' });

      // Real DOM table back-check: unique row located via the product name cell.
      const productRow = page.locator('tbody tr').filter({
        has: page.locator('td[data-label="商品名称"]').getByText('Gold Plan', { exact: true }),
      });
      await expect(productRow).toHaveCount(1);
      const nameCell = productRow.locator('td[data-label="商品名称"]');
      await expect(nameCell).toContainText('Gold Plan');
      await expect(nameCell).toContainText('FakaBridge · Xboard');
      await expect(productRow.locator('td[data-label="售价 (积分)"]')).toHaveText('300000');
      await expect(productRow.locator('td[data-label="可售资源"]')).toHaveText('Xboard 188/200（在用 12）');
    } finally {
      page.off('request', onConfirmRequest);
    }
  });
});
