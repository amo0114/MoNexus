/**
 * Catalog contract fixtures (T-CAT-FE-001A).
 *
 * Typed fixture data for the frozen catalog DTOs plus a fixture transport
 * factory. These are TEST/ADAPTER fixtures — the production adapter accepts
 * them via `createCatalogAdapter(transport)` so component/contract tests and
 * later host cards (001B+) never depend on the not-yet-landed backend.
 *
 * No fake fields: every value below matches the frozen contracts in
 * `../types/catalog` and the spec examples (§6.1, §7.1, §8.3).
 */
import type {
  AvailabilityOffer,
  CategoryRegistryItem,
  PublicationReadiness,
  VoidInventoryResponse,
} from '../types/catalog'
import type { CatalogTransport } from './catalog'
import {
  READINESS_DETAIL_CODES,
  PRODUCT_STATUS,
  type CatalogDraftProduct,
  type ReadinessIssue,
} from '../types/catalog'

/* ------------------------------------------------------------------ *
 * Frozen example data (spec §7.1)
 * ------------------------------------------------------------------ */

export const catalogFixtureCategories: CategoryRegistryItem[] = [
  { id: 1, code: 'network-node', label: '网络节点', iconKey: 'network', sortOrder: 10 },
  { id: 2, code: 'shared-account', label: '共享账号', iconKey: 'user-round', sortOrder: 20 },
  { id: 3, code: 'recharge-card', label: '充值卡密', iconKey: 'credit-card', sortOrder: 30 },
  { id: 4, code: 'invite-code', label: '邀请码', iconKey: 'file-text', sortOrder: 40 },
]

/* ------------------------------------------------------------------ *
 * Readiness fixtures (spec §6.1)
 * ------------------------------------------------------------------ */

export const catalogFixtureReadinessNotReady: PublicationReadiness = {
  ready: false,
  productId: 101,
  issues: [
    { code: READINESS_DETAIL_CODES.COVER_REQUIRED, field: 'images', offerId: null },
    { code: READINESS_DETAIL_CODES.OFFER_NOT_SELLABLE, field: 'offers', offerId: 42 },
  ] satisfies ReadinessIssue[],
}

export const catalogFixtureReadinessReady: PublicationReadiness = {
  ready: true,
  productId: 101,
  issues: [],
}

/* ------------------------------------------------------------------ *
 * Draft product fixture (spec §6.2 / §7.4)
 * ------------------------------------------------------------------ */

export const catalogFixtureDraftProduct: CatalogDraftProduct = {
  id: 101,
  name: '示例节点套餐',
  categoryId: 1,
  type: '网络节点',
  status: PRODUCT_STATUS.DRAFT,
  publishedAt: null,
  category: { id: 1, code: 'network-node', label: '网络节点' },
}

/* ------------------------------------------------------------------ *
 * Void / capacity fixtures (spec §8.3)
 * ------------------------------------------------------------------ */

export const catalogFixtureVoidResponse: VoidInventoryResponse = {
  offerId: 42,
  voided: 3,
  availableStock: 7,
  productAvailableStock: 19,
}

/* ------------------------------------------------------------------ *
 * Availability offers (spec §8.1 action matrix)
 * ------------------------------------------------------------------ */

export const catalogFixtureOffers: AvailabilityOffer[] = [
  { id: 42, name: '月卡', deliveryMode: 'instant_inventory', stockMode: 'limited', availableStock: 7, status: 'active' },
  { id: 43, name: '季卡', deliveryMode: 'instant_fixed', stockMode: 'limited', stock: 5, status: 'active' },
  { id: 44, name: '终身卡', deliveryMode: 'instant_fixed', stockMode: 'unlimited', status: 'active' },
]

/* ------------------------------------------------------------------ *
 * Fixture transport
 * ------------------------------------------------------------------ */

export interface FixtureTransportRouteMap {
  get?: Record<string, unknown | (() => unknown | Promise<unknown>)>
  post?: Record<string, unknown | ((body: unknown) => unknown | Promise<unknown>)>
}

/**
 * Build an in-memory `CatalogTransport` from a route map. A route value may be
 * a plain value or a function of the request body. Unknown routes throw so a
 * stale fixture never silently returns `undefined`.
 */
export function createCatalogFixtureTransport(routes: FixtureTransportRouteMap = {}): CatalogTransport & {
  calls: Array<{ method: 'get' | 'post'; url: string; body?: unknown }>
} {
  const calls: Array<{ method: 'get' | 'post'; url: string; body?: unknown }> = []

  async function resolve(method: 'get' | 'post', url: string, body?: unknown): Promise<unknown> {
    calls.push({ method, url, body })
    const table = routes[method]
    const value = table?.[url]
    if (value === undefined) {
      throw new Error(`catalog fixture: no route for ${method.toUpperCase()} ${url}`)
    }
    return typeof value === 'function' ? (value as (b: unknown) => unknown)(body) : value
  }

  return {
    calls,
    async get(url) {
      return resolve('get', url) as never
    },
    async post(url, body) {
      return resolve('post', url, body) as never
    },
  }
}
