import { describe, expect, it, vi } from 'vitest'

// BOT-1：机器人商品接口按请求者身份区分视角。
//
// 这里必须先把 config.chatBot 打开，否则 /api/bot/* 直接 503，测不到真实路径。
// 密钥是测试专用常量，与 vitest.config.ts 里其它固定测试材料同性质。
//
// vi.hoisted 是必需的：vi.mock 的工厂会被提升到文件顶部，那时普通 const
// 还没初始化（ReferenceError: Cannot access 'BOT_SECRET' before initialization）。
const { BOT_SECRET } = vi.hoisted(() => ({
  BOT_SECRET: 'bot-audience-test-secret-at-least-32-chars!!',
}))

vi.mock('../../config/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../config/index.js')>()
  return {
    ...actual,
    config: {
      ...actual.config,
      chatBot: { enabled: true as const, secret: BOT_SECRET, reminderEnabled: false },
    },
  }
})

import { createHmac } from 'node:crypto'
import { prisma } from '../../lib/prisma.js'
import { api, createTestProduct, createTestUser } from '../../__tests__/helpers.js'
import { buildBotSignPayload } from './service.js'

/**
 * SPEC-CHAT-BOT-001 / BOT-1（docs/specs/product-guest-visibility-ai-moderation.md §5、§10）
 *
 * 被修复的缺陷：两个商品接口固定用 member 视角，请求既不携带发送者身份，
 * 客户端也不校验绑定。任何 QQ 用户（含整个群）都能拿到 members_only 商品的
 * 名称、价格、库存、商家、分类、描述。
 *
 * 本文件锁定三条契约：
 *
 * 1. 视角判定：仅「私聊 + 已绑定 + 账号正常」为 member，其余一律 guest。
 * 2. 失败不降级：绑定/用户查询抛错按原错误流程处理，不当成 member，
 *    也不吞成「未找到」。
 * 3. 详情三分支：found / not_found(404) / login_required(403 收敛且无商品字段)。
 *
 * 翻页不在本次范围内：机器人商品命令不提供翻页，接口不接收 cursor。
 * develop 上的原始路由同样只接收 { keyword, page }，「还有更多结果，可加
 * 关键词缩小范围」是有意设计。若日后要做翻页，客户端必须把关键词与游标
 * 一起保存——filterHash 含 query（products/service.ts:550），丢了关键词
 * 再续传必然被判为游标过期。
 */

/** 按 middleware 的口径签名：body 全字段 + timestamp + _path，不参与 sign 自身。 */
function sign(path: string, body: Record<string, unknown>, timestamp: number) {
  const payload = buildBotSignPayload({ ...body, timestamp, _path: path })
  return createHmac('sha256', BOT_SECRET).update(payload, 'utf8').digest('hex')
}

/**
 * 发一个签名正确的 bot 请求。
 *
 * 刻意**不声明 async**：签名是同步计算，返回 supertest 的链式对象，
 * 这样调用方可以直接 `.expect(200)`。写成 async 会把 Test 包成 Promise，
 * `await` 之后拿到普通响应，`.expect` 就不存在了。
 */
function botPost(path: string, body: Record<string, unknown>) {
  const timestamp = Date.now()
  return api
    .post(`/api/bot${path}`)
    .set('X-Bot-Sign', sign(path, body, timestamp))
    .set('X-Bot-Timestamp', String(timestamp))
    .send(body)
}

/** 造一件 members_only 商品——受保护的那一类。 */
async function makeMembersOnlyProduct(name = '会员专属商品') {
  const product = await createTestProduct(name, 88, 2, [`${name}-1`, `${name}-2`])
  await prisma.product.update({
    where: { id: product.id },
    data: { visibility: 'members_only' },
  })
  return product
}

/** 造一个已绑定的正常账号，返回 (platform, platformId) 与 userId。 */
async function makeBoundUser(options?: {
  platformId?: string
  status?: string
  email?: string
}) {
  const email = options?.email ?? `bot-audience-${Date.now()}-${Math.random()}@test.local`
  const { user } = await createTestUser(email, 'pass123', 'user', 100)
  if (options?.status && options.status !== '正常') {
    await prisma.user.update({ where: { id: user.id }, data: { status: options.status } })
  }
  const platform = 'qq'
  const platformId = options?.platformId ?? `bot-${user.id}-${Date.now()}`
  await prisma.chatBinding.create({ data: { platform, platformId, userId: user.id } })
  return { userId: user.id, platform, platformId }
}

