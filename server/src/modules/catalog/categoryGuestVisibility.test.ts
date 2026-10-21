// SPEC-CATALOG-VIS-001 §3.1 — 分类级游客可见性管理契约测试。
//
// PR 序列 P1-A 的范围：数据字段 + 管理入口 + 统一判定规则。
// 本文件只覆盖「管理员能设置、能读回、非法值被拒、审计被写」这条管理面，
// 以及「默认 public 不改变既有行为」这一上线安全属性；
// 各公开入口的过滤行为属于 P1-B，在那边用入口矩阵测试覆盖。
//
// DB-backed —— 需要已迁移的测试库（见 CLAUDE.md 后端测试命令）。

import { describe, expect, it } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from '../../__tests__/helpers.js'
import { prisma } from '../../lib/prisma.js'
import { CATEGORY_GUEST_VISIBILITY } from '../products/visibility.js'

async function loginAdmin(email = 'catvis-admin@test.local') {
  const { user, password } = await createTestUser(email, 'admin123', 'admin')
  const { accessToken } = await loginAs(user.email, password)
  return accessToken
}

const COVER = '/assets/network.webp'

describe('SPEC-CATALOG-VIS-001 §3.1 分类 guestVisibility 管理契约', () => {
  it('创建时不传 guestVisibility 则默认 public（上线默认不隐藏任何分类）', async () => {
    const token = await loginAdmin()

    const created = await api
      .post('/api/admin/product-categories')
      .set(authHeader(token))
      .send({ code: 'vis-default', label: '默认可见性分类', defaultCoverUrl: COVER })
      .expect(201)

    expect(created.body.guestVisibility).toBe(CATEGORY_GUEST_VISIBILITY.PUBLIC)

    // DB 层同样落 public——不能只有 DTO 默认。
    const row = await prisma.productCategory.findUniqueOrThrow({
      where: { id: created.body.id as number },
      select: { guestVisibility: true },
    })
    expect(row.guestVisibility).toBe(CATEGORY_GUEST_VISIBILITY.PUBLIC)
  })

  it('创建时可显式设为 members_only，并能读回', async () => {
    const token = await loginAdmin()

    const created = await api
      .post('/api/admin/product-categories')
      .set(authHeader(token))
      .send({
        code: 'vis-locked',
        label: '受限分类',
        defaultCoverUrl: COVER,
        guestVisibility: CATEGORY_GUEST_VISIBILITY.MEMBERS_ONLY,
      })
      .expect(201)

    expect(created.body.guestVisibility).toBe(CATEGORY_GUEST_VISIBILITY.MEMBERS_ONLY)

    const list = await api
      .get('/api/admin/product-categories?page=1&pageSize=50')
      .set(authHeader(token))
      .expect(200)
    const item = (list.body.items as Array<{ code: string; guestVisibility: string }>)
      .find(i => i.code === 'vis-locked')
    expect(item?.guestVisibility).toBe(CATEGORY_GUEST_VISIBILITY.MEMBERS_ONLY)
  })

  it('更新可切换 public ↔ members_only，且缺省表示不改', async () => {
    const token = await loginAdmin()
    const created = await api
      .post('/api/admin/product-categories')
      .set(authHeader(token))
      .send({ code: 'vis-toggle', label: '可切换分类', defaultCoverUrl: COVER })
      .expect(201)
    const id = created.body.id as number

    // public → members_only
    const locked = await api
      .patch(`/api/admin/product-categories/${id}`)
      .set(authHeader(token))
      .send({ guestVisibility: CATEGORY_GUEST_VISIBILITY.MEMBERS_ONLY })
      .expect(200)
    expect(locked.body.guestVisibility).toBe(CATEGORY_GUEST_VISIBILITY.MEMBERS_ONLY)

    // 只改 label：guestVisibility 不得被重置
    const relabeled = await api
      .patch(`/api/admin/product-categories/${id}`)
      .set(authHeader(token))
      .send({ label: '改个名字' })
      .expect(200)
    expect(relabeled.body.guestVisibility).toBe(CATEGORY_GUEST_VISIBILITY.MEMBERS_ONLY)

    // members_only → public
    const opened = await api
      .patch(`/api/admin/product-categories/${id}`)
      .set(authHeader(token))
      .send({ guestVisibility: CATEGORY_GUEST_VISIBILITY.PUBLIC })
      .expect(200)
    expect(opened.body.guestVisibility).toBe(CATEGORY_GUEST_VISIBILITY.PUBLIC)
  })

  it('拒绝非法取值（strict enum，不静默降级为 public）', async () => {
    const token = await loginAdmin()

    for (const bad of ['PUBLIC', 'members-only', 'private', '', 'public ']) {
      const res = await api
        .post('/api/admin/product-categories')
        .set(authHeader(token))
        .send({
          code: `vis-bad-${bad.replace(/\W/g, '') || 'empty'}`,
          label: `非法值分类${bad}`,
          defaultCoverUrl: COVER,
          guestVisibility: bad,
        })
      expect(res.status, `value=${JSON.stringify(bad)}`).toBe(400)
      expect(res.body.error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('创建与更新都写 AdminLog，且记录 guestVisibility', async () => {
    const token = await loginAdmin()
    const created = await api
      .post('/api/admin/product-categories')
      .set(authHeader(token))
      .send({
        code: 'vis-audit',
        label: '审计分类',
        defaultCoverUrl: COVER,
        guestVisibility: CATEGORY_GUEST_VISIBILITY.MEMBERS_ONLY,
      })
      .expect(201)
    const id = created.body.id as number

    const createLog = await prisma.adminLog.findFirst({
      where: { action: '创建分类', targetId: id },
      orderBy: { id: 'desc' },
    })
    expect(createLog).not.toBeNull()
    expect(createLog!.detail).toContain('guestVisibility=members_only')

    await api
      .patch(`/api/admin/product-categories/${id}`)
      .set(authHeader(token))
      .send({ guestVisibility: CATEGORY_GUEST_VISIBILITY.PUBLIC })
      .expect(200)

    const updateLog = await prisma.adminLog.findFirst({
      where: { action: '更新分类', targetId: id },
      orderBy: { id: 'desc' },
    })
    expect(updateLog).not.toBeNull()
    expect(updateLog!.detail).toContain('guestVisibility')
  })

  it('DB CHECK 约束拒绝绕过应用层写入的第三值', async () => {
    const { user } = await createTestUser('catvis-check@test.local', 'x', 'admin')
    // 直接 UPDATE 绕过 Zod —— 约束必须在数据库上。
    const created = await prisma.productCategory.create({
      data: {
        code: 'vis-check-cat',
        label: '约束检查分类',
        normalizedLabel: '约束检查分类',
        status: 'active',
        createdByUserId: user.id,
        updatedByUserId: user.id,
      },
    })
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "ProductCategory" SET "guestVisibility" = 'private' WHERE "id" = $1`,
        created.id,
      ),
    ).rejects.toThrow(/ProductCategory_guestVisibility_valid_check/)
  })

  it('非管理员不能修改分类可见性（沿用现有鉴权链）', async () => {
    await api.post('/api/admin/product-categories')
      .send({ code: 'vis-anon', label: '匿名', defaultCoverUrl: COVER })
      .expect(401)

    const { user, password } = await createTestUser('catvis-user@test.local', 'user1234', 'user')
    const { accessToken } = await loginAs(user.email, password)
    await api.post('/api/admin/product-categories')
      .set(authHeader(accessToken))
      .send({ code: 'vis-user', label: '普通用户', defaultCoverUrl: COVER })
      .expect(403)
  })
})
