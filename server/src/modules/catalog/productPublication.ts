// T-CAT-BE-003 (SPEC-CATALOG-OPS-001 §6; D-CAT-03/D-CAT-04/D-CAT-08/D-CAT-21;
// REQ-CAT-F-002; CHK-PROD-005/006; AC-CAT-002/003/004).
//
// Publish / unpublish are independent, atomic, server-authoritative actions
// (D-CAT-03): the readiness gate runs in the SAME transaction as the status
// CAS, so a concurrent change cannot publish an unready product. The
// transaction performs NO remote I/O (see publicationReadiness.ts).
//
// publishedAt is written on FIRST publish only (D-CAT-04); subsequent
// unpublish/republish cycles keep the original first-publish timestamp.
//
// Unpublish only flips status — inventory, orders and logs are preserved
// (AC-CAT-004); the public/checkout active guard is enforced by the existing
// product read and checkout paths (status=active contract).

import type { Product } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, conflict, HttpError, type ErrorCode, type ErrorDetail } from '../../lib/httpError.js'
import { syncProductProjection } from '../../lib/offers.js'
import { invalidateProductPublicCache } from '../products/cache.js'
import { checkProductReadiness, type ProductReadinessResult } from './publicationReadiness.js'
import { CATALOG_ERROR_CODES, PRODUCT_STATUS } from './constants.js'

export interface PublishOutcome {
  product: Product
  /** False when the target state was already reached (idempotent no-op). */
  changed: boolean
  isFirstPublish: boolean
  /** Readiness diagnostics — populated only when publish was refused. */
  readiness: ProductReadinessResult | null
}

/** Refuse publish with a 422 + stable readiness detail codes (spec §6.1). */
function notReadyError(readiness: ProductReadinessResult): HttpError {
  // ReadinessDetail and the shared ErrorDetail are structurally different on
  // purpose: readiness items carry the stable `code`/`offerId` machine keys the
  // spec freezes. The error middleware passes err.details through verbatim, so
  // the wire shape matches spec §6.1 exactly.
  return new HttpError(
    422,
    CATALOG_ERROR_CODES.PRODUCT_NOT_READY as ErrorCode,
    '商品尚未满足发布条件',
    readiness.details as unknown as ErrorDetail[],
  )
}

/**
 * Publish a draft/inactive product to active after passing the readiness gate.
 * Idempotent: already-active products return the current resource unchanged.
 */
export async function publishProduct(productId: number): Promise<PublishOutcome> {
  const outcome = await prisma.$transaction(async tx => {
    const product = await tx.product.findUniqueOrThrow({ where: { id: productId } })
    if (product.archivedAt) {
      throw new HttpError(
        409,
        CATALOG_ERROR_CODES.PRODUCT_ARCHIVED as ErrorCode,
        '商品已归档，请先恢复后再发布',
      )
    }

    const readiness = await checkProductReadiness(productId, tx)
    if (!readiness.ready) {
      throw notReadyError(readiness)
    }
    if (product.status === PRODUCT_STATUS.ACTIVE) {
      return { product, changed: false, isFirstPublish: readiness.isFirstPublish, readiness: null }
    }
    if (product.status !== PRODUCT_STATUS.DRAFT && product.status !== PRODUCT_STATUS.INACTIVE) {
      throw badRequest('商品当前状态不可发布')
    }

    // Status CAS: only the exact status we read may transition to active,
    // and only while the product is not archived. Concurrent archive must
    // not be revived by a republish that already passed the sequential check.
    const cas = await tx.product.updateMany({
      where: { id: productId, status: product.status, archivedAt: null },
      data: {
        status: PRODUCT_STATUS.ACTIVE,
        // First publish writes publishedAt; republish keeps the original.
        publishedAt: product.publishedAt ?? new Date(),
      },
    })

    if (cas.count !== 1) {
      const fresh = await tx.product.findUniqueOrThrow({ where: { id: productId } })
      if (fresh.archivedAt) {
        throw new HttpError(
          409,
          CATALOG_ERROR_CODES.PRODUCT_ARCHIVED as ErrorCode,
          '商品已归档，请先恢复后再发布',
        )
      }
      if (fresh.status === PRODUCT_STATUS.ACTIVE) {
        return {
          product: fresh,
          changed: false,
          isFirstPublish: readiness.isFirstPublish,
          readiness: null,
        }
      }
      throw conflict('商品状态已变化，请刷新后重试')
    }

    await syncProductProjection(tx, productId)
    const updated = await tx.product.findUniqueOrThrow({ where: { id: productId } })
    return { product: updated, changed: true, isFirstPublish: readiness.isFirstPublish, readiness: null }
  })

  if (outcome.changed) {
    // REQ-CAT-NF-008 / CHK-PROD-005: public list + detail caches must converge
    // after a publish (product becomes visible / re-visible).
    await invalidateProductPublicCache(productId, { detail: true, list: true })
  }
  return outcome
}
/**
 * Unpublish an active product to inactive. Idempotent: non-active products
 * return the current resource unchanged. Inventory/orders/logs are untouched.
 */
export async function unpublishProduct(productId: number): Promise<PublishOutcome> {
  const outcome = await prisma.$transaction(async tx => {
    const product = await tx.product.findUniqueOrThrow({ where: { id: productId } })
    if (product.status !== PRODUCT_STATUS.ACTIVE) {
      return {
        product,
        changed: false,
        isFirstPublish: product.publishedAt == null,
        readiness: null,
      }
    }

    const cas = await tx.product.updateMany({
      where: { id: productId, status: PRODUCT_STATUS.ACTIVE },
      data: { status: PRODUCT_STATUS.INACTIVE },
    })

    if (cas.count !== 1) {
      const fresh = await tx.product.findUniqueOrThrow({ where: { id: productId } })
      if (fresh.status !== PRODUCT_STATUS.ACTIVE) {
        return {
          product: fresh,
          changed: false,
          isFirstPublish: fresh.publishedAt == null,
          readiness: null,
        }
      }
      throw conflict('商品状态已变化，请刷新后重试')
    }

    const updated = await tx.product.findUniqueOrThrow({ where: { id: productId } })
    return {
      product: updated,
      changed: true,
      isFirstPublish: updated.publishedAt == null,
      readiness: null,
    }
  })

  if (outcome.changed) {
    await invalidateProductPublicCache(productId, { detail: true, list: true })
  }
  return outcome
}
