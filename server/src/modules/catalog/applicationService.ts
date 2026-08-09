// T-CAT-BE-002 — CategoryApplication state machine + admin review
// (SPEC-CATALOG-OPS-001 §5.2/§7.3; D-CAT-10/D-CAT-11; REQ-CAT-F-008;
// REQ-CAT-NF-004/005; CHK-CAT-006~009; AC-CAT-012~014).
//
// Domain rules enforced here that the schema cannot see:
//   - merchant can only read / create / withdraw ITS OWN applications —
//     merchantId is always derived from auth and never accepted from the body
//     (ownership isolation, AC-CAT-009/REQ-CAT-NF-004);
//   - "same merchant + normalizedLabel at most one pending" (spec §5.2) — a
//     friendly pre-check plus the DB partial unique index
//     CategoryApplication_one_pending_per_merchant_label mapped to a stable
//     409 CATEGORY_APPLICATION_PENDING_DUPLICATE business error;
//   - only pending can be approved/rejected/withdrawn (D-CAT-10); every review
//     is a transaction + `where id + status=pending` CAS (spec §7.3) so a
//     second concurrent review or a post-withdraw review always fails with a
//     stable 409 CATEGORY_APPLICATION_ALREADY_REVIEWED and can never create a
//     duplicate Category (AC-CAT-013);
//   - approve create_new creates the Category inside the SAME transaction as
//     the application update + AdminLog, and bumps the public registry
//     generation after commit (AC-CAT-026); approve map_existing links an
//     existing ACTIVE category without creating one (AC-CAT-014, D-CAT-22);
//   - AdminLog detail is strictly structural (resolution / code / categoryId /
//     status) — never the application body or reviewReason full text
//     (DoD "日志无申请全文", REQ-CAT-NF-005);
//   - the response is the frozen CategoryApplicationDto allowlist — it never
//     leaks normalizedLabel, reviewedByUserId or any internal field.
//
// No notification event is emitted anywhere on this flow (D-CAT-24 — review
// results are read via UI/REST only).

import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { notFound } from '../../lib/httpError.js'
import { categoryHttpError } from './categoryService.js'
import {
  CATALOG_ERROR_CODES,
  CATEGORY_APPLICATION_RESOLUTION,
  CATEGORY_APPLICATION_STATUS,
  CATEGORY_STATUS,
  type CategoryApplicationResolution,
  type CategoryApplicationStatus,
} from './constants.js'
import type { CategoryApplicationDto } from './contracts.js'
import { normalizeCategoryLabel } from './categorySchema.js'
import {
  normalizeApplicationLabel,
  type ApproveCategoryApplicationInput,
  type CreateCategoryApplicationInput,
  type CreateNewApprovalInput,
  type ListAdminCategoryApplicationsQuery,
  type ListMyCategoryApplicationsQuery,
  type MapExistingApprovalInput,
  type RejectCategoryApplicationInput,
} from './applicationSchema.js'
import { bumpCategoryRegistryCacheVersion } from './registry.js'

type Client = typeof prisma | Prisma.TransactionClient

/** Partial unique index on (merchantId, normalizedLabel) WHERE status='pending'. */
const PENDING_DUPLICATE_INDEX = 'CategoryApplication_one_pending_per_merchant_label'

const applicationSelect = {
  id: true,
  merchantId: true,
  proposedLabel: true,
  proposedCode: true,
  description: true,
  exampleProducts: true,
  status: true,
  resolution: true,
  approvedCategoryId: true,
  reviewedAt: true,
  reviewReason: true,
  createdAt: true,
  updatedAt: true,
} as const

type ApplicationRow = Prisma.CategoryApplicationGetPayload<{ select: typeof applicationSelect }>

/**
 * Frozen response allowlist (contracts.ts CategoryApplicationDto). Only these
 * fields are ever returned — normalizedLabel/reviewedByUserId are internal.
 */
