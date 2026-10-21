import { afterAll, describe, expect, it } from 'vitest'
import { api, createTestUser, loginAs, authHeader } from '../../__tests__/helpers.js'
import { prisma } from '../../lib/prisma.js'
import { config } from '../../config/index.js'
import { __resetCacheForTests } from '../../lib/cache.js'

/**
 * SPEC-CATALOG-VIS-001 §3.4 / §8.1（P1-B）— 真实 Redis 下「缓存不是权限真相源」。
 *
 * 方案要求：分类收紧后即使 Redis 失效通知失败，返回前的数据库访问复核
 * 也必须拒绝；数据库无法确认权限时不得用旧缓存回退为公开。
 *
 * 这组用例**必须有 Redis**才能跑。没有 Redis 时 `isCacheEnabled()` 直接返回
 * false（lib/cache.ts:53-59），wrapCache 全部走 fallback 查库——那种情况下
 * 测试通过只能说明「直查库是对的」，完全没碰到缓存路径。
 *
 * 因此本文件在 Redis 不可用时**整组跳过并显式标注**，不静默通过。
 * 本地运行方式见 PR 描述（docker run redis）。
 */

const redisUp = config.redisEnabled === true

;(redisUp ? describe : describe.skip)(
  'SPEC-CATALOG-VIS-001 §3.4 真实 Redis 下的缓存与分类收紧',
  () => {
    afterAll(async () => {
      await __resetCacheForTests()
    })

    it('预热详情缓存后收紧分类，游客请求仍被拒绝（不依赖缓存失效）', async () => {
      // 1) 造一件 public 商品 + 分类 public。
      const { user } = await createTestUser('cache-vis-actor@test.local', 'x', 'admin')
      const category = await prisma.productCategory.create({
        data: {
          code: 'cache-vis-cat',
          label: '缓存测试分类',
          normalizedLabel: '缓存测试分类',
          guestVisibility: 'public',
          status: 'active',
          createdByUserId: user.id,
          updatedByUserId: user.id,
        },
      })
      const product = await prisma.product.create({
        data: {
          name: '缓存预热商品',
          type: '网络节点',
          categoryId: category.id,
          price: 10,
          stock: 1,
          status: 'active',
          visibility: 'public',
        },
      })

      // 2) 预热：游客详情 + 列表都读一次，让缓存条目落库。
      //    cacheProductDetail / cacheProductList 默认 true，redisEnabled 为真时生效。
      const warmDetail = await api.get(`/api/products/${product.id}`).expect(200)
      expect(warmDetail.body.name).toBe('缓存预热商品')
      await api.get('/api/products').expect(200)

      // 3) 收紧分类（模拟“Redis 失效通知失败”：这里不做任何 cache bump，
      //    直接改库。若实现依赖缓存失效才生效，本用例就会失败）。
      await prisma.productCategory.update({
        where: { id: category.id },
        data: { guestVisibility: 'members_only' },
      })

      // 4) 游客详情：缓存里仍躺着旧的 200 内容，但返回前必须实时复核并拒绝。
      const afterDetail = await api.get(`/api/products/${product.id}`)
      expect(afterDetail.status).toBe(403)
      expect(afterDetail.body.error.code).toBe('PRODUCT_LOGIN_REQUIRED')
      expect(JSON.stringify(afterDetail.body)).not.toContain('缓存预热商品')

      // 5) 游客列表：不得含该商品。
      const afterList = await api.get('/api/products').expect(200)
      const ids = (afterList.body.items as Array<{ id: number }>).map(i => i.id)
      expect(ids).not.toContain(product.id)
      expect(JSON.stringify(afterList.body)).not.toContain('缓存预热商品')

      // 6) member 不受影响（同一件商品，登录后可见）。
      await createTestUser('cache-vis-member@test.local', 'pass123', 'user', 1000)
      const { accessToken } = await loginAs('cache-vis-member@test.local', 'pass123')
      const memberDetail = await api
        .get(`/api/products/${product.id}`)
        .set(authHeader(accessToken))
        .expect(200)
      expect(memberDetail.body.name).toBe('缓存预热商品')
    })

    it('registry 缓存按 audience 隔离：游客预热后不污染 member 结果', async () => {
      const { user } = await createTestUser('cache-reg-actor@test.local', 'x', 'admin')
      const locked = await prisma.productCategory.create({
        data: {
          code: 'cache-reg-locked',
          label: '缓存受限分类',
          normalizedLabel: '缓存受限分类',
          guestVisibility: 'members_only',
          status: 'active',
          createdByUserId: user.id,
          updatedByUserId: user.id,
        },
      })

      // 先让游客读一次（缓存 guest 视角）。
      const guest = await api.get('/api/config/registry').expect(200)
      expect((guest.body.productCategories as Array<{ code: string }>).map(c => c.code))
        .not.toContain(locked.code)

      // 再让 member 读：必须拿到受限分类，说明两个 audience 的缓存条目是分开的。
      await createTestUser('cache-reg-member@test.local', 'pass123', 'user', 1000)
      const { accessToken } = await loginAs('cache-reg-member@test.local', 'pass123')
      const member = await api
        .get('/api/config/registry')
        .set(authHeader(accessToken))
        .expect(200)
      expect((member.body.productCategories as Array<{ code: string }>).map(c => c.code))
        .toContain(locked.code)

      // 反向：member 预热后再让游客读，游客仍看不到（不能被 member 的条目污染）。
      const guestAgain = await api.get('/api/config/registry').expect(200)
      expect((guestAgain.body.productCategories as Array<{ code: string }>).map(c => c.code))
        .not.toContain(locked.code)
    })
  },
)

// 明确记录跳过原因，避免「跑了 0 例也算绿」被误读为已验证缓存路径。
if (!redisUp) {
  describe('SPEC-CATALOG-VIS-001 §3.4 缓存用例（未启用 Redis）', () => {
    it.skip('需要 REDIS_ENABLED=true + 可用 Redis 才能验证缓存路径（见 PR 描述运行方式）', () => {})
  })
}
