// T-CAT-BE-001 — Admin product-categories + public registry API tests
// (SPEC-CATALOG-OPS-001 §7.1/§7.2; D-CAT-06/D-CAT-07; AC-CAT-010~011;
// REQ-CAT-NF-004). DB-backed — run by the coordinator against the dedicated
// monexus_test_catalog_ops_be database.

import { describe, expect, it } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from '../../__tests__/helpers.js'
import jwt from 'jsonwebtoken'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'

async function loginAdmin(email = 'cat-admin@test.local') {
  const { user, password } = await createTestUser(email, 'admin123', 'admin')
  const { accessToken } = await loginAs(user.email, password)
  return accessToken
}

async function loginUser(email = 'cat-user@test.local') {
  const { user, password } = await createTestUser(email, 'user1234', 'user')
  const { accessToken } = await loginAs(user.email, password)
  return accessToken
}

describe('admin product-categories API — authorization', () => {
  it('rejects unauthenticated callers (401)', async () => {
    await api.get('/api/admin/product-categories').expect(401)
    await api.post('/api/admin/product-categories').send({}).expect(401)
  })

  it('rejects non-admin callers (403)', async () => {
    const token = await loginUser()
    await api.get('/api/admin/product-categories').set(authHeader(token)).expect(403)
    await api.post('/api/admin/product-categories').set(authHeader(token)).send({}).expect(403)
  })

  it('rejects an admin-role token WITHOUT the MFA claim on mutations (403 MFA_REQUIRED)', async () => {
    const { user } = await createTestUser('cat-admin-nomfa@test.local', 'admin123', 'admin')
    await loginAs(user.email, 'admin123')
    const session = await prisma.refreshToken.findFirstOrThrow({
      where: { userId: user.id, revoked: false },
      orderBy: { id: 'desc' },
    })
    // Admin-role token that never completed MFA: requireAdminMfa must stop it
    // before any mutation runs (CHK-CAT-003).
    const adminWithoutMfa = jwt.sign(
      { userId: user.id, role: 'admin', sid: session.sessionId },
      config.jwtSecret,
      { expiresIn: '15m' },
    )
    const before = await prisma.productCategory.count()
    const res = await api.post('/api/admin/product-categories')
      .set(authHeader(adminWithoutMfa))
      .send({ code: 'mfa-gated', label: 'MFA拦截' })
      .expect(403)
    expect(res.body.error.code).toBe('MFA_REQUIRED')
    expect(await prisma.productCategory.count()).toBe(before)
  })
})

describe('admin product-categories API — CRUD/lifecycle', () => {
  it('creates, lists, updates, deactivates, activates, reorders and deletes', async () => {
    const token = await loginAdmin()

    // Create
    const created = await api
      .post('/api/admin/product-categories')
      .set(authHeader(token))
      .send({ code: 'cloud-tool', label: '云工具', sortOrder: 5, defaultCoverUrl: '/assets/network.webp' })
      .expect(201)
    const id = created.body.id as number
    expect(created.body).toMatchObject({
      code: 'cloud-tool',
      label: '云工具',
      normalizedLabel: '云工具',
      sortOrder: 5,
      status: 'active',
    })

    // List
    const list = await api
      .get('/api/admin/product-categories?page=1&pageSize=20')
      .set(authHeader(token))
      .expect(200)
    expect(list.body.total).toBeGreaterThanOrEqual(1)
    expect((list.body.items as Array<{ code: string }>).some(i => i.code === 'cloud-tool')).toBe(true)

    // Update (label rename; code immutable)
    const updated = await api
      .patch(`/api/admin/product-categories/${id}`)
      .set(authHeader(token))
      .send({ label: '云服务' })
      .expect(200)
    expect(updated.body).toMatchObject({ label: '云服务', normalizedLabel: '云服务', code: 'cloud-tool' })

    // code PATCH → stable CATEGORY_CODE_IMMUTABLE
    const codePatch = await api
      .patch(`/api/admin/product-categories/${id}`)
      .set(authHeader(token))
      .send({ code: 'hacked' })
      .expect(400)
    expect(codePatch.body.error.code).toBe('CATEGORY_CODE_IMMUTABLE')

    // Deactivate → status filter shows it
    await api.post(`/api/admin/product-categories/${id}/deactivate`).set(authHeader(token)).expect(200)
    const inactive = await api
      .get('/api/admin/product-categories?status=inactive')
      .set(authHeader(token))
      .expect(200)
    expect((inactive.body.items as Array<{ code: string }>).some(i => i.code === 'cloud-tool')).toBe(true)

    // Activate
    const activated = await api
      .post(`/api/admin/product-categories/${id}/activate`)
      .set(authHeader(token))
      .expect(200)
    expect(activated.body.status).toBe('active')

    // Reorder
    const reordered = await api
      .post('/api/admin/product-categories/reorder')
      .set(authHeader(token))
      .send({ orderedIds: [id] })
      .expect(200)
    expect(reordered.body).toEqual({ updated: 1 })

    // Delete (unreferenced) succeeds
    const removed = await api
      .delete(`/api/admin/product-categories/${id}`)
      .set(authHeader(token))
      .expect(200)
    expect(removed.body).toEqual({ deleted: true, id })
  })

  it('refuses to delete a referenced category (409 CATEGORY_REFERENCED)', async () => {
    const token = await loginAdmin()
    const created = await api
      .post('/api/admin/product-categories')
      .set(authHeader(token))
      .send({ code: 'ref-cat', label: '被引用', defaultCoverUrl: '/assets/network.webp' })
      .expect(201)
    const id = created.body.id as number

    await prisma.product.create({
      data: { name: '被引用商品', type: '被引用', price: 100, categoryId: id },
    })

    const removed = await api
      .delete(`/api/admin/product-categories/${id}`)
      .set(authHeader(token))
      .expect(409)
    expect(removed.body.error.code).toBe('CATEGORY_REFERENCED')
  })

  it('rejects an unknown create field (strict schema) and invalid reorder ids', async () => {
    const token = await loginAdmin()

    await api
      .post('/api/admin/product-categories')
      .set(authHeader(token))
      .send({ code: 'x', label: 'x', status: 'inactive' })
      .expect(400)

    await api
      .post('/api/admin/product-categories/reorder')
      .set(authHeader(token))
      .send({ orderedIds: [] })
      .expect(400)
  })
})

describe('public config registry — category projection (§7.1)', () => {
  it('returns active productCategories and deprecated productTypes from the DB', async () => {
    // Seeding happens via createTestUser → ensureSeedCategories.
    await loginAdmin()

    const res = await api.get('/api/config/registry').expect(200)
    expect(res.body.productCategories).toBeDefined()
    expect(Array.isArray(res.body.productTypes)).toBe(true)

    const codes = (res.body.productCategories as Array<{ code: string }>).map(c => c.code)
    expect(codes).toContain('network-node')
    // legacy-unclassified is inactive → excluded from the public list.
    expect(codes).not.toContain('legacy-unclassified')

    for (const item of res.body.productTypes as Array<{ value: string; label: string; deprecated?: boolean }>) {
      expect(item.deprecated).toBe(true)
      expect(item.value).toBe(item.label)
    }
    // deliveryModes stays a separate non-category static registry.
    expect((res.body.deliveryModes as unknown[]).length).toBeGreaterThan(0)
  })
})
