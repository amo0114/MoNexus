// T-CAT-BE-001 — Category repository + admin governance (SPEC-CATALOG-OPS-001
// §7.2; D-CAT-06/D-CAT-07; REQ-CAT-F-007; CHK-CAT-001~004, 012).
//
// Domain rules enforced here that the schema cannot see:
//   - code is immutable after creation (D-CAT-06) → code PATCH rejected;
//   - code/normalizedLabel are globally unique and code is never reused, even
//     after a category is deactivated (§5.1);
//   - DELETE is a logical delete/tombstone (row preserved, set inactive) so a
//     code stays reserved forever (CAT-010); a referenced category is still
//     refused with CATEGORY_REFERENCED — never silently deactivated (D-CAT-07,
//     AC-CAT-011);
//   - activate/deactivate use a status CAS (updateMany where id + opposite
//     status) so concurrent transitions are safe and idempotent;
//   - reorder is transactional (last-write-wins) and never partially applies;
//   - every mutation writes an AdminLog (detail = field/status names only, no
//     rich text) inside the same DB transaction as the mutation, and bumps the
//     public registry generation so caches converge without a restart
//     (REQ-CAT-NF-008, AC-CAT-026).

import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, HttpError, notFound, type ErrorCode } from '../../lib/httpError.js'
import {
  CATALOG_ERROR_CODES,
  CATEGORY_STATUS,
  type CatalogErrorCode,
  type CategoryStatus,
} from './constants.js'
import type { CategoryAdminDto } from './contracts.js'
import { normalizeCategoryLabel, type CreateCategoryInput, type ListCategoriesQuery, type UpdateCategoryInput } from './categorySchema.js'
import { bumpCategoryRegistryCacheVersion } from './registry.js'
import { bumpProductListVersionCoalesced } from '../../lib/cache.js'
import {
  MediaRefResolutionError,
  resolveLegacyPlatformImageUrl,
  resolvePlatformPublicImage,
} from './platformMedia.js'

type Client = typeof prisma | Prisma.TransactionClient

const adminSelect = {
  id: true,
  code: true,
  label: true,
  normalizedLabel: true,
  description: true,
  iconKey: true,
  defaultCoverUrl: true,
  sortOrder: true,
  status: true,
  createdByUserId: true,
  updatedByUserId: true,
  createdAt: true,
  updatedAt: true,
} as const

type AdminCategoryRow = Prisma.ProductCategoryGetPayload<{ select: typeof adminSelect }>

export function categoryHttpError(status: number, code: CatalogErrorCode, message: string): HttpError {
  // CATALOG_ERROR_CODES members are a superset of the shared ErrorCode union;
  // they still ride the standard HttpError so the error middleware formats them
  // (same pattern as catalog/resolver.ts).
  return new HttpError(status, code as ErrorCode, message)
}

/**
 * Run a cover resolver and project its stable failure to a 400 COVER_INVALID
 * HttpError so the API contract stays code-keyed (SPEC-CMI-UX-001 §6.2).
 */
async function resolveCategoryCover(
  resolver: () => Promise<{ canonicalUrl: string }>,
): Promise<string> {
  try {
    const resolved = await resolver()
    return resolved.canonicalUrl
  } catch (err) {
    if (err instanceof MediaRefResolutionError) {
      throw categoryHttpError(400, CATALOG_ERROR_CODES.COVER_INVALID, err.message)
    }
    throw err
  }
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

/**
 * Run a callback inside one DB transaction. The top-level singleton opens an
 * interactive transaction; a caller-provided transaction client runs the
 * callback directly so no nested transaction is ever opened.
 */
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

async function writeCategoryAdminLog(
  db: Client,
  adminId: number,
  action: string,
  targetId: number | null,
  detail: string,
): Promise<void> {
  await db.adminLog.create({
    data: {
      adminUserId: adminId,
      action,
      targetType: 'productCategory',
      targetId,
      detail,
    },
  })
}

function toAdminDto(row: AdminCategoryRow): CategoryAdminDto {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    normalizedLabel: row.normalizedLabel,
    description: row.description,
    iconKey: row.iconKey,
    defaultCoverUrl: row.defaultCoverUrl,
    sortOrder: row.sortOrder,
    status: row.status as CategoryStatus,
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function listAdminCategories(
  query: ListCategoriesQuery,
  db: Client = prisma,
) {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 20
  const where: Prisma.ProductCategoryWhereInput = {}
  if (query.status) where.status = query.status

  const [total, items] = await Promise.all([
    db.productCategory.count({ where }),
    db.productCategory.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: adminSelect,
    }),
  ])

  return { items: items.map(toAdminDto), total, page, pageSize }
}

