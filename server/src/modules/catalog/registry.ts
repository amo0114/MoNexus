// T-CAT-BE-001 — Public category registry (SPEC-CATALOG-OPS-001 §7.1).
//
// The registry is the ONLY public category list. It returns active categories
// only, ordered by (sortOrder ASC, id ASC), with a short-TTL Redis-backed cache
// (REQ-CAT-NF-002, CHK-PERF-001). Every category mutation bumps the registry
// generation via bumpCategoryRegistryCacheVersion() so public reads converge
// across instances without a process restart (REQ-CAT-NF-008, AC-CAT-026).
//
// Legacy `productTypes` is projected from the same active category rows and
// flagged `deprecated: true` — it is never read from the hard-coded
// businessRegistry anymore (D-CAT-05, §7.1).

import {
  bumpCacheVersion,
  getCacheVersion,
  makeCacheKey,
  wrapCache,
} from '../../lib/cache.js'
import { prisma } from '../../lib/prisma.js'
import { CATEGORY_STATUS } from './constants.js'
import type { CategoryRegistryItem, LegacyProductTypeCompat } from './contracts.js'

export const CATEGORY_REGISTRY_CACHE_TTL_SEC = 60

export interface PublicCategoryRegistry {
  productCategories: CategoryRegistryItem[]
  productTypes: LegacyProductTypeCompat[]
}

/** Invalidate the public registry after any category mutation. */
export async function bumpCategoryRegistryCacheVersion(): Promise<void> {
  await bumpCacheVersion({ name: 'category-registry' })
}

async function buildRegistryCacheKey(): Promise<string | null> {
  const version = await getCacheVersion({ name: 'category-registry' })
  if (version == null) return null
  return makeCacheKey('registry', 'product-categories', version)
}

async function loadRegistry(): Promise<PublicCategoryRegistry> {
  const rows = await prisma.productCategory.findMany({
    where: { status: CATEGORY_STATUS.ACTIVE },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: { id: true, code: true, label: true, iconKey: true, sortOrder: true },
  })

  return {
    productCategories: rows.map(row => ({
      id: row.id,
      code: row.code,
      label: row.label,
      iconKey: row.iconKey,
      sortOrder: row.sortOrder,
    })),
    productTypes: rows.map(row => ({
      value: row.label,
      label: row.label,
      deprecated: true as const,
    })),
  }
}

export async function getPublicCategoryRegistry(): Promise<PublicCategoryRegistry> {
  const key = await buildRegistryCacheKey()
  if (!key) return loadRegistry()
  return wrapCache('category-registry', key, CATEGORY_REGISTRY_CACHE_TTL_SEC, loadRegistry)
}
