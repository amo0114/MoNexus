import { describe, expect, it } from 'vitest'
import { CATALOG_ERROR_CODES } from '../types/catalog'
import {
  createCatalogGovernanceAdapter,
  getCatalogGovernanceErrorMessage,
  isCategoryApplicationAlreadyReviewed,
} from './catalogGovernance'
import {
  createCatalogGovernanceFixtureTransport,
  fixtureAdminCategories,
  fixtureApplicationList,
  fixtureApplications,
  fixtureCategoryList,
} from './catalogGovernance.fixtures'

function apiError(code: string) {
  return {
    response: { data: { error: { code, message: 'x' } } },
  }
}

describe('catalog governance adapter — admin category routes (spec §7.2)', () => {
  it('lists categories with the query params', async () => {
    const t = createCatalogGovernanceFixtureTransport({
      get: { '/admin/product-categories': fixtureCategoryList },
    })
    const adapter = createCatalogGovernanceAdapter(t)
    const result = await adapter.listCategories({ status: 'active', page: 2, pageSize: 10 })
    expect(result.total).toBe(fixtureAdminCategories.length)
    const call = t.calls.find((c) => c.method === 'get')
    expect(call?.url).toBe('/admin/product-categories')
    expect(call?.params).toEqual({ status: 'active', page: 2, pageSize: 10 })
  })

  it('creates a category with an allowlisted body (no merchantId/status)', async () => {
    const t = createCatalogGovernanceFixtureTransport({
      post: { '/admin/product-categories': { ...fixtureAdminCategories[0], id: 9 } },
    })
    const adapter = createCatalogGovernanceAdapter(t)
    const result = await adapter.createCategory({
      code: 'cloud-tool',
      label: '云工具',
      description: '云端工具',
      sortOrder: 60,
    })
    expect(result.id).toBe(9)
    const call = t.calls.find((c) => c.method === 'post')
    expect(call?.url).toBe('/admin/product-categories')
    expect(call?.body).toEqual({
      code: 'cloud-tool',
      label: '云工具',
      description: '云端工具',
      sortOrder: 60,
    })
  })

  it('runtime-strips unknown category fields even when an untyped caller bypasses TypeScript', async () => {
    const t = createCatalogGovernanceFixtureTransport({
      post: { '/admin/product-categories': fixtureAdminCategories[0] },
    })
    const adapter = createCatalogGovernanceAdapter(t)
    await adapter.createCategory({
      code: 'safe-code',
      label: '安全分类',
      status: 'active',
      normalizedLabel: 'should-not-leave-client',
    } as never)
    expect(t.calls[0]?.body).toEqual({ code: 'safe-code', label: '安全分类' })
  })

  it('updates a category without ever sending `code` (D-CAT-06)', async () => {
    const t = createCatalogGovernanceFixtureTransport({
      patch: { '/admin/product-categories/3': { ...fixtureAdminCategories[2], label: '充值卡' } },
    })
    const adapter = createCatalogGovernanceAdapter(t)
    const result = await adapter.updateCategory(3, { label: '充值卡' })
    expect(result.label).toBe('充值卡')
    const call = t.calls.find((c) => c.method === 'patch')
    expect(call?.url).toBe('/admin/product-categories/3')
    expect(call?.body).toEqual({ label: '充值卡' })
    expect(JSON.stringify(call?.body)).not.toContain('code')
  })

  it('activates/deactivates via the CAS endpoints', async () => {
    const t = createCatalogGovernanceFixtureTransport({
      post: {
        '/admin/product-categories/2/deactivate': { ...fixtureAdminCategories[1], status: 'inactive' },
        '/admin/product-categories/2/activate': { ...fixtureAdminCategories[1], status: 'active' },
      },
    })
    const adapter = createCatalogGovernanceAdapter(t)
    await expect(adapter.deactivateCategory(2)).resolves.toMatchObject({ status: 'inactive' })
    await expect(adapter.activateCategory(2)).resolves.toMatchObject({ status: 'active' })
  })

  it('reorders with the full orderedIds body', async () => {
    const t = createCatalogGovernanceFixtureTransport({
      post: { '/admin/product-categories/reorder': { updated: 4 } },
    })
    const adapter = createCatalogGovernanceAdapter(t)
    const result = await adapter.reorderCategories([2, 1, 3, 4])
    expect(result.updated).toBe(4)
    const call = t.calls.find((c) => c.method === 'post')
    expect(call?.url).toBe('/admin/product-categories/reorder')
    expect(call?.body).toEqual({ orderedIds: [2, 1, 3, 4] })
  })

  it('logical-deletes (tombstone) via DELETE', async () => {
    const t = createCatalogGovernanceFixtureTransport({
      delete: { '/admin/product-categories/5': { deleted: true, id: 5 } },
    })
    const adapter = createCatalogGovernanceAdapter(t)
    await expect(adapter.deleteCategory(5)).resolves.toEqual({ deleted: true, id: 5 })
    expect(t.calls.some((c) => c.method === 'delete' && c.url === '/admin/product-categories/5')).toBe(true)
  })
})

