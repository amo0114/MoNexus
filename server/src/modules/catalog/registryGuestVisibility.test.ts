// SPEC-CATALOG-VIS-001 §3.1/§3.4（P1-B）— registry 按 audience 输出。
//
// 这是 P1-A 遗留的已知缺口：`GET /api/config/registry` 原先只按
// status=ACTIVE 过滤，把受限分类的 code/label/iconKey 与兼容 productTypes
// 的 value/label 全部返回给游客。方案 §2.3 把「分类元数据」列入保护目标，
// 因此游客侧必须**整条记录不下发**，而不是下发后让前端隐藏。
//
// DB-backed —— 需要已迁移的测试库。

import { describe, expect, it } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from '../../__tests__/helpers.js'
import { prisma } from '../../lib/prisma.js'
import { CATEGORY_GUEST_VISIBILITY } from '../products/visibility.js'

async function makeCategory(
  code: string,
  label: string,
  guestVisibility: 'public' | 'members_only',
  status = 'active',
) {
  const actor = await prisma.user.upsert({
    where: { email: 'registry-vis-actor@test.local' },
    update: {},
    create: { email: 'registry-vis-actor@test.local', password: 'x', role: 'admin' },
    select: { id: true },
  })
  return prisma.productCategory.create({
    data: {
      code,
      label,
      normalizedLabel: label.toLowerCase(),
      guestVisibility,
      status,
      createdByUserId: actor.id,
      updatedByUserId: actor.id,
    },
  })
}

async function loginMember(email = 'registry-vis-member@test.local') {
  await createTestUser(email, 'pass123', 'user', 1000)
  const { accessToken } = await loginAs(email, 'pass123')
  return accessToken
}

describe('SPEC-CATALOG-VIS-001 §3.4 registry audience 过滤', () => {
  it('游客拿不到受限分类的任何字段（id/code/label/iconKey 全不出现）', async () => {
    const open = await makeCategory('reg-open', '公开注册分类', CATEGORY_GUEST_VISIBILITY.PUBLIC)
    const locked = await makeCategory('reg-locked', '受限注册分类', CATEGORY_GUEST_VISIBILITY.MEMBERS_ONLY)

    const guest = await api.get('/api/config/registry').expect(200)
    const guestCodes = (guest.body.productCategories as Array<{ code: string }>).map(c => c.code)
    const guestIds = (guest.body.productCategories as Array<{ id: number }>).map(c => c.id)
    const guestLabels = (guest.body.productCategories as Array<{ label: string }>).map(c => c.label)

    expect(guestCodes).toContain(open.code)
    expect(guestCodes).not.toContain(locked.code)
    expect(guestIds).not.toContain(locked.id)
    expect(guestLabels).not.toContain(locked.label)

    // 整份响应里不能出现受限分类的任何标识（含 productTypes 等其它字段）。
    const raw = JSON.stringify(guest.body)
    expect(raw).not.toContain('reg-locked')
    expect(raw).not.toContain('受限注册分类')
  })

  it('兼容 productTypes 同样过滤受限分类', async () => {
    await makeCategory('reg-open2', '公开兼容分类', CATEGORY_GUEST_VISIBILITY.PUBLIC)
    await makeCategory('reg-locked2', '受限兼容分类', CATEGORY_GUEST_VISIBILITY.MEMBERS_ONLY)

    const guest = await api.get('/api/config/registry').expect(200)
    const values = (guest.body.productTypes as Array<{ value: string; label: string }>)
      .map(t => t.value)
    expect(values).toContain('公开兼容分类')
    expect(values).not.toContain('受限兼容分类')
    // productTypes 的 value 与 label 都取自 label，两者都不能泄露。
    expect(JSON.stringify(guest.body.productTypes)).not.toContain('受限兼容分类')
  })

  it('登录用户拿到完整 registry（含受限分类），与游客明显不同', async () => {
    const locked = await makeCategory('reg-locked3', '受限登录可见分类', CATEGORY_GUEST_VISIBILITY.MEMBERS_ONLY)
    const token = await loginMember()

    const member = await api.get('/api/config/registry').set(authHeader(token)).expect(200)
    const codes = (member.body.productCategories as Array<{ code: string }>).map(c => c.code)
    expect(codes).toContain(locked.code)

    const guest = await api.get('/api/config/registry').expect(200)
    const guestCodes = (guest.body.productCategories as Array<{ code: string }>).map(c => c.code)
    expect(guestCodes).not.toContain(locked.code)
  })

  it('游客视角下 inactive 分类仍不出现（既有规则不变）', async () => {
    const inactive = await makeCategory('reg-inactive', '停用分类', CATEGORY_GUEST_VISIBILITY.PUBLIC, 'inactive')
    const guest = await api.get('/api/config/registry').expect(200)
    const codes = (guest.body.productCategories as Array<{ code: string }>).map(c => c.code)
    expect(codes).not.toContain(inactive.code)
  })

  it('无效 token 不会被静默降级为游客（保持原 auth 错误）', async () => {
    await makeCategory('reg-locked4', '受限鉴权分类', CATEGORY_GUEST_VISIBILITY.MEMBERS_ONLY)
    const res = await api
      .get('/api/config/registry')
      .set('Authorization', 'Bearer not-a-real-token')
    // authenticateIfPresent 只在**没有** Authorization 头时跳过；
    // 带了但无效应走正常鉴权失败，而不是悄悄当游客返回（那会掩盖客户端 bug）。
    expect(res.status).toBe(401)
    expect(JSON.stringify(res.body)).not.toContain('受限鉴权分类')
  })

  it('响应带 private, no-store（避免按 audience 变化的响应被中间层缓存）', async () => {
    const res = await api.get('/api/config/registry').expect(200)
    expect(res.headers['cache-control']).toMatch(/private/)
    expect(res.headers['cache-control']).toMatch(/no-store/)
  })
})
