import { describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { ensureSeedCategories } from '../modules/catalog/bootstrap.js'
import { SEED_CATEGORY_CODE } from '../modules/catalog/constants.js'
import { getActiveNetworkNodeCategoryId } from './catalogFixture.js'

/**
 * B_CAT — catalogFixture helper Red tests.
 *
 * getActiveNetworkNodeCategoryId must return the id of the network-node seed
 * category ONLY while it is ACTIVE (the same active-only rule the resolver
 * enforces for explicit categoryId / legacy-type mapping, D-CAT-09). If the
 * category exists but is inactive it must reject instead of handing back a
 * categoryId the resolver would refuse.
 */
describe('catalogFixture.getActiveNetworkNodeCategoryId', () => {
  it('returns the id of the ACTIVE network-node seed category', async () => {
    const actor = await prisma.user.create({
      data: { email: 'fixture-active-actor@test.local', password: 'x', role: 'admin' },
    })
    const categories = await ensureSeedCategories(actor.id)
    const network = categories.find(c => c.code === SEED_CATEGORY_CODE.NETWORK_NODE)!
    expect(network.status).toBe('active')

    await expect(getActiveNetworkNodeCategoryId()).resolves.toBe(network.id)
  })

  it('rejects when the network-node seed category is inactive', async () => {
    const actor = await prisma.user.create({
      data: { email: 'fixture-inactive-actor@test.local', password: 'x', role: 'admin' },
    })
    const categories = await ensureSeedCategories(actor.id)
    const network = categories.find(c => c.code === SEED_CATEGORY_CODE.NETWORK_NODE)!
    await prisma.productCategory.update({
      where: { id: network.id },
      data: { status: 'inactive' },
    })

    await expect(getActiveNetworkNodeCategoryId()).rejects.toThrow(/ACTIVE network-node/)
  })
})