describe('BOT-1 商品搜索视角判定', () => {
  it('旧请求体（无任何身份字段）按 guest 处理，看不到 members_only 商品', async () => {
    const locked = await makeMembersOnlyProduct('旧客户端会员商品')
    const open = await createTestProduct('旧客户端公开商品', 10, 1, ['OPEN-OLD'])

    // 完全不传 platform / platformId / conversationType —— 旧客户端就是这样。
    const res = await botPost('/products/search', { keyword: '旧客户端' }).expect(200)

    const ids = res.body.items.map((item: { id: number }) => item.id)
    expect(ids).toContain(open.id)
    expect(ids).not.toContain(locked.id)
    // 连带名字也不能出现在响应里。
    expect(JSON.stringify(res.body)).not.toContain('旧客户端会员商品')
  })

  it('group + 已绑定 + 账号正常 → 仍是 guest（群回复的可见范围是整个群）', async () => {
    const locked = await makeMembersOnlyProduct('群聊会员商品')
    const bound = await makeBoundUser()

    const res = await botPost('/products/search', {
      keyword: '群聊会员',
      platform: bound.platform,
      platformId: bound.platformId,
      conversationType: 'group',
    }).expect(200)

    const ids = res.body.items.map((item: { id: number }) => item.id)
    expect(ids).not.toContain(locked.id)
    expect(JSON.stringify(res.body)).not.toContain('群聊会员商品')
  })

  it('private + 未绑定 → guest', async () => {
    const locked = await makeMembersOnlyProduct('未绑定会员商品')

    const res = await botPost('/products/search', {
      keyword: '未绑定会员',
      platform: 'qq',
      platformId: 'never-bound-platform-id',
      conversationType: 'private',
    }).expect(200)

    const ids = res.body.items.map((item: { id: number }) => item.id)
    expect(ids).not.toContain(locked.id)
  })

  it('未知会话类型不默认 private，同样按 guest 处理', async () => {
    const locked = await makeMembersOnlyProduct('未知会话会员商品')
    const bound = await makeBoundUser()

    for (const conversationType of ['PRIVATE', 'Private', 'channel', '', undefined]) {
      const res = await botPost('/products/search', {
        keyword: '未知会话会员',
        platform: bound.platform,
        platformId: bound.platformId,
        conversationType,
      }).expect(200)
      const ids = res.body.items.map((item: { id: number }) => item.id)
      expect(ids, `conversationType=${String(conversationType)}`).not.toContain(locked.id)
    }
  })

  it('private + 绑定 + 账号正常 → member，可见 members_only 商品', async () => {
    const locked = await makeMembersOnlyProduct('私聊可见会员商品')
    const bound = await makeBoundUser()

    const res = await botPost('/products/search', {
      keyword: '私聊可见会员',
      platform: bound.platform,
      platformId: bound.platformId,
      conversationType: 'private',
    }).expect(200)

    const ids = res.body.items.map((item: { id: number }) => item.id)
    expect(ids).toContain(locked.id)
    const item = res.body.items.find((row: { id: number }) => row.id === locked.id)
    expect(item.name).toBe('私聊可见会员商品')
    expect(item.price).toBe(88)
  })

  it('private + 绑定 + 已封禁 → guest', async () => {
    const locked = await makeMembersOnlyProduct('封禁用户会员商品')
    const bound = await makeBoundUser({ status: '已封禁' })

    const res = await botPost('/products/search', {
      keyword: '封禁用户会员',
      platform: bound.platform,
      platformId: bound.platformId,
      conversationType: 'private',
    }).expect(200)

    const ids = res.body.items.map((item: { id: number }) => item.id)
    expect(ids).not.toContain(locked.id)
    expect(JSON.stringify(res.body)).not.toContain('封禁用户会员商品')
  })

  it('篡改 conversationType 后签名校验失败（新字段参与 HMAC）', async () => {
    const bound = await makeBoundUser()
    const timestamp = Date.now()

    // 先按 group 签名，再把 body 改成 private —— 典型的自封权限尝试。
    const groupBody = {
      keyword: '签名篡改',
      platform: bound.platform,
      platformId: bound.platformId,
      conversationType: 'group',
    }
    const sign_ = sign('/products/search', groupBody, timestamp)

    const res = await api
      .post('/api/bot/products/search')
      .set('X-Bot-Sign', sign_)
      .set('X-Bot-Timestamp', String(timestamp))
      .send({ ...groupBody, conversationType: 'private' })
      .expect(401)
    expect(res.body.error.code).toBe('BOT_UNAUTHORIZED')
  })

  it('绑定查询异常不降级为 member，也不吞成空结果', async () => {
    const locked = await makeMembersOnlyProduct('异常降级会员商品')

    const spy = vi.spyOn(prisma.chatBinding, 'findUnique').mockRejectedValue(
      new Error('binding lookup exploded'),
    )
    try {
      const res = await botPost('/products/search', {
        keyword: '异常降级会员',
        platform: 'qq',
        platformId: 'boom',
        conversationType: 'private',
      })

      // 关键：既不是 200 的 member 结果，也不是 200 的空列表伪装成「没找到」。
      expect(res.status).toBe(500)
      expect(JSON.stringify(res.body)).not.toContain('异常降级会员商品')
      expect(res.body.items).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })

  it('用户状态查询异常同样上抛，不降级', async () => {
    const bound = await makeBoundUser()

    const spy = vi.spyOn(prisma.user, 'findUnique').mockRejectedValue(
      new Error('user lookup exploded'),
    )
    try {
      const res = await botPost('/products/search', {
        keyword: '用户查询异常',
        platform: bound.platform,
        platformId: bound.platformId,
        conversationType: 'private',
      })
      expect(res.status).toBe(500)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('BOT-1 商品详情三分支', () => {
  it('members_only 商品对 guest 返回 loginRequired，且不含任何商品字段', async () => {
    const locked = await makeMembersOnlyProduct('详情受限商品')

    const res = await botPost('/products/detail', { productId: locked.id }).expect(200)

    expect(res.body).toEqual({ found: false, loginRequired: true })
    // 逐项确认：ID、名称、价格、库存、商家、分类、图片、描述都不能出现。
    const raw = JSON.stringify(res.body)
    expect(raw).not.toContain('详情受限商品')
    expect(raw).not.toContain(String(locked.id))
    expect(res.body.product).toBeUndefined()
    expect(res.body.items).toBeUndefined()
  })

  it('不存在/下架商品维持 { found: false }，不带 loginRequired', async () => {
    const draft = await createTestProduct('详情草稿商品', 10, 1, ['D-1'])
    await prisma.product.update({
      where: { id: draft.id },
      data: { status: 'draft', visibility: 'public' },
    })

    const res = await botPost('/products/detail', { productId: draft.id }).expect(200)
    expect(res.body).toEqual({ found: false })
    expect(res.body.loginRequired).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain('详情草稿商品')
  })

  it('不存在的编号也走 { found: false }，不是服务异常', async () => {
    const res = await botPost('/products/detail', { productId: 99_999_999 }).expect(200)
    expect(res.body).toEqual({ found: false })
  })

  it('member 身份可看 members_only 详情', async () => {
    const locked = await makeMembersOnlyProduct('详情会员可见商品')
    const bound = await makeBoundUser()

    const res = await botPost('/products/detail', {
      productId: locked.id,
      platform: bound.platform,
      platformId: bound.platformId,
      conversationType: 'private',
    }).expect(200)

    expect(res.body.found).toBe(true)
    expect(res.body.product.name).toBe('详情会员可见商品')
    expect(res.body.loginRequired).toBeUndefined()
  })

  it('群聊里查同一件商品仍是 loginRequired（即使发送者已绑定）', async () => {
    const locked = await makeMembersOnlyProduct('群聊详情会员商品')
    const bound = await makeBoundUser()

    const res = await botPost('/products/detail', {
      productId: locked.id,
      platform: bound.platform,
      platformId: bound.platformId,
      conversationType: 'group',
    }).expect(200)

    expect(res.body).toEqual({ found: false, loginRequired: true })
    expect(JSON.stringify(res.body)).not.toContain('群聊详情会员商品')
  })

  it('绑定查询异常时详情也不伪装成查无商品', async () => {
    const locked = await makeMembersOnlyProduct('详情异常商品')
    const spy = vi.spyOn(prisma.chatBinding, 'findUnique').mockRejectedValue(
      new Error('binding lookup exploded'),
    )
    try {
      const res = await botPost('/products/detail', {
        productId: locked.id,
        platform: 'qq',
        platformId: 'boom',
        conversationType: 'private',
      })
      expect(res.status).toBe(500)
      expect(res.body.found).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })
})
