import { Prisma } from '@prisma/client'
import { HttpError, notFound } from '../../lib/httpError.js'
import { CATALOG_ERROR_CODES } from '../catalog/constants.js'
import type { AuthPayload } from '../../middlewares/auth.js'

export type ProductAudience = 'guest' | 'member'

export type PublicProductAccessRow = {
  status: string
  archivedAt: Date | null
  visibility?: string | null
  merchantId?: number | null
  merchant?: { status: string } | null
}

export function resolveProductAudience(user: AuthPayload | undefined): ProductAudience {
  return user?.userId ? 'member' : 'guest'
}

export function publicVisibilityWhere(audience: ProductAudience): Prisma.ProductWhereInput {
  const base: Prisma.ProductWhereInput = {
    status: 'active',
    archivedAt: null,
    OR: [{ merchantId: null }, { merchant: { status: 'active' } }],
  }
  if (audience === 'guest') return { ...base, visibility: 'public' }
  return base
}

export function guestVisibilitySql(): Prisma.Sql {
  return Prisma.sql`p."visibility" = 'public'`
}

export function merchantVisibleSql(): Prisma.Sql {
  return Prisma.sql`(p."merchantId" IS NULL OR EXISTS (
    SELECT 1 FROM "Merchant" m WHERE m."id" = p."merchantId" AND m."status" = 'active'
  ))`
}

export function assertPublicProductAccess(
  product: PublicProductAccessRow,
  audience: ProductAudience,
): void {
  if (product.status !== 'active' || product.archivedAt) {
    throw notFound('商品暂不可用')
  }
  if (product.merchantId != null && product.merchant?.status !== 'active') {
    throw notFound('商品暂不可用')
  }
  if ((product.visibility ?? 'members_only') === 'members_only' && audience === 'guest') {
    throw new HttpError(
      403,
      CATALOG_ERROR_CODES.PRODUCT_LOGIN_REQUIRED,
      '登录后查看商品',
    )
  }
}

export function isCurrentlyPubliclyVisible(
  product: PublicProductAccessRow,
  audience: ProductAudience,
): boolean {
  if (product.status !== 'active' || product.archivedAt) return false
  if (product.merchantId != null && product.merchant?.status !== 'active') return false
  if ((product.visibility ?? 'members_only') === 'members_only' && audience === 'guest') return false
  return true
}