describe('catalog governance adapter — application review routes (spec §7.3)', () => {
  it('lists admin applications with status + merchantId filters', async () => {
    const t = createCatalogGovernanceFixtureTransport({
      get: { '/admin/category-applications': fixtureApplicationList },
    })
    const adapter = createCatalogGovernanceAdapter(t)
    const result = await adapter.listAdminApplications({ status: 'pending', merchantId: 7, page: 1 })
    expect(result.total).toBe(fixtureApplications.length)
    const call = t.calls.find((c) => c.method === 'get')
    expect(call?.params).toEqual({ status: 'pending', merchantId: 7, page: 1 })
  })

  it('approves via create_new with the frozen body shape', async () => {
    const t = createCatalogGovernanceFixtureTransport({
      post: { '/admin/category-applications/101/approve': { ...fixtureApplications[0], status: 'approved', resolution: 'create_new', approvedCategoryId: 9 } },
    })
    const adapter = createCatalogGovernanceAdapter(t)
    const result = await adapter.approveApplication(101, {
      resolution: 'create_new',
      category: { code: 'cloud-tool', label: '云工具', description: '云端工具' },
      reviewReason: '符合平台目录',
    })
    expect(result.status).toBe('approved')
    const call = t.calls.find((c) => c.method === 'post')
    expect(call?.body).toEqual({
      resolution: 'create_new',
      category: { code: 'cloud-tool', label: '云工具', description: '云端工具' },
      reviewReason: '符合平台目录',
    })
  })

  it('runtime-strips internal fields from nested approval payloads', async () => {
    const t = createCatalogGovernanceFixtureTransport({
      post: { '/admin/category-applications/101/approve': fixtureApplications[0] },
    })
    const adapter = createCatalogGovernanceAdapter(t)
    await adapter.approveApplication(101, {
      resolution: 'create_new',
      category: { code: 'safe-code', label: '安全分类', status: 'active' },
      reviewReason: '目录合理',
      reviewedByUserId: 999,
    } as never)
    expect(t.calls[0]?.body).toEqual({
      resolution: 'create_new',
      category: { code: 'safe-code', label: '安全分类' },
      reviewReason: '目录合理',
    })
  })

  it('approves via map_existing with the frozen body shape (no duplicate category)', async () => {
    const t = createCatalogGovernanceFixtureTransport({
      post: { '/admin/category-applications/101/approve': { ...fixtureApplications[0], status: 'approved', resolution: 'map_existing', approvedCategoryId: 2 } },
    })
    const adapter = createCatalogGovernanceAdapter(t)
    const result = await adapter.approveApplication(101, { resolution: 'map_existing', categoryId: 2, reviewReason: '已存在等价分类' })
    expect(result.approvedCategoryId).toBe(2)
    const call = t.calls.find((c) => c.method === 'post')
    expect(call?.body).toEqual({ resolution: 'map_existing', categoryId: 2, reviewReason: '已存在等价分类' })
  })

  it('rejects with a required review reason', async () => {
    const t = createCatalogGovernanceFixtureTransport({
      post: { '/admin/category-applications/101/reject': { ...fixtureApplications[0], status: 'rejected' } },
    })
    const adapter = createCatalogGovernanceAdapter(t)
    await expect(adapter.rejectApplication(101, { reviewReason: '与现有分类重复' })).resolves.toMatchObject({ status: 'rejected' })
    const call = t.calls.find((c) => c.method === 'post')
    expect(call?.body).toEqual({ reviewReason: '与现有分类重复' })
  })
})

