import { api } from '../../__tests__/helpers.js'
import { describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { getActiveNetworkNodeCategoryId } from '../../__tests__/catalogFixture.js'
import { listEditorialShelf } from '../merchandising/editorial/publicShelf.js'
import { filterSponsoredByAudience } from '../merchandising/promotions/publicSponsored.js'

/**
 * SPEC-CATALOG-VIS-001 §3.4 / §8.1 —— 推广与精选入口在受限分类下的实测。
 *
 * 前几轮我一直用「代码审计 + 类型收紧了 select」推断这两个入口已被拦住，
 * 没有一条用例真的驱动它们。方案 §8.1 明确要求「覆盖列表、搜索、详情、
 * 评价、推荐、店铺、推广、精选、榜单、registry 和分享」，而推广/精选
 * 恰恰是「详情拒绝、卡片仍出现」的典型漏点（§3.3 的原话）。
 *
 * 本文件直接调用两个 shelf 的 service 函数（不经 HTTP），验证：
 *   同一件商品在分类 public 时对游客出现，收紧为 members_only 后消失，
 *   而 member 不受影响。
 */

async function makeActorId(): Promise<number> {
  const actor = await prisma.user.upsert({
    where: { email: 'merch-vis-actor@test.local' },
    update: {},
    create: { email: 'merch-vis-actor@test.local', password: 'x', role: 'admin' },
    select: { id: true },
  })
  return actor.id
}

/** 造一件可上推广/精选的商品：public + active + 有 active offer + 有分类。 */
async function makePromotableProduct(name: string, categoryId?: number) {
  const cid = categoryId ?? await getActiveNetworkNodeCategoryId()
  const product = await prisma.product.create({
    data: {
      name,
      type: '网络节点',
      categoryId: cid,
      price: 30,
      stock: 3,
      status: 'active',
      visibility: 'public',
    },
  })
  // SPEC-CATALOG-VIS-001 §4.2（P1.5）：游客可见还要求当前内容版本已批准。
  await prisma.productGuestEligibility.create({
    data: { productId: product.id, decision: 'approved', reviewedRevision: 1 },
  })
  await prisma.offer.create({
    data: {
      productId: product.id,
      name: '默认规格',
      isDefault: true,
      price: 30,
      stock: 3,
      status: 'active',
    },
  })
  return product
}

/** 造一个自定义分类，返回 id。 */
async function makeCategory(code: string, guestVisibility: 'public' | 'members_only') {
  const actorId = await makeActorId()
  const cat = await prisma.productCategory.create({
    data: {
      code,
      label: `精选分类${code}`,
      normalizedLabel: `精选分类${code}`.toLowerCase(),
      guestVisibility,
      status: 'active',
      createdByUserId: actorId,
      updatedByUserId: actorId,
    },
  })
  return cat.id
}

describe('SPEC-CATALOG-VIS-001 §3.4 精选入口受分类可见性约束', () => {
  it('分类 public 时游客可见；收紧为 members_only 后游客消失、member 仍在', async () => {
    const actorId = await makeActorId()
    const categoryId = await makeCategory('merch-vis-editorial', 'public')
    const product = await makePromotableProduct('精选受限测试商品', categoryId)

    const now = Date.now()
    await prisma.editorialFeature.create({
      data: {
        productId: product.id,
        placement: 'store_editorial',
        publicReason: '测试精选理由',
        internalReason: '测试内部理由',
        status: 'active',
        sortWeight: 1,
        startsAt: new Date(now - 60_000),
        endsAt: new Date(now + 3_600_000),
        createdByUserId: actorId,
      },
    })

    // 分类 public：游客应能看到。
    const guestBefore = await listEditorialShelf({}, 'guest')
    expect(guestBefore.map(r => r.productId)).toContain(product.id)

    // 收紧分类：游客立即消失。
    await prisma.productCategory.update({
      where: { id: categoryId },
      data: { guestVisibility: 'members_only' },
    })
    const guestAfter = await listEditorialShelf({}, 'guest')
    expect(guestAfter.map(r => r.productId)).not.toContain(product.id)
    // 连商品名也不能出现在返回结构里（该 shelf 本身不返回名称，这里兜一层）。
    expect(JSON.stringify(guestAfter)).not.toContain('精选受限测试商品')

    // member 不受影响。
    const memberAfter = await listEditorialShelf({}, 'member')
    expect(memberAfter.map(r => r.productId)).toContain(product.id)
  })
})

describe('SPEC-CATALOG-VIS-001 §3.4 推广入口受分类可见性约束', () => {
  it('分类受限的候选商品被 filterSponsoredByAudience 滤掉，member 保留', async () => {
    // 直接驱动 publicSponsored 唯一的访问规则接点。
    // 不造完整推广套餐：listSponsoredItems 的其余部分是轮换/计费逻辑，
    // 与本规则无关（其纯函数部分已由 publicSponsored.test.ts 覆盖）。
    // 这里要证明的是「推广卡片也会被分类门拦住」——这是 §3.3 点名的
    // 「详情拒绝、推广卡片仍出现」的典型漏点。
    const categoryId = await makeCategory('merch-vis-sponsored', 'public')
    const product = await makePromotableProduct('推广受限测试商品', categoryId)

    const items = [{ productId: product.id, disclosure: { code: 'sponsored' as const, label: '推广' as const } }]

    // 分类 public：游客得到该条。
    const guestBefore = await filterSponsoredByAudience(items, 'guest', prisma)
    expect(guestBefore.map(i => i.productId)).toContain(product.id)

    // 收紧分类：游客立即被滤掉，且返回结构不含商品信息。
    await prisma.productCategory.update({
      where: { id: categoryId },
      data: { guestVisibility: 'members_only' },
    })
    const guestAfter = await filterSponsoredByAudience(items, 'guest', prisma)
    expect(guestAfter).toEqual([])
    expect(JSON.stringify(guestAfter)).not.toContain('推广受限测试商品')

    // member 不受影响。
    const memberAfter = await filterSponsoredByAudience(items, 'member', prisma)
    expect(memberAfter.map(i => i.productId)).toContain(product.id)
  })
})

it('hydrates bounded shelf summaries without private fields and rechecks visibility', async () => {
  const categoryId = await makeCategory('batch-summary', 'public')
  const product = await makePromotableProduct('批量卡片', categoryId)
  const before = await api.get('/api/products/summaries').query({ ids: `${product.id},${product.id}` }).expect(200)
  expect(before.body.items).toHaveLength(1)
  expect(before.body.items[0]).toMatchObject({ id: product.id, name: '批量卡片' })
  for (const key of ['guestEligibility', 'publicContentRevision', 'offers', 'fixedContent', 'visibility']) {
    expect(before.body.items[0]).not.toHaveProperty(key)
  }
  await prisma.productCategory.update({ where: { id: categoryId }, data: { guestVisibility: 'members_only' } })
  expect((await api.get('/api/products/summaries').query({ ids: String(product.id) }).expect(200)).body.items).toEqual([])
  await api.get('/api/products/summaries').query({ ids: Array(13).fill(product.id).join(',') }).expect(400)
})
