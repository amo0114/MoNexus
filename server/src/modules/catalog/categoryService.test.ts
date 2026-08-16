// T-CAT-BE-001 — Category repository/admin governance Red tests
// (SPEC-CATALOG-OPS-001 §7.1/§7.2; D-CAT-06/D-CAT-07; REQ-CAT-F-007;
// CHK-CAT-001~004; AC-CAT-010~011). DB-backed — run by the coordinator against
// the dedicated monexus_test_catalog_ops_be database.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { __resetCacheForTests, getCacheVersion } from '../../lib/cache.js'
import { __resetRedisForTests, __setRedisForTests } from '../../lib/redis.js'
import { config } from '../../config/index.js'
import { ensureSeedCategories } from './bootstrap.js'
import {
  activateCategory,
  createCategory,
  deactivateCategory,
  deleteCategory,
  listAdminCategories,
  reorderCategories,
  updateCategory,
} from './categoryService.js'
import { getPublicCategoryRegistry } from './registry.js'
import { CATALOG_ERROR_CODES, SEED_CATEGORY_CODE } from './constants.js'

// Every direct category create is an ACTIVE category → needs a resolvable cover.
const COVER_URL = '/assets/network.webp'

async function seedActor(): Promise<number> {
  const user = await prisma.user.create({
    data: { email: 'category-service-actor@test.local', password: 'x', role: 'admin' },
  })
  return user.id
}

