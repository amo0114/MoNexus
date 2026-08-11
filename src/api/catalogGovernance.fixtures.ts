/**
 * Catalog governance contract fixtures (T-CAT-FE-003).
 *
 * Typed fixture data for the landed category/application DTOs plus a fixture
 * transport factory for the governance adapter. These are TEST fixtures — the
 * production adapter accepts them via `createCatalogGovernanceAdapter`, so
 * component/contract tests never depend on a live backend.
 *
 * No fake fields: every value matches the frozen DTOs (CategoryAdminDto /
 * CategoryApplicationDto) and the landed server schemas. Internal fields such
 * as normalizedLabel / reviewedByUserId are intentionally NOT present.
 */
import type {
  CategoryAdminDto,
  CategoryApplicationDto,
} from '../types/catalog'
import type {
  CategoryAdminListResult,
  CategoryApplicationListResult,
} from '../types/catalogGovernance'
import type { CatalogGovernanceTransport } from './catalogGovernance'

/* ------------------------------------------------------------------ *
 * Category fixtures (spec §7.2)
 * ------------------------------------------------------------------ */

export const fixtureAdminCategories: CategoryAdminDto[] = [
  {
    id: 1, code: 'network-node', label: '网络节点', normalizedLabel: '网络节点',
    iconKey: 'network', defaultCoverUrl: '/assets/network.webp', sortOrder: 10,
    description: '各类网络节点、机场类服务', status: 'active',
    createdByUserId: 1, updatedByUserId: 1,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 2, code: 'shared-account', label: '共享账号', normalizedLabel: '共享账号',
    iconKey: 'user-round', defaultCoverUrl: null, sortOrder: 20,
    description: null, status: 'active',
    createdByUserId: 1, updatedByUserId: 1,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 3, code: 'recharge-card', label: '充值卡密', normalizedLabel: '充值卡密',
    iconKey: 'credit-card', defaultCoverUrl: null, sortOrder: 30,
    description: null, status: 'active',
    createdByUserId: 1, updatedByUserId: 1,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 4, code: 'invite-code', label: '邀请码', normalizedLabel: '邀请码',
    iconKey: 'file-text', defaultCoverUrl: null, sortOrder: 40,
    description: null, status: 'active',
    createdByUserId: 1, updatedByUserId: 1,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  },
  // Inactive historical category — legacy-unclassified (seeded, spec §11.2).
  {
    id: 5, code: 'legacy-unclassified', label: '待归类', normalizedLabel: '待归类',
    iconKey: null, defaultCoverUrl: null, sortOrder: 50,
    description: '历史数据未能映射到正式分类的商品', status: 'inactive',
    createdByUserId: 1, updatedByUserId: 1,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  },
]

export const fixtureCategoryList: CategoryAdminListResult = {
  items: fixtureAdminCategories,
  total: fixtureAdminCategories.length,
  page: 1,
  pageSize: 10,
}

/* ------------------------------------------------------------------ *
 * Application fixtures (spec §7.3)
 * ------------------------------------------------------------------ */

export const fixtureApplications: CategoryApplicationDto[] = [
  {
    id: 101, merchantId: 7, proposedLabel: '云工具', proposedCode: 'cloud-tool',
    description: '各类云端工具与效率应用的代充或账号服务', exampleProducts: null,
    status: 'pending', resolution: null, approvedCategoryId: null,
    reviewedAt: null, reviewReason: null,
    createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:00:00.000Z',
  },
  {
    id: 102, merchantId: 8, proposedLabel: '会员代充', proposedCode: null,
    description: '各类会员订阅的代充服务，覆盖多个平台', exampleProducts: '视频会员、音乐会员',
    status: 'approved', resolution: 'create_new', approvedCategoryId: 9,
    reviewedAt: '2026-08-06T00:00:00.000Z', reviewReason: '符合平台目录',
    createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z',
  },
  {
    id: 103, merchantId: 7, proposedLabel: '话费充值', proposedCode: 'phone-recharge',
    description: '国内话费与流量充值服务，覆盖主要运营商', exampleProducts: null,
    status: 'rejected', resolution: null, approvedCategoryId: null,
    reviewedAt: '2026-08-06T00:00:00.000Z', reviewReason: '与现有充值卡密分类重复',
    createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z',
  },
  {
    id: 104, merchantId: 9, proposedLabel: '游戏代练', proposedCode: 'game-boost',
    description: '游戏代练与陪玩服务，覆盖主流游戏', exampleProducts: null,
    status: 'withdrawn', resolution: null, approvedCategoryId: null,
    reviewedAt: null, reviewReason: null,
    createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z',
  },
]

export const fixtureApplicationList: CategoryApplicationListResult = {
  items: fixtureApplications,
  total: fixtureApplications.length,
  page: 1,
  pageSize: 10,
}

/* ------------------------------------------------------------------ *
 * Fixture transport
 * ------------------------------------------------------------------ */

export interface GovernanceFixtureRouteMap {
  get?: Record<string, unknown | ((params: Record<string, unknown>) => unknown | Promise<unknown>)>
  post?: Record<string, unknown | ((body: unknown) => unknown | Promise<unknown>)>
  patch?: Record<string, unknown | ((body: unknown) => unknown | Promise<unknown>)>
  delete?: Record<string, unknown | (() => unknown | Promise<unknown>)>
}

export interface GovernanceFixtureCall {
  method: 'get' | 'post' | 'patch' | 'delete'
  url: string
  params?: Record<string, unknown>
  body?: unknown
}

/**
 * Build an in-memory `CatalogGovernanceTransport` from a route map. A route
 * value may be a plain value or a function of the params/body. Unknown routes
 * throw so a stale fixture never silently returns `undefined`.
 */
export function createCatalogGovernanceFixtureTransport(
  routes: GovernanceFixtureRouteMap = {},
): CatalogGovernanceTransport & { calls: GovernanceFixtureCall[] } {
  const calls: GovernanceFixtureCall[] = []

  async function resolve(
    method: 'get' | 'post' | 'patch' | 'delete',
    url: string,
    value: unknown,
    extra: { params?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<unknown> {
    calls.push({ method, url, params: extra.params, body: extra.body })
    if (value === undefined) {
      throw new Error(`catalog governance fixture: no route for ${method.toUpperCase()} ${url}`)
    }
    return typeof value === 'function'
      ? (value as (arg: unknown) => unknown)(extra.params ?? extra.body)
      : value
  }

  return {
    calls,
    async get(url, params) {
      const value = routes.get?.[url]
      return resolve('get', url, value, { params }) as never
    },
    async post(url, body) {
      const value = routes.post?.[url]
      return resolve('post', url, value, { body }) as never
    },
    async patch(url, body) {
      const value = routes.patch?.[url]
      return resolve('patch', url, value, { body }) as never
    },
    async delete(url) {
      const value = routes.delete?.[url]
      return resolve('delete', url, value) as never
    },
  }
}
