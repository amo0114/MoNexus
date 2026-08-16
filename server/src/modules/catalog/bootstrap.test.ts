import { describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { ensureSeedCategories } from './bootstrap.js'
import { CATEGORY_SEED_CODES, SEED_CATEGORY_CODE } from './constants.js'

/**
 * B_CAT — catalog category bootstrap Red tests (SPEC-CATALOG-OPS-001 §11.2).
 *
 * The bootstrap must idempotently materialise the SAME five frozen seed codes
 * that the F0 migration 20260809020000 seeds (network-node / shared-account /
 * recharge-card / invite-code active + legacy-unclassified inactive) so the
 * application bootstrap never diverges from the migration seed.
 */
describe('catalog seed category bootstrap', () => {
  it('seeds exactly the 5 frozen codes with the F0 seed attributes', async () => {
    const actor = await prisma.user.create({
      data: { email: 'bootstrap-actor-1@test.local', password: 'x', role: 'admin' },
    })

    const categories = await ensureSeedCategories(actor.id)
    const codes = categories.map(c => c.code).sort()
    expect(codes).toEqual([...CATEGORY_SEED_CODES].sort())

    const byCode = new Map(categories.map(c => [c.code, c]))
    expect(byCode.get(SEED_CATEGORY_CODE.NETWORK_NODE)).toMatchObject({
      label: '网络节点', sortOrder: 10, status: 'active',
    })
    expect(byCode.get(SEED_CATEGORY_CODE.SHARED_ACCOUNT)).toMatchObject({
      label: '共享账号', sortOrder: 20, status: 'active',
    })
    expect(byCode.get(SEED_CATEGORY_CODE.RECHARGE_CARD)).toMatchObject({
      label: '充值卡密', sortOrder: 30, status: 'active',
    })
    expect(byCode.get(SEED_CATEGORY_CODE.INVITE_CODE)).toMatchObject({
      label: '邀请码', sortOrder: 40, status: 'active',
    })
    expect(byCode.get(SEED_CATEGORY_CODE.LEGACY_UNCLASSIFIED)).toMatchObject({
      label: '待归类', sortOrder: 0, status: 'inactive',
    })
  })

  it('is idempotent: re-running reuses the same rows without duplicates', async () => {
    const actor = await prisma.user.create({
      data: { email: 'bootstrap-actor-2@test.local', password: 'x', role: 'admin' },
    })

    const first = await ensureSeedCategories(actor.id)
    const second = await ensureSeedCategories(actor.id)

    expect(await prisma.productCategory.count()).toBe(5)
    expect(second.map(c => c.id).sort((a, b) => a - b))
      .toEqual(first.map(c => c.id).sort((a, b) => a - b))
    expect(second.map(c => c.code).sort()).toEqual(first.map(c => c.code).sort())
  })

  it('never mutates an already-seeded row on re-run (code/label/sortOrder/status stable)', async () => {
    const actor = await prisma.user.create({
      data: { email: 'bootstrap-actor-3@test.local', password: 'x', role: 'admin' },
    })

    await ensureSeedCategories(actor.id)
    const before = await prisma.productCategory.findFirstOrThrow({
      where: { code: SEED_CATEGORY_CODE.NETWORK_NODE },
    })
    // Simulate a re-run after the platform has renamed the display label.
    await prisma.productCategory.update({
      where: { id: before.id },
      data: { label: '节点代理' },
    })
    await ensureSeedCategories(actor.id)

    const after = await prisma.productCategory.findUniqueOrThrow({ where: { id: before.id } })
    // Bootstrap is create-if-missing only; it must not overwrite runtime edits.
    expect(after.label).toBe('节点代理')
    expect(after.sortOrder).toBe(before.sortOrder)
    expect(after.status).toBe(before.status)
    expect(await prisma.productCategory.count()).toBe(5)
  })

  it('records the platform actor as creator/updater on seeded rows', async () => {
    const actor = await prisma.user.create({
      data: { email: 'bootstrap-actor-4@test.local', password: 'x', role: 'admin' },
    })

    await ensureSeedCategories(actor.id)
    const rows = await prisma.productCategory.findMany()
    for (const row of rows) {
      expect(row.createdByUserId).toBe(actor.id)
      expect(row.updatedByUserId).toBe(actor.id)
    }
  })
})
