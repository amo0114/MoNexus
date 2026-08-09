// B_CAT — pure test fixture helpers for Product.categoryId (D-CAT-09).
//
// Product.categoryId is NOT NULL with no DB default; new writes must supply a
// real category id. Production resolves it through resolveProductCategory; test
// fixtures that hit prisma.product.create/createMany/upsert directly need a
// valid ACTIVE category id. This helper reuses the production
// ensureSeedCategories bootstrap and never hardcodes a numeric id.
//
// Actor policy: prefer reusing an existing platform User as the recorded
// creator/updater so the helper never inflates user-count assertions. Only when
// the database has no User at all is a clearly-named fixture actor created
// (mirroring the migration's own guard — the actor is only bookkeeping; no
// synthetic user beyond that is ever inserted).
//
// No module-level caching: setup.ts truncates the User table (and, via CASCADE,
// ProductCategory) before every test, so any cached id would go stale between
// tests. ensureSeedCategories is create-if-missing and cheap to re-run.
import { prisma } from '../lib/prisma.js'
import { ensureSeedCategories } from '../modules/catalog/bootstrap.js'
import { CATEGORY_STATUS, SEED_CATEGORY_CODE } from '../modules/catalog/constants.js'

export const CATALOG_FIXTURE_ACTOR_EMAIL = 'catalog-fixture-actor@test.local'

async function getSeedActorId(): Promise<number> {
  const existing = await prisma.user.findFirst({
    orderBy: { id: 'asc' },
    select: { id: true },
  })
  if (existing) return existing.id
  const actor = await prisma.user.create({
    data: { email: CATALOG_FIXTURE_ACTOR_EMAIL, password: 'x', role: 'admin' },
  })
  return actor.id
}

async function ensureSeedRows() {
  return ensureSeedCategories(await getSeedActorId())
}

/**
 * Ensure the frozen seed categories exist and return the id of the ACTIVE
 * category whose label equals `label`. Throws if no active seed category has
 * that label (mirrors the resolver's active-only exact-match rule).
 */
export async function getActiveCategoryIdByLabel(label: string): Promise<number> {
  const categories = await ensureSeedRows()
  const category = categories.find(c => c.status === CATEGORY_STATUS.ACTIVE && c.label === label)
  if (!category) {
    throw new Error(`catalogFixture: no ACTIVE category with label "${label}"`)
  }
  return category.id
}

/** The id of the ACTIVE network-node seed category (code `network-node`). */
export async function getActiveNetworkNodeCategoryId(): Promise<number> {
  const categories = await ensureSeedRows()
  const category = categories.find(
    c => c.code === SEED_CATEGORY_CODE.NETWORK_NODE && c.status === CATEGORY_STATUS.ACTIVE,
  )
  if (!category) {
    throw new Error('catalogFixture: ACTIVE network-node seed category missing after ensureSeedCategories')
  }
  return category.id
}