async function categoryIdByCode(code: string): Promise<number> {
  const row = await prisma.productCategory.findUniqueOrThrow({ where: { code } })
  return row.id
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function waitForRowLockWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND wait_event_type = 'Lock'
    `
    if (Number(rows[0]?.count ?? 0) > 0) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('barrier: no category mutation waited on the row lock')
}

describe('categoryService — create', () => {
  it('creates an active category with normalized label, canonical uniqueness and AdminLog', async () => {
    const actorId = await seedActor()
    const dto = await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'cloud-tool', label: ' 云工具 ', sortOrder: 15 })

    expect(dto).toMatchObject({
      code: 'cloud-tool',
      label: ' 云工具 ',
      normalizedLabel: '云工具',
      sortOrder: 15,
      status: 'active',
    })
    expect(dto.id).toBeGreaterThan(0)

    const row = await prisma.productCategory.findUniqueOrThrow({ where: { id: dto.id } })
    expect(row.createdByUserId).toBe(actorId)
    expect(row.updatedByUserId).toBe(actorId)

    const log = await prisma.adminLog.findFirstOrThrow({
      where: { targetType: 'productCategory', targetId: dto.id, action: '创建分类' },
    })
    expect(log.adminUserId).toBe(actorId)
    expect(log.detail).toContain('cloud-tool')
    expect(log.detail).not.toContain('云工具')
  })

  it('rejects a reused code (409, code is never reused even after deactivation)', async () => {
    const actorId = await seedActor()
    await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'cloud-tool', label: '云工具' })
    await deactivateCategory(actorId, await categoryIdByCode('cloud-tool'))

    await expect(createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'cloud-tool', label: '另一个名字' }))
      .rejects.toMatchObject({ status: 409, code: CATALOG_ERROR_CODES.CATEGORY_CODE_TAKEN })
  })

  it('rejects a duplicate normalized label (409)', async () => {
    const actorId = await seedActor()
    await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'dup-a', label: ' 云工具 ' })
    await expect(createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'dup-b', label: '云工具' }))
      .rejects.toMatchObject({ status: 409, code: CATALOG_ERROR_CODES.CATEGORY_LABEL_TAKEN })
  })
})

describe('categoryService — update', () => {
  it('renames label and updates normalizedLabel without touching immutable code', async () => {
    const actorId = await seedActor()
    const dto = await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'upd-test', label: '旧名字' })

    const updated = await updateCategory(actorId, dto.id, { label: ' 新名字 ' })
    expect(updated.label).toBe(' 新名字 ')
    expect(updated.normalizedLabel).toBe('新名字')
    expect(updated.code).toBe('upd-test')
  })

  it('renames label without rewriting existing Product.type / Order snapshot history (CHK-CAT-010)', async () => {
    const actorId = await seedActor()
    const dto = await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'snap-test', label: '历史标签' })
    const buyer = await prisma.user.create({ data: { email: 'snap-buyer@test.local', password: 'x', role: 'user' } })
    const product = await prisma.product.create({
      data: { name: '历史商品', type: dto.label, price: 100, categoryId: dto.id },
    })
    const order = await prisma.order.create({
      data: { userId: buyer.id, productId: product.id, productTypeSnapshot: dto.label, price: 100 },
    })

    const updated = await updateCategory(actorId, dto.id, { label: '新历史标签' })
    expect(updated.label).toBe('新历史标签')

    // The label snapshot captured at write time must survive the rename: neither
    // the Product.type legacy snapshot nor the Order.productTypeSnapshot is
    // rewritten (D-CAT-06 snapshot contract).
    const afterProduct = await prisma.product.findUniqueOrThrow({ where: { id: product.id } })
    expect(afterProduct.type).toBe('历史标签')
    const afterOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(afterOrder.productTypeSnapshot).toBe('历史标签')
  })

  it('rejects a duplicate normalized label (409)', async () => {
    const actorId = await seedActor()
    const a = await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'dup-a', label: '名字A' })
    await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'dup-b', label: '名字B' })

    await expect(updateCategory(actorId, a.id, { label: '名字B' }))
      .rejects.toMatchObject({ status: 409, code: CATALOG_ERROR_CODES.CATEGORY_LABEL_TAKEN })
  })

  it('rejects code mutation at the service boundary (defense in depth)', async () => {
    const actorId = await seedActor()
    const dto = await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'immutable', label: '不可变' })

    await expect(updateCategory(actorId, dto.id, { code: 'hacked' } as never))
      .rejects.toMatchObject({ status: 400, code: CATALOG_ERROR_CODES.CATEGORY_CODE_IMMUTABLE })
  })

  it('returns 404 for a missing id', async () => {
    const actorId = await seedActor()
    await expect(updateCategory(actorId, 999_999, { label: 'x' }))
      .rejects.toMatchObject({ status: 404 })
  })
})

describe('categoryService — status CAS', () => {
  it('transitions active↔inactive and is idempotent without redundant logs', async () => {
    const actorId = await seedActor()
    const dto = await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'cas-test', label: 'CAS测试' })

    const deactivated = await deactivateCategory(actorId, dto.id)
    expect(deactivated.status).toBe('inactive')

    const reactivated = await activateCategory(actorId, dto.id)
    expect(reactivated.status).toBe('active')

    // Idempotent: activating an already-active row is a no-op.
    const again = await activateCategory(actorId, dto.id)
    expect(again.status).toBe('active')

    const logs = await prisma.adminLog.findMany({
      where: { targetType: 'productCategory', targetId: dto.id },
    })
    expect(logs.filter(l => l.action === '启用分类')).toHaveLength(1)
    expect(logs.filter(l => l.action === '停用分类')).toHaveLength(1)
  })

  it('returns 404 for a missing id', async () => {
    const actorId = await seedActor()
    await expect(activateCategory(actorId, 999_999)).rejects.toMatchObject({ status: 404 })
  })
})

describe('categoryService — status/cover concurrency', () => {
  it('rejects cover removal queued behind an uncommitted activation', async () => {
    const actorId = await seedActor()
    const category = await createCategory(actorId, {
      defaultCoverUrl: COVER_URL,
      code: 'race-activate-remove',
      label: '并发激活移除',
    })
    await deactivateCategory(actorId, category.id)

    const release = deferred()
    const activationApplied = deferred()
    const activation = prisma.$transaction(async tx => {
      await activateCategory(actorId, category.id, tx)
      activationApplied.resolve()
      await release.promise
    })
    await activationApplied.promise

    const removal = updateCategory(actorId, category.id, { defaultCover: null })
    try {
      await waitForRowLockWaiter()
    } finally {
      release.resolve()
    }
    await activation
    await expect(removal).rejects.toMatchObject({
      status: 400,
      code: CATALOG_ERROR_CODES.COVER_REQUIRED,
    })

    const row = await prisma.productCategory.findUniqueOrThrow({ where: { id: category.id } })
    expect(row).toMatchObject({ status: 'active', defaultCoverUrl: COVER_URL })
  })

  it('rejects activation queued behind an uncommitted cover removal', async () => {
    const actorId = await seedActor()
    const category = await createCategory(actorId, {
      defaultCoverUrl: COVER_URL,
      code: 'race-remove-activate',
      label: '并发移除激活',
    })
    await deactivateCategory(actorId, category.id)

    const release = deferred()
    const removalApplied = deferred()
    const removal = prisma.$transaction(async tx => {
      await updateCategory(actorId, category.id, { defaultCover: null }, tx)
      removalApplied.resolve()
      await release.promise
    })
    await removalApplied.promise

    const activation = activateCategory(actorId, category.id)
    try {
      await waitForRowLockWaiter()
    } finally {
      release.resolve()
    }
    await removal
    await expect(activation).rejects.toMatchObject({
      status: 400,
      code: CATALOG_ERROR_CODES.COVER_REQUIRED,
    })

    const row = await prisma.productCategory.findUniqueOrThrow({ where: { id: category.id } })
    expect(row).toMatchObject({ status: 'inactive', defaultCoverUrl: null })
    const logs = await prisma.adminLog.count({
      where: { targetType: 'productCategory', targetId: category.id, action: '启用分类' },
    })
    expect(logs).toBe(0)
  })

  it('serializes activation with a valid cover replacement', async () => {
    const actorId = await seedActor()
    const category = await createCategory(actorId, {
      defaultCoverUrl: COVER_URL,
      code: 'race-activate-replace',
      label: '并发激活替换',
    })
    await deactivateCategory(actorId, category.id)

    await Promise.all([
      activateCategory(actorId, category.id),
      updateCategory(actorId, category.id, {
        defaultCover: { kind: 'static', path: '/assets/replaced.webp' },
      }),
    ])

    const row = await prisma.productCategory.findUniqueOrThrow({ where: { id: category.id } })
    expect(row).toMatchObject({ status: 'active', defaultCoverUrl: '/assets/replaced.webp' })
  })
})

describe('categoryService — reorder', () => {
  it('rewrites sortOrder transactionally and last-write-wins', async () => {
    const actorId = await seedActor()
    const a = await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'reorder-a', label: 'A顺序', sortOrder: 1 })
    const b = await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'reorder-b', label: 'B顺序', sortOrder: 2 })

    await reorderCategories(actorId, [b.id, a.id])

    const rows = await prisma.productCategory.findMany({
      where: { id: { in: [a.id, b.id] } },
      orderBy: { sortOrder: 'asc' },
    })
    expect(rows.map(r => r.code)).toEqual(['reorder-b', 'reorder-a'])

    const log = await prisma.adminLog.findFirstOrThrow({
      where: { targetType: 'productCategory', targetId: null, action: '调整分类排序' },
    })
    expect(log.detail).toBe('count=2')
  })

  it('rejects duplicate or unknown ids (400)', async () => {
    const actorId = await seedActor()
    const a = await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'reorder-c', label: 'C顺序' })

    await expect(reorderCategories(actorId, [a.id, a.id])).rejects.toMatchObject({ status: 400 })
    await expect(reorderCategories(actorId, [a.id, 999_999])).rejects.toMatchObject({ status: 400 })
  })

  it('rejects a missing id and rolls back the whole permutation (no partial reorder, no AdminLog)', async () => {
    const actorId = await seedActor()
    const a = await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'reorder-rb-a', label: '回滚A', sortOrder: 1 })
    const b = await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'reorder-rb-b', label: '回滚B', sortOrder: 2 })

    await expect(reorderCategories(actorId, [b.id, a.id, 999_999]))
      .rejects.toMatchObject({ status: 400 })

    // Exact-count verification inside the tx rolled everything back: neither
    // row got a partial sortOrder rewrite.
    const rows = await prisma.productCategory.findMany({
      where: { id: { in: [a.id, b.id] } },
      orderBy: { id: 'asc' },
    })
    const byCode = Object.fromEntries(rows.map(r => [r.code, r.sortOrder]))
    expect(byCode['reorder-rb-a']).toBe(1)
    expect(byCode['reorder-rb-b']).toBe(2)

    // No AdminLog is written for a failed reorder.
    const logs = await prisma.adminLog.findMany({
      where: { targetType: 'productCategory', targetId: null, action: '调整分类排序' },
    })
    expect(logs.some(l => l.detail === 'count=3')).toBe(false)
  })
})

describe('categoryService — delete', () => {
  it('refuses to delete a category referenced by a product (409)', async () => {
    const actorId = await seedActor()
    const dto = await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'ref-test', label: '被引用' })
    await prisma.product.create({
      data: { name: '被引用商品', type: dto.label, price: 100, categoryId: dto.id },
    })

    await expect(deleteCategory(actorId, dto.id))
      .rejects.toMatchObject({ status: 409, code: CATALOG_ERROR_CODES.CATEGORY_REFERENCED })

    // The referenced category is NOT silently deactivated/tombstoned.
    const row = await prisma.productCategory.findUniqueOrThrow({ where: { id: dto.id } })
    expect(row.status).toBe('active')
  })

  it('tombstones an unreferenced category: row kept inactive, code reserved forever, AdminLog written', async () => {
    const actorId = await seedActor()
    const dto = await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'delete-me', label: '可删' })

    const result = await deleteCategory(actorId, dto.id)
    expect(result).toEqual({ deleted: true, id: dto.id })

    // Logical delete — the row is preserved and flipped to inactive, so the
    // code stays reserved and can never be reused (frozen CAT-010).
    const row = await prisma.productCategory.findUniqueOrThrow({ where: { id: dto.id } })
    expect(row.status).toBe('inactive')
    expect(row.code).toBe('delete-me')

    // Removed from the active public registry.
    const registry = await getPublicCategoryRegistry()
    expect(registry.productCategories.some(c => c.code === 'delete-me')).toBe(false)

    // The reserved code still conflicts on create (409, never reused).
    await expect(createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'delete-me', label: '另一个名字' }))
      .rejects.toMatchObject({ status: 409, code: CATALOG_ERROR_CODES.CATEGORY_CODE_TAKEN })

    const log = await prisma.adminLog.findFirstOrThrow({
      where: { targetType: 'productCategory', targetId: dto.id, action: '删除分类' },
    })
    expect(log.detail).toContain('delete-me')
  })

  it('returns 404 for a missing id', async () => {
    const actorId = await seedActor()
    await expect(deleteCategory(actorId, 999_999)).rejects.toMatchObject({ status: 404 })
  })
})

describe('categoryService — list + public registry', () => {
  it('paginates, filters by status and orders by (sortOrder, id)', async () => {
    const actorId = await seedActor()
    await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'list-a', label: 'A列表', sortOrder: 30 })
    await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'list-b', label: 'B列表', sortOrder: 10 })

    const all = await listAdminCategories({ page: 1, pageSize: 20 })
    const codes = all.items.map(i => i.code)
    expect(all.total).toBeGreaterThanOrEqual(2)
    expect(codes.indexOf('list-b')).toBeGreaterThanOrEqual(0)
    expect(codes.indexOf('list-b')).toBeLessThan(codes.indexOf('list-a'))

    const listA = all.items.find(i => i.code === 'list-a')!
    await deactivateCategory(actorId, listA.id)

    const inactive = await listAdminCategories({ status: 'inactive', page: 1, pageSize: 20 })
    expect(inactive.items.some(i => i.code === 'list-a')).toBe(true)
    expect(inactive.items.some(i => i.code === 'list-b')).toBe(false)
  })

  it('public registry returns only active categories with deprecated productTypes', async () => {
    const actorId = await seedActor()
    await ensureSeedCategories(actorId)
    await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'cloud-tool', label: '云工具', sortOrder: 5 })

    const registry = await getPublicCategoryRegistry()
    const codes = registry.productCategories.map(c => c.code)

    expect(codes).toContain('cloud-tool')
    expect(codes).toContain(SEED_CATEGORY_CODE.NETWORK_NODE)
    // legacy-unclassified is inactive and must never surface publicly.
    expect(codes).not.toContain(SEED_CATEGORY_CODE.LEGACY_UNCLASSIFIED)

    const legacy = registry.productTypes.find(t => t.value === '网络节点')
    expect(legacy).toEqual({ value: '网络节点', label: '网络节点', deprecated: true })
    expect(registry.productTypes.some(t => t.value === '待归类')).toBe(false)
  })
})

class FakeRedis {
  readonly store = new Map<string, string>()

  async get(key: string) {
    return this.store.get(key) ?? null
  }

  async set(key: string, value: string, ...args: unknown[]) {
    if (args.includes('NX') && this.store.has(key)) return null
    this.store.set(key, value)
    return 'OK'
  }

  async del(...keys: string[]) {
    let count = 0
    for (const key of keys) {
      if (this.store.delete(key)) count += 1
    }
    return count
  }

  async incr(key: string) {
    const next = Number(this.store.get(key) ?? '0') + 1
    this.store.set(key, String(next))
    return next
  }

  async eval() {
    throw new Error('FakeRedis.eval is not implemented for category cache tests')
  }

  async ping() {
    return 'PONG'
  }

  async keys(pattern: string) {
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern
    return [...this.store.keys()].filter(key => key.startsWith(prefix))
  }
}

const mutableConfig = config as typeof config & {
  redisEnabled: boolean
  cacheProductListVersionCoalesceMs: number
}

describe('categoryService — product list cache invalidation (CHK-CAT-012)', () => {
  let redis: FakeRedis

  beforeEach(async () => {
    mutableConfig.redisEnabled = true
    // Disable coalescing so every mutation deterministically bumps the version.
    mutableConfig.cacheProductListVersionCoalesceMs = 0
    redis = new FakeRedis()
    __setRedisForTests(redis)
    await __resetCacheForTests()
  })

  afterEach(() => {
    __resetRedisForTests()
    mutableConfig.redisEnabled = false
  })

  it('renaming a category label invalidates the public product list cache version', async () => {
    const actorId = await seedActor()
    const dto = await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'list-cache-test', label: '旧标签' })
    const before = await getCacheVersion({ name: 'product-list' })
    expect(before).toBe(0)

    await updateCategory(actorId, dto.id, { label: '新标签' })

    const after = await getCacheVersion({ name: 'product-list' })
    expect(after).toBe((before ?? 0) + 1)
  })
})

describe('categoryService — default cover gates (SPEC-CMI-UX-001 §5.4, AC-UX-015)', () => {
  it('create without a cover is rejected with COVER_REQUIRED (create is always active)', async () => {
    const actorId = await seedActor()
    await expect(createCategory(actorId, { code: 'no-cover', label: '无封面' }))
      .rejects.toMatchObject({ status: 400, code: CATALOG_ERROR_CODES.COVER_REQUIRED })
    expect(await prisma.productCategory.findUnique({ where: { code: 'no-cover' } })).toBeNull()
  })

  it('create resolves a static defaultCover and stores the canonical path', async () => {
    const actorId = await seedActor()
    const dto = await createCategory(actorId, {
      code: 'static-cover',
      label: '静态封面',
      defaultCover: { kind: 'static', path: '/assets/category/software.webp' },
    })
    const row = await prisma.productCategory.findUniqueOrThrow({ where: { id: dto.id } })
    expect(row.defaultCoverUrl).toBe('/assets/category/software.webp')
  })

  it('create resolves an upload objectKey to its canonical URL (DTO never leaks objectKey)', async () => {
    const actorId = await seedActor()
    const key = `cover-${Date.now()}.webp`
    await prisma.storedObject.create({
      data: {
        providerConfigId: null,
        providerRef: 'env',
        bucketRole: 'public',
        objectKey: key,
        status: 'active',
        source: 'upload_image',
      },
    })
    const dto = await createCategory(actorId, {
      code: 'upload-cover',
      label: '上传封面',
      defaultCover: { kind: 'upload', objectKey: key },
    })
    const row = await prisma.productCategory.findUniqueOrThrow({ where: { id: dto.id } })
    expect(row.defaultCoverUrl).toBe(`http://localhost:3000/uploads/${key}`)
    expect(JSON.stringify(dto)).not.toContain('objectKey')
  })

  it('legacy defaultCoverUrl is resolved through the same resolver', async () => {
    const actorId = await seedActor()
    const dto = await createCategory(actorId, {
      code: 'legacy-cover',
      label: '旧封面',
      defaultCoverUrl: '/assets/legacy.webp',
    })
    const row = await prisma.productCategory.findUniqueOrThrow({ where: { id: dto.id } })
    expect(row.defaultCoverUrl).toBe('/assets/legacy.webp')
  })

  it('active replace resolves the new cover first; an unresolved cover keeps the old value', async () => {
    const actorId = await seedActor()
    const dto = await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'replace-cover', label: '替换封面' })

    // Unresolvable legacy cover → rejected, old value untouched.
    await expect(updateCategory(actorId, dto.id, { defaultCoverUrl: '/uploads/ghost.png' }))
      .rejects.toMatchObject({ status: 400, code: CATALOG_ERROR_CODES.COVER_INVALID })
    let row = await prisma.productCategory.findUniqueOrThrow({ where: { id: dto.id } })
    expect(row.defaultCoverUrl).toBe(COVER_URL)

    // Valid static replace → updated.
    await updateCategory(actorId, dto.id, { defaultCover: { kind: 'static', path: '/assets/new.webp' } })
    row = await prisma.productCategory.findUniqueOrThrow({ where: { id: dto.id } })
    expect(row.defaultCoverUrl).toBe('/assets/new.webp')
  })

  it('active remove is rejected with the old value preserved; inactive remove is allowed', async () => {
    const actorId = await seedActor()
    const dto = await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'remove-cover', label: '移除封面' })

    await expect(updateCategory(actorId, dto.id, { defaultCover: null }))
      .rejects.toMatchObject({ status: 400, code: CATALOG_ERROR_CODES.COVER_REQUIRED })
    let row = await prisma.productCategory.findUniqueOrThrow({ where: { id: dto.id } })
    expect(row.defaultCoverUrl).toBe(COVER_URL)

    await deactivateCategory(actorId, dto.id)
    await updateCategory(actorId, dto.id, { defaultCoverUrl: null })
    row = await prisma.productCategory.findUniqueOrThrow({ where: { id: dto.id } })
    expect(row.defaultCoverUrl).toBeNull()
  })

  it('inactive -> active requires a resolvable cover (COVER_REQUIRED / COVER_INVALID)', async () => {
    const actorId = await seedActor()
    const noCover = await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'act-nocover', label: '激活无封面' })
    await deactivateCategory(actorId, noCover.id)
    await updateCategory(actorId, noCover.id, { defaultCoverUrl: null })
    await expect(activateCategory(actorId, noCover.id))
      .rejects.toMatchObject({ status: 400, code: CATALOG_ERROR_CODES.COVER_REQUIRED })

    const broken = await createCategory(actorId, { defaultCoverUrl: COVER_URL, code: 'act-broken', label: '激活失效封面' })
    await deactivateCategory(actorId, broken.id)
    await prisma.productCategory.update({ where: { id: broken.id }, data: { defaultCoverUrl: '/uploads/ghost.png' } })
    await expect(activateCategory(actorId, broken.id))
      .rejects.toMatchObject({ status: 400, code: CATALOG_ERROR_CODES.COVER_INVALID })
    let row = await prisma.productCategory.findUniqueOrThrow({ where: { id: broken.id } })
    expect(row.status).toBe('inactive')

    await prisma.productCategory.update({ where: { id: broken.id }, data: { defaultCoverUrl: COVER_URL } })
    const activated = await activateCategory(actorId, broken.id)
    expect(activated.status).toBe('active')
    row = await prisma.productCategory.findUniqueOrThrow({ where: { id: broken.id } })
    expect(row.status).toBe('active')
  })
})
