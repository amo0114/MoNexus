import { prisma } from '../../lib/prisma.js'
import { notFound } from '../../lib/httpError.js'
import { listProducts } from '../products/service.js'
import type { ProductAudience } from '../products/visibility.js'

export const SHOP_PAGE_SIZE = 24
const SHOP_DESCRIPTION_MAX_CHARS = 500

function publicShopDescription(description: string | null) {
  const text = description?.trim()
  if (!text) return null
  const chars = Array.from(text)
  return chars.length > SHOP_DESCRIPTION_MAX_CHARS
    ? `${chars.slice(0, SHOP_DESCRIPTION_MAX_CHARS).join('')}…`
    : text
}

export async function listShopProducts(
  merchantId: number,
  params: { query?: string; cursor?: string; audience: ProductAudience },
) {
  // Read on every request: a cached product page must not keep a suspended shop open.
  const merchant = await prisma.merchant.findFirst({
    where: { id: merchantId, status: 'active' },
    select: { id: true, name: true, description: true },
  })
  if (!merchant) throw notFound('店铺暂不可用')

  const { items, nextCursor, hasMore } = await listProducts({
    merchantId,
    query: params.query,
    cursor: params.cursor,
    pageSize: SHOP_PAGE_SIZE,
    audience: params.audience,
  })
  return {
    shop: { id: merchant.id, name: merchant.name, description: publicShopDescription(merchant.description) },
    items,
    nextCursor,
    hasMore,
  }
}
