import { describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { getActiveNetworkNodeCategoryId } from '../../__tests__/catalogFixture.js'
import { listEditorialShelf } from '../merchandising/editorial/publicShelf.js'
import { CATEGORY_GUEST_VISIBILITY } from './visibility.js'

/**
 * SPEC-CATALOG-VIS-001 §3.4（P1-B）— 受限分类不得占用 limit 名额。
 *
 * P1-A 的形态是：查询只按商品 visibility 过滤，受限分类的记录被查出后
 * 由 isCurrentlyPubliclyVisible 二次丢弃。**安全性没问题**（丢弃发生在返回前），
 * 但 `take` / `slice(0, limit)` 发生在过滤之前，受限分类的记录先占了名额，
 * 于是游客看到的卡片数少于设定值。
 *
 * 本文件把「名额准确」当成可断言的行为：造 limit 个受限分类记录 + N 个
 * public 记录，游客请求 limit 条，必须拿满 N 条（而不是被受限记录挤掉）。
 *
 * 只测 editorial：sponsored 的公开入口需要完整推广套餐+计费资格数据，
 * 造数成本高且与本规则无关；其查询条件与 editorial 同形（都在 product
 * where 里加 category.is.guestVisibility），sponsored 侧用
 * filterSponsoredByAudience 的既有用例覆盖过滤语义。
 */

async function makeActorId(): Promise<number> {
  const actor = await prisma.user.upsert({
    where: { email: 'limit-vis-actor@test.local' },
    update: {},
    create: { email: 'limit-vis-actor@test.local', password: 'x', role: 'admin' },
    select: { id: true },
  })
  return actor.id
}

async function makeCategory(code: string, guestVisibility: 'public' | 'members_only') {
  const actorId = await makeActorId()
  return prisma.productCategory.create({
    data: {
      code,
      label: `名额分类${code}`,
      normalizedLabel: `名额分类${code}`.toLowerCase(),
      guestVisibility,
      status: 'active',
      createdByUserId: actorId,
      updatedByUserId: actorId,
    },
  })
}

async function makeFeatured(name: string, categoryId: number, sortWeight: number, actorId: number) {
  const product = await prisma.product.create({
    data: {
      name,
      type: '网络节点',
      categoryId,
      price: 10,
      stock: 1,
      status: 'active',
      visibility: 'public',
    },
  })
  // SPEC-CATALOG-VIS-001 §4.2（P1.5）：游客可见还要求当前内容版本已批准。
  await prisma.productGuestEligibility.create({
    data: { productId: product.id, decision: 'approved', reviewedRevision: 1 },
  })
  const now = Date.now()
  await prisma.editorialFeature.create({
    data: {
      productId: product.id,
      placement: 'store_editorial',
      publicReason: '名额测试',
      internalReason: '名额测试内部',
      status: 'active',
      // 受限分类的权重更高：若它们没在查询阶段被排除，就会挤掉 public 记录。
      sortWeight,
      startsAt: new Date(now - 60_000),
      endsAt: new Date(now + 3_600_000),
      createdByUserId: actorId,
    },
  })
  return product
}

describe('SPEC-CATALOG-VIS-001 §3.4 受限分类不占用 limit 名额', () => {
  it('游客请求 limit 条时，受限分类记录不挤占 public 记录', async () => {
    const actorId = await makeActorId()
    const pubCat = await makeCategory('limit-pub', 'public')
    const lockCat = await makeCategory('limit-lock', 'members_only')
    const pubCatId = pubCat.id

    // 3 条受限分类记录（权重更高，排序更靠前）+ 3 条 public 记录。
    await makeFeatured('受限占位A', lockCat.id, 100, actorId)
    await makeFeatured('受限占位B', lockCat.id, 99, actorId)
    await makeFeatured('受限占位C', lockCat.id, 98, actorId)
    const p1 = await makeFeatured('公开占位1', pubCatId, 10, actorId)
    const p2 = await makeFeatured('公开占位2', pubCatId, 9, actorId)
    const p3 = await makeFeatured('公开占位3', pubCatId, 8, actorId)

    // 游客要 3 条：必须拿到 3 条 public 记录，而不是被 3 条受限记录挤空。
    const guest = await listEditorialShelf({ limit: 3 }, 'guest')
    expect(guest).toHaveLength(3)
    expect(guest.map(r => r.productId).sort()).toEqual([p1.id, p2.id, p3.id].sort())
    expect(JSON.stringify(guest)).not.toContain('受限占位')

    // member 视角不受分类门约束：拿到的仍是权重最高的 3 条（含受限分类）。
    const member = await listEditorialShelf({ limit: 3 }, 'member')
    expect(member).toHaveLength(3)
    expect(member.map(r => r.productId)).not.toContain(p3.id)
  })

  it('受限分类记录存在时，游客请求更大的 limit 也不会混入受限记录', async () => {
    const actorId = await makeActorId()
    const pubCat = await makeCategory('limit-pub2', 'public')
    const lockCat = await makeCategory('limit-lock2', 'members_only')
    await makeFeatured('受限大额A', lockCat.id, 50, actorId)
    const pub = await makeFeatured('公开大额1', pubCat.id, 1, actorId)

    const guest = await listEditorialShelf({ limit: 10 }, 'guest')
    expect(guest.map(r => r.productId)).toContain(pub.id)
    expect(guest.map(r => r.productId)).not.toContain(
      (await prisma.editorialFeature.findFirstOrThrow({
        where: { product: { categoryId: lockCat.id } },
        select: { productId: true },
      })).productId,
    )
  })
})
