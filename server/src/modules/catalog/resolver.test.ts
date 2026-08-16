import { describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { ensureSeedCategories } from './bootstrap.js'
import { resolveProductCategory } from './resolver.js'
import { SEED_CATEGORY_CODE } from './constants.js'

/**
 * B_CAT — legacy type → categoryId resolver Red tests
 * (SPEC-CATALOG-OPS-001 §7.1/§7.4, §11.2; D-CAT-09/D-CAT-22; CAT-012).
 *
 *  - explicit categoryId + legacy type both supplied → 400 LEGACY_TYPE_WITH_CATEGORY_ID
 *  - explicit categoryId alone → must exist and be active; type derived from label
 *  - legacy type alone → exact match against an ACTIVE category only; unknown,
 *    blank, or inactive-label values → 400 (the §11.2 historical backfill to
 *    legacy-unclassified is migration-only and is NOT reproduced online)
 *  - neither → 400
 */

async function seedCategories() {
  const actor = await prisma.user.create({
    data: { email: 'resolver-actor@test.local', password: 'x', role: 'admin' },
  })
  return ensureSeedCategories(actor.id)
}

describe('resolveProductCategory', () => {
  it('maps an exact legacy type to the active category with that label', async () => {
    const categories = await seedCategories()
    const network = categories.find(c => c.code === SEED_CATEGORY_CODE.NETWORK_NODE)!

    const resolved = await resolveProductCategory({ type: '网络节点' })
    expect(resolved).toEqual({ categoryId: network.id, type: '网络节点' })
  })

  it('rejects an unknown legacy type instead of falling back to legacy-unclassified', async () => {
    await seedCategories()

    await expect(resolveProductCategory({ type: '虚拟货币' }))
      .rejects.toMatchObject({ status: 400 })
  })

  it('rejects a legacy type that only matches an inactive category label', async () => {
    const categories = await seedCategories()
    const fallback = categories.find(c => c.code === SEED_CATEGORY_CODE.LEGACY_UNCLASSIFIED)!
    // `待归类` is the legacy-unclassified label, but that category is inactive.
    // The online path maps only to ACTIVE labels, so `待归类` must be rejected
    // (no fallback to the same inactive target), matching §11.2's migration-only
    // historical backfill.
    await expect(resolveProductCategory({ type: '待归类' }))
      .rejects.toMatchObject({ status: 400 })
  })

  it('accepts an explicit active categoryId and derives type from the category label', async () => {
    const categories = await seedCategories()
    const shared = categories.find(c => c.code === SEED_CATEGORY_CODE.SHARED_ACCOUNT)!

    const resolved = await resolveProductCategory({ categoryId: shared.id })
    expect(resolved).toEqual({ categoryId: shared.id, type: '共享账号' })
  })

  it('rejects when both categoryId and legacy type are supplied (LEGACY_TYPE_WITH_CATEGORY_ID)', async () => {
    const categories = await seedCategories()
    const network = categories.find(c => c.code === SEED_CATEGORY_CODE.NETWORK_NODE)!

    await expect(resolveProductCategory({ categoryId: network.id, type: '网络节点' }))
      .rejects.toMatchObject({ status: 400, code: 'LEGACY_TYPE_WITH_CATEGORY_ID' })
  })

  it('rejects categoryId with a whitespace-only legacy type as an ambiguous dual input', async () => {
    const categories = await seedCategories()
    const network = categories.find(c => c.code === SEED_CATEGORY_CODE.NETWORK_NODE)!

    await expect(resolveProductCategory({ categoryId: network.id, type: '   ' }))
      .rejects.toMatchObject({ status: 400, code: 'LEGACY_TYPE_WITH_CATEGORY_ID' })
  })

  it('rejects an explicit inactive categoryId (new creates must target active categories)', async () => {
    const categories = await seedCategories()
    const fallback = categories.find(c => c.code === SEED_CATEGORY_CODE.LEGACY_UNCLASSIFIED)!

    await expect(resolveProductCategory({ categoryId: fallback.id }))
      .rejects.toMatchObject({ status: 400 })
  })

  it('rejects an explicit categoryId that does not exist', async () => {
    await seedCategories()
    await expect(resolveProductCategory({ categoryId: 999_999 }))
      .rejects.toMatchObject({ status: 400 })
  })

  it('rejects an input with neither categoryId nor legacy type', async () => {
    await seedCategories()
    await expect(resolveProductCategory({}))
      .rejects.toMatchObject({ status: 400 })
  })

  it('rejects a whitespace-only legacy type (no 待归类 snapshot repair online)', async () => {
    await seedCategories()

    await expect(resolveProductCategory({ type: '   ' }))
      .rejects.toMatchObject({ status: 400 })
  })
})
