import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { listSponsoredItems } from '../merchandising/promotions/publicSponsored.js'
import { listEditorialShelf } from '../merchandising/editorial/publicShelf.js'
import { getPublicProductCardsByIds } from '../products/service.js'
import type { ProductAudience } from '../products/visibility.js'
import type { CandidatesQuery } from './schema.js'

const CANDIDATE_LIMIT = 6

/** Compose public candidates without caching hydrated cards or calling details. */
export async function listStorefrontCandidates(query: CandidatesQuery, audience: ProductAudience) {
  const [{ now }] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AT TIME ZONE 'UTC' AS now`
  const empty = { version: 1 as const, generatedAt: now.toISOString(), sponsored: [], editorial: [] }
  if (query.categoryCode) {
    const category = await prisma.productCategory.findFirst({
      where: {
        code: query.categoryCode, status: 'active',
        ...(audience === 'guest' ? { guestVisibility: 'public' } : {}),
      },
      select: { id: true },
    })
    // Unknown and inaccessible categories are indistinguishable to visitors.
    if (!category) return empty
  }
  const [sponsoredResult, editorialResult] = await Promise.allSettled([
    listSponsoredItems({
      placement: query.categoryCode ? 'category_sponsored' : 'store_home_sponsored',
      categoryCode: query.categoryCode, limit: CANDIDATE_LIMIT,
    }, undefined, now.getTime(), audience),
    listEditorialShelf({
      placement: query.categoryCode ? 'category_editorial' : 'store_editorial',
      categoryCode: query.categoryCode, limit: CANDIDATE_LIMIT,
    }, audience, now),
  ])
  for (const [source, result] of [['sponsored', sponsoredResult], ['editorial', editorialResult]] as const) {
    if (result.status === 'rejected') {
      // Do not log candidate payloads, SQL, credentials or consumer identities.
      logger.warn({ component: 'storefront', source, reason: 'candidate_selection_failed' }, 'storefront candidates degraded')
    }
  }
  const sponsored = sponsoredResult.status === 'fulfilled' ? sponsoredResult.value : []
  const editorial = editorialResult.status === 'fulfilled' ? editorialResult.value : []
  const ids = [...new Set([...sponsored, ...editorial].map(item => item.productId))]
  if (!ids.length) return empty
  // This use case rechecks current visibility, merchant state, availability and
  // merchandising. Union IDs are hydrated once, with at most twelve cards.
  const { items } = await getPublicProductCardsByIds(ids, audience)
  const byId = new Map(items
    .filter(item => !query.categoryCode || item.category?.code === query.categoryCode)
    .map(item => [item.id, item]))
  return {
    version: 1 as const,
    generatedAt: now.toISOString(),
    sponsored: sponsored.flatMap(item => {
      const product = byId.get(item.productId)
      return product ? [{ productId: item.productId, product, disclosure: { code: 'sponsored' as const, label: '推广' as const } }] : []
    }),
    editorial: editorial.flatMap(item => {
      const product = byId.get(item.productId)
      return product ? [{ productId: item.productId, product, publicReason: item.publicReason, label: '精选' as const }] : []
    }),
  }
}