export async function createCategory(
  adminId: number,
  input: CreateCategoryInput,
  db: Client = prisma,
): Promise<CategoryAdminDto> {
  const code = input.code.trim()
  const normalizedLabel = normalizeCategoryLabel(input.label)

  // Friendly pre-checks; the DB unique constraints + P2002 mapping below are the
  // race-safe authority (code is never reused even after deactivation, §5.1).
  const codeExists = await db.productCategory.findUnique({ where: { code }, select: { id: true } })
  if (codeExists) {
    throw categoryHttpError(409, CATALOG_ERROR_CODES.CATEGORY_CODE_TAKEN, '分类编码已存在，且停用后不可复用')
  }
  const labelExists = await db.productCategory.findUnique({
    where: { normalizedLabel },
    select: { id: true },
  })
  if (labelExists) {
    throw categoryHttpError(409, CATALOG_ERROR_CODES.CATEGORY_LABEL_TAKEN, '分类名称已存在')
  }

  try {
    const row = await runInTransaction(db, async tx => {
      // D-UX-11 / §5.4: a new category is always created active, so a
      // resolvable default cover is mandatory. The resolve happens inside the
      // same transaction as the write (atomic gate, AC-UX-015).
      let defaultCoverUrl: string | null = null
      if (input.defaultCover !== undefined) {
        if (input.defaultCover !== null) {
          const coverRef = input.defaultCover
          defaultCoverUrl = await resolveCategoryCover(() => resolvePlatformPublicImage(coverRef, tx))
        }
      } else if (input.defaultCoverUrl?.trim()) {
        const legacyUrl = input.defaultCoverUrl.trim()
        defaultCoverUrl = await resolveCategoryCover(() => resolveLegacyPlatformImageUrl(legacyUrl, tx))
      }
      if (!defaultCoverUrl) {
        throw categoryHttpError(400, CATALOG_ERROR_CODES.COVER_REQUIRED, '请上传一张分类默认封面')
      }
      const created = await tx.productCategory.create({
        data: {
          code,
          label: input.label,
          normalizedLabel,
          // Normalize empty strings to null (same semantics as the schema's
          // emptyToUnset/emptyToNull) so direct service callers can't store ''.
          description: input.description?.trim() ? input.description : null,
          iconKey: input.iconKey?.trim() ? input.iconKey : null,
          defaultCoverUrl,
          sortOrder: input.sortOrder ?? 0,
          status: CATEGORY_STATUS.ACTIVE,
          createdByUserId: adminId,
          updatedByUserId: adminId,
        },
        select: adminSelect,
      })
      await writeCategoryAdminLog(tx, adminId, '创建分类', created.id, `code=${code}`)
      return created
    })
    await bumpCategoryRegistryCacheVersion()
    return toAdminDto(row)
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
}

export async function updateCategory(
  adminId: number,
  id: number,
  input: UpdateCategoryInput,
  db: Client = prisma,
): Promise<CategoryAdminDto> {
  // D-CAT-06: code is immutable after creation. The route rejects it before
  // validation too; this guard also protects direct service callers.
  if ('code' in input) {
    throw categoryHttpError(400, CATALOG_ERROR_CODES.CATEGORY_CODE_IMMUTABLE, '分类编码创建后不可修改')
  }

  const existing = await db.productCategory.findUnique({
    where: { id },
    select: { id: true, status: true, defaultCoverUrl: true },
  })
  if (!existing) throw notFound('分类不存在')

  const data: Prisma.ProductCategoryUpdateInput = { updatedByUser: { connect: { id: adminId } } }
  if (input.label !== undefined) {
    const normalizedLabel = normalizeCategoryLabel(input.label)
    const duplicate = await db.productCategory.findFirst({
      where: { normalizedLabel, id: { not: id } },
      select: { id: true },
    })
    if (duplicate) {
      throw categoryHttpError(409, CATALOG_ERROR_CODES.CATEGORY_LABEL_TAKEN, '分类名称已存在')
    }
    data.label = input.label
    data.normalizedLabel = normalizedLabel
  }
  if (input.description !== undefined) data.description = input.description
  if (input.iconKey !== undefined) data.iconKey = input.iconKey
      // Cover replace/remove gates (SPEC-CMI-UX-001 §5.4, AC-UX-015):
      //   - active replace: resolve the new cover first; on failure nothing is
      //     written (old value kept);
      //   - active remove: rejected with the old value preserved; inactive
      //     remove is allowed;
      //   - legacy unresolved covers cannot be written (must be replaced).
      if (input.defaultCover !== undefined || input.defaultCoverUrl !== undefined) {
        let nextUrl: string | null
        if (input.defaultCover !== undefined) {
          if (input.defaultCover === null) {
            nextUrl = null
          } else {
            const coverRef = input.defaultCover
            nextUrl = await resolveCategoryCover(() => resolvePlatformPublicImage(coverRef))
          }
        } else {
          const legacy = input.defaultCoverUrl
          if (legacy == null || legacy.trim() === '') {
            nextUrl = null
          } else {
            const legacyUrl = legacy.trim()
            nextUrl = await resolveCategoryCover(() => resolveLegacyPlatformImageUrl(legacyUrl))
          }
        }
        if (nextUrl === null && existing.status === CATEGORY_STATUS.ACTIVE) {
          throw categoryHttpError(400, CATALOG_ERROR_CODES.COVER_REQUIRED, '启用中的分类必须保留默认封面')
        }
        data.defaultCoverUrl = nextUrl
      }
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder

  try {
    const row = await runInTransaction(db, async tx => {
      const updated = await tx.productCategory.update({ where: { id }, data, select: adminSelect })
      const changed = Object.keys(input)
        .filter(key => input[key as keyof UpdateCategoryInput] !== undefined)
        .join(',')
      await writeCategoryAdminLog(tx, adminId, '更新分类', id, `fields=${changed || 'none'}`)
      return updated
    })
    await bumpCategoryRegistryCacheVersion()
    // CHK-CAT-012: public product list caches embed category DTOs — a label or
    // other public-field change must invalidate them too, not wait out the TTL.
    await bumpProductListVersionCoalesced()
    return toAdminDto(row)
  } catch (err) {
    if (isUniqueError(err, 'normalizedLabel')) {
      throw categoryHttpError(409, CATALOG_ERROR_CODES.CATEGORY_LABEL_TAKEN, '分类名称已存在')
    }
    if (isPrismaErrorCode(err, 'P2002')) {
      throw categoryHttpError(409, CATALOG_ERROR_CODES.CATEGORY_LABEL_TAKEN, '分类名称已存在')
    }
    throw err
  }
}

/**
 * CAS status transition: updateMany against the opposite status makes
 * concurrent transitions safe and idempotent (a no-op on an already-target
 * row returns the current state without a redundant AdminLog).
 */
async function setCategoryStatus(
  adminId: number,
  id: number,
  targetStatus: CategoryStatus,
  action: string,
  db: Client = prisma,
): Promise<CategoryAdminDto> {
  const opposite = targetStatus === CATEGORY_STATUS.ACTIVE
    ? CATEGORY_STATUS.INACTIVE
    : CATEGORY_STATUS.ACTIVE

      // D-UX-11 / §5.4: inactive → active requires a resolvable default cover.
      // A legacy cover that can no longer be resolved must be replaced before
      // activating (AC-UX-015).
      if (targetStatus === CATEGORY_STATUS.ACTIVE) {
        const current = await db.productCategory.findUnique({
          where: { id },
          select: { status: true, defaultCoverUrl: true },
        })
        if (current && current.status === CATEGORY_STATUS.INACTIVE) {
          if (!current.defaultCoverUrl) {
            throw categoryHttpError(400, CATALOG_ERROR_CODES.COVER_REQUIRED, '启用分类前请先设置默认封面')
          }
          try {
            await resolveLegacyPlatformImageUrl(current.defaultCoverUrl, db)
          } catch {
            throw categoryHttpError(400, CATALOG_ERROR_CODES.COVER_INVALID, '现有默认封面已失效，请先替换封面再启用')
          }
        }
      }
  const row = await runInTransaction(db, async tx => {
    const updated = await tx.productCategory.updateMany({
      where: { id, status: opposite },
      data: { status: targetStatus, updatedByUserId: adminId },
    })

    if (updated.count === 1) {
      const current = await tx.productCategory.findUniqueOrThrow({ where: { id }, select: adminSelect })
      await writeCategoryAdminLog(tx, adminId, action, id, `status=${targetStatus}`)
      return current
    }

    // CAS missed: the row either no longer exists or is already in target state.
    const existing = await tx.productCategory.findUnique({ where: { id }, select: adminSelect })
    if (!existing) throw notFound('分类不存在')
    return existing
  })

  await bumpCategoryRegistryCacheVersion()
  // CHK-CAT-012: a status flip changes the category DTO embedded in public
  // product lists, so invalidate that scope as well.
  await bumpProductListVersionCoalesced()
  return toAdminDto(row)
}

export function activateCategory(adminId: number, id: number, db: Client = prisma) {
  return setCategoryStatus(adminId, id, CATEGORY_STATUS.ACTIVE, '启用分类', db)
}

export function deactivateCategory(adminId: number, id: number, db: Client = prisma) {
  return setCategoryStatus(adminId, id, CATEGORY_STATUS.INACTIVE, '停用分类', db)
}

export async function reorderCategories(
  adminId: number,
  orderedIds: number[],
  db: Client = prisma,
): Promise<{ updated: number }> {
  if (orderedIds.length === 0) throw badRequest('排序列表不能为空')
  const unique = new Set(orderedIds)
  if (unique.size !== orderedIds.length) throw badRequest('排序列表包含重复分类')

  // Existence validation happens INSIDE the transaction: every target row is
  // locked in stable ascending id order (FOR UPDATE), so the exact-count check
  // and the writes are atomic — a concurrent delete can never slip between
  // validation and application. Locking all ids in the same order keeps every
  // concurrent reorder acquiring locks in an identical order, so there is no
  // deadlock-prone inconsistent lock order.
  await runInTransaction(db, async tx => {
    const sortedIds = [...orderedIds].sort((a, b) => a - b)
    const locked = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT "id" FROM "ProductCategory"
      WHERE "id" IN (${Prisma.join(sortedIds)})
      ORDER BY "id"
      FOR UPDATE
    `

    // Exact-count verification inside the tx: if a target disappeared between
    // the request and the lock, reject the whole batch (rolls back everything).
    if (locked.length !== orderedIds.length) throw badRequest('排序列表包含不存在的分类')

    // Last-write-wins within one transaction so a concurrent reorder never
    // leaves a partially-applied permutation. Each row is verified to have
    // updated; any mismatch aborts and rolls back every earlier update.
    for (let index = 0; index < orderedIds.length; index++) {
      const updated = await tx.productCategory.updateMany({
        where: { id: orderedIds[index] },
        data: { sortOrder: (index + 1) * 10, updatedByUserId: adminId },
      })
      if (updated.count !== 1) throw badRequest('排序列表包含不存在的分类')
    }

    // AdminLog only after every update succeeded (same tx — atomic with writes).
    await writeCategoryAdminLog(tx, adminId, '调整分类排序', null, `count=${orderedIds.length}`)
  })

  await bumpCategoryRegistryCacheVersion()
  return { updated: orderedIds.length }
}

export async function deleteCategory(
  adminId: number,
  id: number,
  db: Client = prisma,
): Promise<{ deleted: boolean; id: number }> {
  // Frozen CAT-010: a category code is never reused, even after removal. DELETE
  // is therefore a logical delete / tombstone — the ProductCategory row is
  // preserved and flipped to inactive in the same transaction as the AdminLog.
  // `deleted: true` means "removed from the active registry"; the row and code
  // stay reserved so the code can never be recreated (D-CAT-06 §5.1).
  await runInTransaction(db, async tx => {
    const category = await tx.productCategory.findUnique({
      where: { id },
      select: {
        id: true,
        code: true,
        _count: { select: { products: true, approvedApplications: true } },
      },
    })
    if (!category) throw notFound('分类不存在')

    // D-CAT-07 / AC-CAT-011: a category referenced by Product or an approved
    // application can only be deactivated via the explicit endpoint — DELETE
    // must never silently deactivate it, so it still returns CATEGORY_REFERENCED.
    if (category._count.products > 0 || category._count.approvedApplications > 0) {
      throw categoryHttpError(
        409,
        CATALOG_ERROR_CODES.CATEGORY_REFERENCED,
        '分类已被商品或申请引用，无法删除；可先停用该分类',
      )
    }

    // Logical delete: preserve the row and set status=inactive (CAS so a
    // repeated delete of an already-tombstoned row is an idempotent no-op).
    // The status flip and the AdminLog commit atomically; throwing above rolls
    // the whole transaction back.
    const updated = await tx.productCategory.updateMany({
      where: { id, status: { not: CATEGORY_STATUS.INACTIVE } },
      data: { status: CATEGORY_STATUS.INACTIVE, updatedByUserId: adminId },
    })
    if (updated.count === 1) {
      await writeCategoryAdminLog(tx, adminId, '删除分类', id, `code=${category.code}`)
    }
  })

  await bumpCategoryRegistryCacheVersion()
  // CHK-CAT-012: tombstoning flips the category to inactive, changing the DTO
  // embedded in public product lists — invalidate that scope too.
  await bumpProductListVersionCoalesced()
  return { deleted: true, id }
}