describe('catalog governance adapter — merchant application routes (spec §7.3)', () => {
  it('lists only my applications (ownership is server-side)', async () => {
    const t = createCatalogGovernanceFixtureTransport({
      get: { '/merchant/category-applications': fixtureApplicationList },
    })
    const adapter = createCatalogGovernanceAdapter(t)
    const result = await adapter.listMyApplications({ status: 'pending', page: 1, pageSize: 10 })
    expect(result.total).toBe(fixtureApplications.length)
    const call = t.calls.find((c) => c.method === 'get')
    expect(call?.url).toBe('/merchant/category-applications')
    expect(call?.params).toEqual({ status: 'pending', page: 1, pageSize: 10 })
  })

  it('creates an application WITHOUT merchantId in the body (auth-derived)', async () => {
    const t = createCatalogGovernanceFixtureTransport({
      post: { '/merchant/category-applications': { ...fixtureApplications[0], id: 200 } },
    })
    const adapter = createCatalogGovernanceAdapter(t)
    const result = await adapter.createApplication({
      proposedLabel: '云工具',
      description: '各类云端工具与效率应用的代充或账号服务',
    })
    expect(result.id).toBe(200)
    const call = t.calls.find((c) => c.method === 'post')
    expect(call?.url).toBe('/merchant/category-applications')
    expect(call?.body).toEqual({
      proposedLabel: '云工具',
      description: '各类云端工具与效率应用的代充或账号服务',
    })
    expect(JSON.stringify(call?.body)).not.toContain('merchantId')
    expect(JSON.stringify(call?.body)).not.toContain('status')
  })

  it('withdraws a pending application via the CAS endpoint', async () => {
    const t = createCatalogGovernanceFixtureTransport({
      post: { '/merchant/category-applications/101/withdraw': { ...fixtureApplications[0], status: 'withdrawn' } },
    })
    const adapter = createCatalogGovernanceAdapter(t)
    await expect(adapter.withdrawApplication(101)).resolves.toMatchObject({ status: 'withdrawn' })
    const call = t.calls.find((c) => c.method === 'post')
    expect(call?.url).toBe('/merchant/category-applications/101/withdraw')
  })
})

describe('stable error copy (keyed off codes, never prose)', () => {
  it('maps every landed governance code to stable Chinese copy', () => {
    expect(getCatalogGovernanceErrorMessage(apiError(CATALOG_ERROR_CODES.CATEGORY_CODE_IMMUTABLE), 'f')).toBe('分类编码创建后不可修改')
    expect(getCatalogGovernanceErrorMessage(apiError(CATALOG_ERROR_CODES.CATEGORY_CODE_TAKEN), 'f')).toBe('分类编码已存在，且停用后不可复用')
    expect(getCatalogGovernanceErrorMessage(apiError(CATALOG_ERROR_CODES.CATEGORY_LABEL_TAKEN), 'f')).toBe('分类名称已存在')
    expect(getCatalogGovernanceErrorMessage(apiError(CATALOG_ERROR_CODES.CATEGORY_REFERENCED), 'f')).toBe('该分类已被商品或申请引用，无法删除；可先停用该分类')
    expect(getCatalogGovernanceErrorMessage(apiError(CATALOG_ERROR_CODES.CATEGORY_APPLICATION_PENDING_DUPLICATE), 'f')).toBe('你已有一个相同名称的分类申请在审核中')
    expect(getCatalogGovernanceErrorMessage(apiError(CATALOG_ERROR_CODES.CATEGORY_APPLICATION_ALREADY_REVIEWED), 'f')).toBe('该申请已被审核或已撤回，无法重复操作')
    expect(getCatalogGovernanceErrorMessage(apiError(CATALOG_ERROR_CODES.CATEGORY_APPLICATION_MAP_TARGET_INACTIVE), 'f')).toBe('只能映射到启用中的分类；请先启用该分类或选择其他分类')
  })

  it('falls back to the API message or the fallback for unknown codes', () => {
    // Unknown code: the API-provided message is preferred over the fallback.
    expect(getCatalogGovernanceErrorMessage(apiError('UNKNOWN_CODE'), 'fallback')).toBe('x')
    expect(getCatalogGovernanceErrorMessage({}, 'fallback')).toBe('fallback')
  })

  it('detects the review/withdraw race via the stable code', () => {
    expect(isCategoryApplicationAlreadyReviewed(apiError(CATALOG_ERROR_CODES.CATEGORY_APPLICATION_ALREADY_REVIEWED))).toBe(true)
    expect(isCategoryApplicationAlreadyReviewed(apiError(CATALOG_ERROR_CODES.CATEGORY_REFERENCED))).toBe(false)
    expect(isCategoryApplicationAlreadyReviewed({})).toBe(false)
  })
})