function toApplicationDto(row: ApplicationRow): CategoryApplicationDto {
  return {
    id: row.id,
    merchantId: row.merchantId,
    proposedLabel: row.proposedLabel,
    proposedCode: row.proposedCode,
    description: row.description,
    exampleProducts: row.exampleProducts,
    status: row.status as CategoryApplicationStatus,
    resolution: row.resolution as CategoryApplicationResolution | null,
    approvedCategoryId: row.approvedCategoryId,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reviewReason: row.reviewReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Run a callback inside one DB transaction (no nested transactions). */
async function runInTransaction<T>(
  db: Client,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (db === prisma) return prisma.$transaction(fn)
  const txAware = db as typeof prisma
  if (typeof txAware.$transaction === 'function') {
    return txAware.$transaction(fn)
  }
  return fn(db as Prisma.TransactionClient)
}

function isPrismaErrorCode(err: unknown, code: string): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === code
}

/** Unique-constraint collision on one of the named columns (P2002 meta.target). */
function isUniqueError(err: unknown, ...fields: string[]): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false
  const target = (err.meta as { target?: unknown } | undefined)?.target
  const values = Array.isArray(target) ? target.map(String) : target != null ? [String(target)] : []
  return fields.some(field => values.includes(field) || values.some(v => v.includes(field)))
}

/** The pending partial-unique index collision (by name or by its key columns). */
function isPendingDuplicateError(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false
  const target = (err.meta as { target?: unknown } | undefined)?.target
  const values = Array.isArray(target) ? target.map(String) : target != null ? [String(target)] : []
  return values.some(
    v => v === PENDING_DUPLICATE_INDEX || v.includes('merchantId') || v.includes('normalizedLabel'),
  )
}

/**
 * CAS missed helper: after an `updateMany where id + status=pending` returned 0,
 * distinguish "never existed / not yours" (404, no existence leak) from
 * "exists but no longer pending" (409 CATEGORY_APPLICATION_ALREADY_REVIEWED).
 */
async function assertCasOrThrow(tx: Prisma.TransactionClient, applicationId: number, cas: { count: number }) {
  if (cas.count === 1) return
  const existing = await tx.categoryApplication.findUnique({
    where: { id: applicationId },
    select: { id: true },
  })
  if (!existing) throw notFound('申请不存在')
  throw categoryHttpError(
    409,
    CATALOG_ERROR_CODES.CATEGORY_APPLICATION_ALREADY_REVIEWED,
    '申请已被审核或已撤回，无法重复操作',
  )
}

// ─────────────────────────── Merchant lane ───────────────────────────

