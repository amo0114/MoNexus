// B_CAT — legacy Product.type → categoryId resolution (SPEC-CATALOG-OPS-001
// §7.1/§7.4; D-CAT-09/D-CAT-22; CAT-012).
//
// Frozen resolution semantics (FND-CMI-001 F0):
//   - explicit active categoryId        → type is derived from category.label
//     (never trusted from the client);
//   - legacy type only                  → exact match against an ACTIVE
//     category's label;
//   - categoryId + legacy type both     → 400 LEGACY_TYPE_WITH_CATEGORY_ID
//     (the schema layer also rejects this before reaching the resolver);
//   - neither, unknown, or blank type   → 400.
//
// §11.2 froze the ONE-TIME historical backfill of unknown/empty legacy types
// into the inactive `legacy-unclassified` category for the migration path
// ONLY. The online path must NOT reproduce that snapshot — an unknown or
// blank old type cannot be explained, so it is rejected (400) instead of
// creating a new unexplainable category snapshot.
//
// The resolver accepts an injectable Prisma/transaction client so callers
// inside a $transaction never open a nested transaction.

import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { HttpError, type ErrorCode } from '../../lib/httpError.js'
import {
  CATALOG_ERROR_CODES,
  CATEGORY_STATUS,
} from './constants.js'

type Client = typeof prisma | Prisma.TransactionClient

export interface ResolveProductCategoryInput {
  categoryId?: number
  /** Legacy Product.type value (label snapshot). */
  type?: string
}

export interface ResolvedProductCategory {
  categoryId: number
  type: string
}

function categoryError(message: string, code: string): HttpError {
  // CATALOG_ERROR_CODES members are a superset of the shared ErrorCode union;
  // they still ride the standard HttpError so the error middleware formats them.
  return new HttpError(400, code as ErrorCode, message)
}

export async function resolveProductCategory(
  input: ResolveProductCategoryInput,
  db: Client = prisma,
): Promise<ResolvedProductCategory> {
  const hasCategoryId = input.categoryId != null
  const typePresent = typeof input.type === 'string'
  const typeValue = (input.type ?? '').trim()
  const hasLegacyType = typePresent && typeValue.length > 0

  // Both supplied → reject. Spec §7.4: categoryId is authoritative; a legacy
  // type is only a compatibility input and must never travel alongside it.
  if (hasCategoryId && typePresent) {
    throw categoryError(
      '不能同时指定 categoryId 与商品类型',
      CATALOG_ERROR_CODES.LEGACY_TYPE_WITH_CATEGORY_ID,
    )
  }

  // Explicit categoryId → must resolve to a real, active category.
  if (hasCategoryId) {
    const category = await db.productCategory.findUnique({
      where: { id: input.categoryId! },
    })
    if (!category) {
      throw categoryError('指定的商品分类不存在', 'BAD_REQUEST')
    }
    if (category.status !== CATEGORY_STATUS.ACTIVE) {
      throw categoryError('指定的商品分类不可用', 'BAD_REQUEST')
    }
    return { categoryId: category.id, type: category.label }
  }

  // Legacy type-only path (spec §7.1/§7.4, D-CAT-09). An old type maps ONLY
  // by exact match to an ACTIVE category's label. §11.2 froze the one-time
  // historical backfill of unknown/empty types to legacy-unclassified for the
  // migration path; the online path must NOT reproduce that snapshot, so an
  // unknown or blank legacy type is rejected (400) instead of creating a new
  // unexplainable category snapshot.
  if (typePresent) {
    if (typeValue.length === 0) {
      throw categoryError('商品类型不能为空白', 'BAD_REQUEST')
    }

    const active = await db.productCategory.findFirst({
      where: { status: CATEGORY_STATUS.ACTIVE, label: typeValue },
    })
    if (active) {
      return { categoryId: active.id, type: typeValue }
    }
    throw categoryError('未知的商品类型，无法映射到正式分类', 'BAD_REQUEST')
  }


  // Neither supplied → reject.
  throw categoryError('必须提供 categoryId 或商品类型', 'BAD_REQUEST')
}
