// T-CAT-BE-002 — CategoryApplication state machine / review service Red tests
// (SPEC-CATALOG-OPS-001 §5.2/§7.3; D-CAT-10/D-CAT-11; REQ-CAT-F-008;
// REQ-CAT-NF-005; CHK-CAT-006~009; AC-CAT-012~014). DB-backed — run by the
// coordinator against the dedicated monexus_test_catalog_ops_be database.
//
// Proves: merchant ownership isolation, the pending normalized-duplicate stable
// error, withdraw-after-review blocking, the transaction CAS (double review
// leaves exactly one winner and one Category), AdminLog structural allowlist
// (no application full text / reviewReason), the response DTO allowlist, and
// the absence of any notification event.

import { describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import {
  approveCategoryApplication,
  createMyCategoryApplication,
  listAdminCategoryApplications,
  listMyCategoryApplications,
  rejectCategoryApplication,
  withdrawMyCategoryApplication,
} from './applicationService.js'
import { activateCategory, createCategory, deactivateCategory } from './categoryService.js'
import { getPublicCategoryRegistry } from './registry.js'
import { CATALOG_ERROR_CODES } from './constants.js'

const VALID_INPUT = {
  proposedLabel: '云工具',
  description: '这是商家希望新增的平台云工具分类申请描述。',
}

async function seedMerchant(email = `app-merchant-${Math.random().toString(36).slice(2)}@test.local`): Promise<number> {
  const user = await prisma.user.create({
    data: { email, password: 'x', role: 'merchant' },
  })
  const merchant = await prisma.merchant.create({
    data: { userId: user.id, name: '测试商家', status: 'active' },
  })
  return merchant.id
}

async function seedAdmin(email = `app-admin-${Math.random().toString(36).slice(2)}@test.local`): Promise<number> {
  const user = await prisma.user.create({
    data: { email, password: 'x', role: 'admin' },
  })
  return user.id
}

async function pendingApp(merchantId: number, label = '云工具') {
  return createMyCategoryApplication(merchantId, {
    proposedLabel: label,
    description: '这是商家希望新增的平台分类申请描述，长度满足要求。',
  })
}

/** The frozen response allowlist — no internal fields may ever leak. */
const DTO_KEYS = new Set([
  'id', 'merchantId', 'proposedLabel', 'proposedCode', 'description',
  'exampleProducts', 'status', 'resolution', 'approvedCategoryId',
  'reviewedAt', 'reviewReason', 'createdAt', 'updatedAt',
])

function expectDtoAllowlist(value: Record<string, unknown>) {
  for (const key of Object.keys(value)) {
    expect(DTO_KEYS.has(key), `unexpected DTO field: ${key}`).toBe(true)
  }
  expect('normalizedLabel' in value).toBe(false)
  expect('reviewedByUserId' in value).toBe(false)
}

describe('merchant create — pending normalized duplicate', () => {
  it('creates a pending application and returns only the frozen DTO allowlist', async () => {
    const merchantId = await seedMerchant()
    const dto = await createMyCategoryApplication(merchantId, VALID_INPUT)

    expect(dto).toMatchObject({
      merchantId,
      proposedLabel: '云工具',
      proposedCode: null,
      status: 'pending',
      resolution: null,
      approvedCategoryId: null,
      reviewedAt: null,
      reviewReason: null,
    })
    expectDtoAllowlist(dto as unknown as Record<string, unknown>)

    const row = await prisma.categoryApplication.findUniqueOrThrow({ where: { id: dto.id } })
    expect(row.normalizedLabel).toBe('云工具')
    expect(row.merchantId).toBe(merchantId)
  })

  it('rejects a second pending application for the same merchant + normalizedLabel (409 stable code)', async () => {
    const merchantId = await seedMerchant()
    await pendingApp(merchantId, ' 云工具 ')
    // Whitespace/case canonicalisation → same normalizedLabel → duplicate.
    await expect(pendingApp(merchantId, '云工具'))
      .rejects.toMatchObject({ status: 409, code: CATALOG_ERROR_CODES.CATEGORY_APPLICATION_PENDING_DUPLICATE })
  })

  it('allows a different normalizedLabel for the same merchant, and the same label for another merchant', async () => {
    const merchantId = await seedMerchant()
    const other = await seedMerchant()

    await pendingApp(merchantId, '云工具')
    const second = await pendingApp(merchantId, '云服务')
    expect(second.status).toBe('pending')

    const cross = await pendingApp(other, '云工具')
    expect(cross.merchantId).toBe(other)
    expect(await prisma.categoryApplication.count()).toBe(3)
  })
})

describe('merchant ownership isolation', () => {
  it('merchant list only returns the caller\'s own applications', async () => {
    const a = await seedMerchant()
    const b = await seedMerchant()
    await pendingApp(a, '甲类')
    await pendingApp(b, '乙类')

    const mine = await listMyCategoryApplications(a, { page: 1, pageSize: 20 })
    expect(mine.total).toBe(1)
    expect(mine.items[0].merchantId).toBe(a)
    expect(mine.items[0].proposedLabel).toBe('甲类')

    const admin = await listAdminCategoryApplications({ page: 1, pageSize: 20 })
    expect(admin.total).toBe(2)
  })

  it('withdrawing another merchant\'s application returns 404 (no existence leak)', async () => {
    const a = await seedMerchant()
    const b = await seedMerchant()
    const app = await pendingApp(a)

    await expect(withdrawMyCategoryApplication(b, app.id))
      .rejects.toMatchObject({ status: 404 })
    // The application is untouched.
    const row = await prisma.categoryApplication.findUniqueOrThrow({ where: { id: app.id } })
    expect(row.status).toBe('pending')
  })
})

describe('merchant withdraw — D-CAT-10', () => {
  it('withdraws a pending application and returns the withdrawn DTO', async () => {
    const merchantId = await seedMerchant()
    const app = await pendingApp(merchantId)

    const withdrawn = await withdrawMyCategoryApplication(merchantId, app.id)
    expect(withdrawn.status).toBe('withdrawn')

    const row = await prisma.categoryApplication.findUniqueOrThrow({ where: { id: app.id } })
    expect(row.status).toBe('withdrawn')
    expect(row.reviewedByUserId).toBeNull()
  })

  it('rejects a second withdraw and blocks admin review after withdrawal (409)', async () => {
    const merchantId = await seedMerchant()
    const adminId = await seedAdmin()
    const app = await pendingApp(merchantId)

    await withdrawMyCategoryApplication(merchantId, app.id)
    await expect(withdrawMyCategoryApplication(merchantId, app.id))
      .rejects.toMatchObject({ status: 409, code: CATALOG_ERROR_CODES.CATEGORY_APPLICATION_ALREADY_REVIEWED })

    // Withdrawn can never be reviewed — the CAS `where status=pending` misses.
    await expect(approveCategoryApplication(adminId, app.id, {
      resolution: 'create_new',
      category: { code: 'wdr-cat', label: '撤回后分类' },
      reviewReason: '不应通过',
    })).rejects.toMatchObject({ status: 409, code: CATALOG_ERROR_CODES.CATEGORY_APPLICATION_ALREADY_REVIEWED })

    // Nothing was created and no review log was written.
    expect(await prisma.productCategory.count({ where: { code: 'wdr-cat' } })).toBe(0)
    expect(await prisma.adminLog.count({ where: { targetType: 'categoryApplication', targetId: app.id } })).toBe(0)
  })
})

describe('admin approve — create_new (D-CAT-10/11)', () => {
  it('creates the Category + AdminLog atomically and bumps the public registry', async () => {
    const merchantId = await seedMerchant()
    const adminId = await seedAdmin()
    const app = await pendingApp(merchantId, '云工具')

    const dto = await approveCategoryApplication(adminId, app.id, {
      resolution: 'create_new',
      category: { code: 'cloud-tool', label: ' 云工具 ', iconKey: 'cloud' },
      reviewReason: '符合平台目录',
    })
    expect(dto).toMatchObject({
      status: 'approved',
      resolution: 'create_new',
      reviewReason: '符合平台目录',
    })
    expect(dto.approvedCategoryId).toBeGreaterThan(0)
    expect(dto.reviewedAt).not.toBeNull()
    expectDtoAllowlist(dto as unknown as Record<string, unknown>)

    // Category exists, active, with the admin as creator/updater.
    const category = await prisma.productCategory.findUniqueOrThrow({ where: { code: 'cloud-tool' } })
    expect(category.status).toBe('active')
    expect(category.createdByUserId).toBe(adminId)
    expect(category.updatedByUserId).toBe(adminId)
    expect(dto.approvedCategoryId).toBe(category.id)

    // AdminLog: structural detail only — no application full text / reviewReason.
    const log = await prisma.adminLog.findFirstOrThrow({
      where: { targetType: 'categoryApplication', targetId: app.id },
    })
    expect(log.adminUserId).toBe(adminId)
    expect(log.action).toBe('审核通过分类申请')
    expect(log.detail).toContain('resolution=create_new')
    expect(log.detail).toContain('code=cloud-tool')
    expect(log.detail).not.toContain('云工具')
    expect(log.detail).not.toContain('符合平台目录')
    expect(log.detail).not.toContain('这是商家')

    // Public registry was invalidated and now serves the new active category.
    const registry = await getPublicCategoryRegistry()
    expect(registry.productCategories.some(c => c.code === 'cloud-tool')).toBe(true)

    // No notification event is ever produced (D-CAT-24).
    expect(await prisma.notification.count()).toBe(0)
  })

  it('refuses a second review with a stable code and never creates a duplicate Category', async () => {
    const merchantId = await seedMerchant()
    const adminId = await seedAdmin()
    const app = await pendingApp(merchantId)

    await approveCategoryApplication(adminId, app.id, {
      resolution: 'create_new',
      category: { code: 'double-cat', label: '双审核' },
      reviewReason: '第一次通过',
    })
    await expect(approveCategoryApplication(adminId, app.id, {
      resolution: 'create_new',
      category: { code: 'double-cat', label: '双审核' },
      reviewReason: '第二次也通过',
    })).rejects.toMatchObject({ status: 409, code: CATALOG_ERROR_CODES.CATEGORY_APPLICATION_ALREADY_REVIEWED })

    expect(await prisma.productCategory.count({ where: { code: 'double-cat' } })).toBe(1)
    // Only ONE review AdminLog was written for the winning review.
    const logs = await prisma.adminLog.findMany({ where: { targetType: 'categoryApplication', targetId: app.id } })
    expect(logs).toHaveLength(1)
  })

  it('rolls back to pending when the proposed code is already taken (409 CATEGORY_CODE_TAKEN)', async () => {
    const merchantId = await seedMerchant()
    const adminId = await seedAdmin()
    const app = await pendingApp(merchantId)
    await createCategory(adminId, { defaultCoverUrl: '/assets/network.webp', code: 'taken-cat', label: '已占用' })

    await expect(approveCategoryApplication(adminId, app.id, {
      resolution: 'create_new',
      category: { code: 'taken-cat', label: '想建同名' },
      reviewReason: '尝试占用',
    })).rejects.toMatchObject({ status: 409, code: CATALOG_ERROR_CODES.CATEGORY_CODE_TAKEN })

    // Atomic rollback: application still pending, no duplicate category, no log.
    const row = await prisma.categoryApplication.findUniqueOrThrow({ where: { id: app.id } })
    expect(row.status).toBe('pending')
    expect(await prisma.productCategory.count({ where: { code: 'taken-cat' } })).toBe(1)
    expect(await prisma.adminLog.count({ where: { targetType: 'categoryApplication', targetId: app.id } })).toBe(0)
  })

  it('two concurrent approvals leave exactly one winner and one Category', async () => {
    const merchantId = await seedMerchant()
    const adminA = await seedAdmin()
    const adminB = await seedAdmin()
    const app = await pendingApp(merchantId, '并发分类')

    const results = await Promise.allSettled([
      approveCategoryApplication(adminA, app.id, {
        resolution: 'create_new',
        category: { code: 'race-cat', label: '并发分类' },
        reviewReason: '管理员 A',
      }),
      approveCategoryApplication(adminB, app.id, {
        resolution: 'create_new',
        category: { code: 'race-cat', label: '并发分类' },
        reviewReason: '管理员 B',
      }),
    ])

    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    if (rejected[0]?.status === 'rejected') {
      expect(rejected[0].reason).toMatchObject({ status: 409, code: CATALOG_ERROR_CODES.CATEGORY_APPLICATION_ALREADY_REVIEWED })
    }

    // Exactly one Category exists, and the application is approved once.
    expect(await prisma.productCategory.count({ where: { code: 'race-cat' } })).toBe(1)
    const row = await prisma.categoryApplication.findUniqueOrThrow({ where: { id: app.id } })
    expect(row.status).toBe('approved')
    expect(await prisma.adminLog.count({ where: { targetType: 'categoryApplication', targetId: app.id } })).toBe(1)
  })
})

describe('admin approve — map_existing (AC-CAT-014)', () => {
  it('links an existing ACTIVE category without creating a duplicate', async () => {
    const merchantId = await seedMerchant()
    const adminId = await seedAdmin()
    const target = await createCategory(adminId, { defaultCoverUrl: '/assets/network.webp', code: 'existing-cat', label: '既有分类' })
    const app = await pendingApp(merchantId)

    const dto = await approveCategoryApplication(adminId, app.id, {
      resolution: 'map_existing',
      categoryId: target.id,
      reviewReason: '已存在等价分类',
    })
    expect(dto).toMatchObject({
      status: 'approved',
      resolution: 'map_existing',
      approvedCategoryId: target.id,
      reviewReason: '已存在等价分类',
    })
    expect(dto.approvedCategoryId).toBe(target.id)

    // No new category was created.
    expect(await prisma.productCategory.count()).toBe(1)
    expect(await prisma.productCategory.findUnique({ where: { id: target.id } })).not.toBeNull()

    const log = await prisma.adminLog.findFirstOrThrow({
      where: { targetType: 'categoryApplication', targetId: app.id },
    })
    expect(log.detail).toContain(`resolution=map_existing categoryId=${target.id}`)
    expect(log.detail).not.toContain('已存在等价分类')
    expect(log.detail).not.toContain('这是商家')
    expect(await prisma.notification.count()).toBe(0)
  })

  it('refuses a missing target (404) and an inactive target (409 MAP_TARGET_INACTIVE) and keeps the app pending', async () => {
    const merchantId = await seedMerchant()
    const adminId = await seedAdmin()
    const app = await pendingApp(merchantId)

    await expect(approveCategoryApplication(adminId, app.id, {
      resolution: 'map_existing',
      categoryId: 999_999,
      reviewReason: '目标不存在',
    })).rejects.toMatchObject({ status: 404 })

    const inactive = await createCategory(adminId, { defaultCoverUrl: '/assets/network.webp', code: 'off-cat', label: '停用分类' })
    await deactivateCategory(adminId, inactive.id)

    await expect(approveCategoryApplication(adminId, app.id, {
      resolution: 'map_existing',
      categoryId: inactive.id,
      reviewReason: '目标是停用分类',
    })).rejects.toMatchObject({ status: 409, code: CATALOG_ERROR_CODES.CATEGORY_APPLICATION_MAP_TARGET_INACTIVE })

    // Both failed reviews rolled back: still pending, no AdminLog, no link.
    const row = await prisma.categoryApplication.findUniqueOrThrow({ where: { id: app.id } })
    expect(row.status).toBe('pending')
    expect(row.approvedCategoryId).toBeNull()
    expect(await prisma.adminLog.count({ where: { targetType: 'categoryApplication', targetId: app.id } })).toBe(0)

    // Reactivating the target makes the same map_existing approve succeed.
    await activateCategory(adminId, inactive.id)
    const ok = await approveCategoryApplication(adminId, app.id, {
      resolution: 'map_existing',
      categoryId: inactive.id,
      reviewReason: '已重新启用',
    })
    expect(ok.approvedCategoryId).toBe(inactive.id)
  })
})

describe('admin reject — reviewReason + AdminLog', () => {
  it('rejects a pending application with reason, null resolution and structural AdminLog', async () => {
    const merchantId = await seedMerchant()
    const adminId = await seedAdmin()
    const app = await pendingApp(merchantId)

    const dto = await rejectCategoryApplication(adminId, app.id, { reviewReason: '与现有分类重复，建议合并' })
    expect(dto).toMatchObject({
      status: 'rejected',
      resolution: null,
      approvedCategoryId: null,
      reviewReason: '与现有分类重复，建议合并',
    })
    expect(dto.reviewedAt).not.toBeNull()
    expectDtoAllowlist(dto as unknown as Record<string, unknown>)

    const row = await prisma.categoryApplication.findUniqueOrThrow({ where: { id: app.id } })
    expect(row.reviewedByUserId).toBe(adminId)

    const log = await prisma.adminLog.findFirstOrThrow({ where: { targetType: 'categoryApplication', targetId: app.id } })
    expect(log.action).toBe('拒绝分类申请')
    expect(log.detail).toBe('resolution=reject')
    expect(log.detail).not.toContain('与现有分类重复')
    expect(log.detail).not.toContain('这是商家')
    expect(await prisma.notification.count()).toBe(0)
  })

  it('refuses a second rejection (409 ALREADY_REVIEWED)', async () => {
    const merchantId = await seedMerchant()
    const adminId = await seedAdmin()
    const app = await pendingApp(merchantId)

    await rejectCategoryApplication(adminId, app.id, { reviewReason: '第一次拒绝' })
    await expect(rejectCategoryApplication(adminId, app.id, { reviewReason: '第二次拒绝' }))
      .rejects.toMatchObject({ status: 409, code: CATALOG_ERROR_CODES.CATEGORY_APPLICATION_ALREADY_REVIEWED })
    expect(await prisma.adminLog.count({ where: { targetType: 'categoryApplication', targetId: app.id } })).toBe(1)
  })
})