/** List only the caller's own applications (ownership is forced, never filtered by body). */
export async function listMyCategoryApplications(
  merchantId: number,
  query: ListMyCategoryApplicationsQuery,
  db: Client = prisma,
) {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 20
  const where: Prisma.CategoryApplicationWhereInput = { merchantId }
  if (query.status) where.status = query.status

  const [total, items] = await Promise.all([
    db.categoryApplication.count({ where }),
    db.categoryApplication.findMany({
      where,
      orderBy: [{ id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: applicationSelect,
    }),
  ])
  return { items: items.map(toApplicationDto), total, page, pageSize }
}

/**
 * Create a pending application. normalizedLabel is derived server-side; the
 * "one pending per merchant + normalizedLabel" rule is enforced by the DB
 * partial unique index, and any collision — including a concurrent one — maps
 * to the stable 409 CATEGORY_APPLICATION_PENDING_DUPLICATE business error.
 */
export async function createMyCategoryApplication(
  merchantId: number,
  input: CreateCategoryApplicationInput,
  db: Client = prisma,
): Promise<CategoryApplicationDto> {
  const normalizedLabel = normalizeApplicationLabel(input.proposedLabel)

  // Friendly pre-check; the DB partial unique index below is the race-safe
  // authority (a concurrent create can still collide → mapped in the catch).
  const existing = await db.categoryApplication.findFirst({
    where: {
      merchantId,
      normalizedLabel,
      status: CATEGORY_APPLICATION_STATUS.PENDING,
    },
    select: { id: true },
  })
  if (existing) {
    throw categoryHttpError(
      409,
      CATALOG_ERROR_CODES.CATEGORY_APPLICATION_PENDING_DUPLICATE,
      '你已有一个相同名称的分类申请在审核中',
    )
  }

  try {
    const row = await db.categoryApplication.create({
      data: {
        merchantId,
        proposedLabel: input.proposedLabel,
        normalizedLabel,
        proposedCode: input.proposedCode?.trim() ? input.proposedCode : null,
        description: input.description,
        exampleProducts: input.exampleProducts?.trim() ? input.exampleProducts : null,
        status: CATEGORY_APPLICATION_STATUS.PENDING,
      },
      select: applicationSelect,
    })
    return toApplicationDto(row)
  } catch (err) {
    if (isPendingDuplicateError(err)) {
      throw categoryHttpError(
        409,
        CATALOG_ERROR_CODES.CATEGORY_APPLICATION_PENDING_DUPLICATE,
        '你已有一个相同名称的分类申请在审核中',
      )
    }
    throw err
  }
}

/**
 * Withdraw a pending application (D-CAT-10). The CAS `where id + merchantId +
 * status=pending` makes ownership + state one atomic check: another merchant's
 * application resolves to 404 (no existence leak), and an already-reviewed /
 * already-withdrawn one resolves to a stable 409.
 */
export async function withdrawMyCategoryApplication(
  merchantId: number,
  applicationId: number,
  db: Client = prisma,
): Promise<CategoryApplicationDto> {
  return runInTransaction(db, async tx => {
    const cas = await tx.categoryApplication.updateMany({
      where: {
        id: applicationId,
        merchantId,
        status: CATEGORY_APPLICATION_STATUS.PENDING,
      },
      data: { status: CATEGORY_APPLICATION_STATUS.WITHDRAWN },
    })

    if (cas.count === 1) {
      const row = await tx.categoryApplication.findUniqueOrThrow({
        where: { id: applicationId },
        select: applicationSelect,
      })
      return toApplicationDto(row)
    }

    // CAS missed: either the row does not exist or does not belong to this
    // merchant (→404, no leak) or it is no longer pending (→409).
    const existing = await tx.categoryApplication.findFirst({
      where: { id: applicationId, merchantId },
      select: { id: true },
    })
    if (!existing) throw notFound('申请不存在')
    throw categoryHttpError(
      409,
      CATALOG_ERROR_CODES.CATEGORY_APPLICATION_ALREADY_REVIEWED,
      '申请已审核或已撤回，无法撤回',
    )
  })
}

// ─────────────────────────── Admin lane ───────────────────────────

/** Admin list with optional status / merchantId filters (spec §7.3). */
export async function listAdminCategoryApplications(
  query: ListAdminCategoryApplicationsQuery,
  db: Client = prisma,
) {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 20
  const where: Prisma.CategoryApplicationWhereInput = {}
  if (query.status) where.status = query.status
  if (query.merchantId) where.merchantId = query.merchantId

  const [total, items] = await Promise.all([
    db.categoryApplication.count({ where }),
    db.categoryApplication.findMany({
      where,
      orderBy: [{ id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: applicationSelect,
    }),
  ])
  return { items: items.map(toApplicationDto), total, page, pageSize }
}

/** create_new: CAS the application, then create the Category + AdminLog atomically. */
async function approveCreateNew(
  tx: Prisma.TransactionClient,
  adminId: number,
  applicationId: number,
  input: CreateNewApprovalInput,
): Promise<CategoryApplicationDto> {
  // 1. CAS gate (spec §7.3) — a concurrent/second review misses here and the
  //    whole transaction rolls back, so no duplicate Category can ever appear.
  const cas = await tx.categoryApplication.updateMany({
    where: { id: applicationId, status: CATEGORY_APPLICATION_STATUS.PENDING },
    data: {
      status: CATEGORY_APPLICATION_STATUS.APPROVED,
      resolution: CATEGORY_APPLICATION_RESOLUTION.CREATE_NEW,
      reviewReason: input.reviewReason,
      reviewedByUserId: adminId,
      reviewedAt: new Date(),
    },
  })
  await assertCasOrThrow(tx, applicationId, cas)

  // 2. Create the Category inside the same transaction. Unique collisions map
  //    to the frozen category error codes; any throw rolls back the CAS above.
  const code = input.category.code.trim()
  const normalizedLabel = normalizeCategoryLabel(input.category.label)
  let created: { id: number; code: string }
  try {
    created = await tx.productCategory.create({
      data: {
        code,
        label: input.category.label,
        normalizedLabel,
        description: input.category.description?.trim() ? input.category.description : null,
        iconKey: input.category.iconKey?.trim() ? input.category.iconKey : null,
        sortOrder: 0,
        status: CATEGORY_STATUS.ACTIVE,
        createdByUserId: adminId,
        updatedByUserId: adminId,
      },
      select: { id: true, code: true },
    })
  } catch (err) {
    if (isUniqueError(err, 'code')) {
      throw categoryHttpError(409, CATALOG_ERROR_CODES.CATEGORY_CODE_TAKEN, '分类编码已存在，且停用后不可复用')
    }
    if (isUniqueError(err, 'normalizedLabel')) {
      throw categoryHttpError(409, CATALOG_ERROR_CODES.CATEGORY_LABEL_TAKEN, '分类名称已存在')
    }
    if (isPrismaErrorCode(err, 'P2002')) {
      throw categoryHttpError(409, CATALOG_ERROR_CODES.CATEGORY_CODE_TAKEN, '分类编码或名称已存在')
    }
    throw err
  }

  // 3. Link the created category and write the review AdminLog atomically.
  const row = await tx.categoryApplication.update({
    where: { id: applicationId },
    data: { approvedCategoryId: created.id },
    select: applicationSelect,
  })
  await tx.adminLog.create({
    data: {
      adminUserId: adminId,
      action: '审核通过分类申请',
      targetType: 'categoryApplication',
      targetId: applicationId,
      // Structural detail only — never the application body or reviewReason.
      detail: `resolution=create_new code=${created.code}`,
    },
  })
  return toApplicationDto(row)
}

/** map_existing: link an existing ACTIVE category without creating one (AC-CAT-014). */
async function approveMapExisting(
  tx: Prisma.TransactionClient,
  adminId: number,
  applicationId: number,
  input: MapExistingApprovalInput,
): Promise<CategoryApplicationDto> {
  const category = await tx.productCategory.findUnique({
    where: { id: input.categoryId },
    select: { id: true, code: true, status: true },
  })
  if (!category) throw notFound('分类不存在')
  if (category.status !== CATEGORY_STATUS.ACTIVE) {
    throw categoryHttpError(
      409,
      CATALOG_ERROR_CODES.CATEGORY_APPLICATION_MAP_TARGET_INACTIVE,
      '只能映射到启用中的分类；请先启用该分类或选择其他分类',
    )
  }

  const cas = await tx.categoryApplication.updateMany({
    where: { id: applicationId, status: CATEGORY_APPLICATION_STATUS.PENDING },
    data: {
      status: CATEGORY_APPLICATION_STATUS.APPROVED,
      resolution: CATEGORY_APPLICATION_RESOLUTION.MAP_EXISTING,
      approvedCategoryId: category.id,
      reviewReason: input.reviewReason,
      reviewedByUserId: adminId,
      reviewedAt: new Date(),
    },
  })
  await assertCasOrThrow(tx, applicationId, cas)

  const row = await tx.categoryApplication.findUniqueOrThrow({
    where: { id: applicationId },
    select: applicationSelect,
  })
  await tx.adminLog.create({
    data: {
      adminUserId: adminId,
      action: '审核通过分类申请',
      targetType: 'categoryApplication',
      targetId: applicationId,
      detail: `resolution=map_existing categoryId=${category.id}`,
    },
  })
  return toApplicationDto(row)
}

/**
 * Approve an application (D-CAT-10: create_new or map_existing). The whole
 * review — status CAS + optional Category create + AdminLog — is one
 * transaction; the registry generation is bumped after commit only when a new
 * Category was actually created (REQ-CAT-NF-008, AC-CAT-026).
 */
export async function approveCategoryApplication(
  adminId: number,
  applicationId: number,
  input: ApproveCategoryApplicationInput,
  db: Client = prisma,
): Promise<CategoryApplicationDto> {
  const result = await runInTransaction(db, async tx => {
    if (input.resolution === CATEGORY_APPLICATION_RESOLUTION.CREATE_NEW) {
      return approveCreateNew(tx, adminId, applicationId, input)
    }
    return approveMapExisting(tx, adminId, applicationId, input)
  })

  if (input.resolution === CATEGORY_APPLICATION_RESOLUTION.CREATE_NEW) {
    await bumpCategoryRegistryCacheVersion()
  }
  return result
}

/** Reject an application with a review reason; CAS + AdminLog in one transaction. */
export async function rejectCategoryApplication(
  adminId: number,
  applicationId: number,
  input: RejectCategoryApplicationInput,
  db: Client = prisma,
): Promise<CategoryApplicationDto> {
  return runInTransaction(db, async tx => {
    const cas = await tx.categoryApplication.updateMany({
      where: { id: applicationId, status: CATEGORY_APPLICATION_STATUS.PENDING },
      data: {
        status: CATEGORY_APPLICATION_STATUS.REJECTED,
        resolution: null,
        approvedCategoryId: null,
        reviewReason: input.reviewReason,
        reviewedByUserId: adminId,
        reviewedAt: new Date(),
      },
    })
    await assertCasOrThrow(tx, applicationId, cas)

    const row = await tx.categoryApplication.findUniqueOrThrow({
      where: { id: applicationId },
      select: applicationSelect,
    })
    await tx.adminLog.create({
      data: {
        adminUserId: adminId,
        action: '拒绝分类申请',
        targetType: 'categoryApplication',
        targetId: applicationId,
        detail: 'resolution=reject',
      },
    })
    return toApplicationDto(row)
  })
}
