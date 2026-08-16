// T-CAT-BE-002 — CategoryApplication API tests (merchant + admin)
// (SPEC-CATALOG-OPS-001 §7.3; D-CAT-10/D-CAT-11; REQ-CAT-F-008;
// REQ-CAT-NF-004/005; CHK-CAT-006~009; AC-CAT-012~014). DB-backed — run by the
// coordinator against the dedicated monexus_test_catalog_ops_be database.
//
// Proves the HTTP boundary: auth/MFA chain on admin routes, active-merchant
// ownership on merchant routes, the stable duplicate/reviewed error codes, and
// the response DTO allowlist (no normalizedLabel/reviewedByUserId leak).

import { describe, expect, it } from 'vitest'
import { api, authHeader, createTestMerchant, createTestUser, loginAs } from '../../__tests__/helpers.js'
import { prisma } from '../../lib/prisma.js'

async function loginAdmin(email = 'cat-app-admin@test.local') {
  const { user, password } = await createTestUser(email, 'admin123', 'admin')
  const { accessToken } = await loginAs(user.email, password)
  return accessToken
}

async function loginMerchant(email: string) {
  const { user, merchant, password } = await createTestMerchant(email, 'merchant123', { status: 'active' })
  const { accessToken } = await loginAs(user.email, password)
  return { token: accessToken, merchantId: merchant.id }
}

const VALID_BODY = {
  proposedLabel: '云工具',
  description: '这是商家希望新增的平台云工具分类申请描述。',
}

function expectNoInternalFields(body: Record<string, unknown>) {
  expect('normalizedLabel' in body).toBe(false)
  expect('reviewedByUserId' in body).toBe(false)
}

describe('category application API — authorization (REQ-CAT-NF-004)', () => {
  it('rejects unauthenticated callers (401)', async () => {
    await api.get('/api/merchant/category-applications').expect(401)
    await api.post('/api/merchant/category-applications').send({}).expect(401)
    await api.get('/api/admin/category-applications').expect(401)
    await api.post('/api/admin/category-applications/1/approve').send({}).expect(401)
    await api.post('/api/admin/category-applications/1/reject').send({}).expect(401)
  })

  it('rejects non-admin callers on admin routes (403)', async () => {
    const { token } = await loginMerchant('cat-app-403-m@test.local')
    await api.get('/api/admin/category-applications').set(authHeader(token)).expect(403)
    await api.post('/api/admin/category-applications/1/approve').set(authHeader(token)).send({}).expect(403)
  })

  it('rejects non-merchant callers on merchant routes (403)', async () => {
    const { user, password } = await createTestUser('cat-app-403-u@test.local', 'user1234', 'user')
    const { accessToken } = await loginAs(user.email, password)
    await api.get('/api/merchant/category-applications').set(authHeader(accessToken)).expect(403)
    await api.post('/api/merchant/category-applications').set(authHeader(accessToken)).send({}).expect(403)
  })
})

describe('merchant category application API — create/list/withdraw', () => {
  it('creates, lists and withdraws its own application', async () => {
    const { token, merchantId } = await loginMerchant('cat-app-m1@test.local')

    const created = await api
      .post('/api/merchant/category-applications')
      .set(authHeader(token))
      .send(VALID_BODY)
      .expect(201)
    expect(created.body).toMatchObject({
      merchantId,
      proposedLabel: '云工具',
      status: 'pending',
      resolution: null,
      approvedCategoryId: null,
    })
    expectNoInternalFields(created.body)

    const list = await api.get('/api/merchant/category-applications').set(authHeader(token)).expect(200)
    expect(list.body.total).toBe(1)
    expect(list.body.items[0].id).toBe(created.body.id)

    const withdrawn = await api
      .post(`/api/merchant/category-applications/${created.body.id}/withdraw`)
      .set(authHeader(token))
      .expect(200)
    expect(withdrawn.body.status).toBe('withdrawn')
  })

  it('rejects a duplicate pending application with the stable 409 code', async () => {
    const { token } = await loginMerchant('cat-app-m2@test.local')
    await api.post('/api/merchant/category-applications').set(authHeader(token)).send(VALID_BODY).expect(201)

    const dup = await api
      .post('/api/merchant/category-applications')
      .set(authHeader(token))
      .send({ ...VALID_BODY, proposedLabel: ' 云工具 ' })
      .expect(409)
    expect(dup.body.error.code).toBe('CATEGORY_APPLICATION_PENDING_DUPLICATE')
  })

  it('rejects an unknown create field (strict schema → 400)', async () => {
    const { token } = await loginMerchant('cat-app-m3@test.local')
    await api
      .post('/api/merchant/category-applications')
      .set(authHeader(token))
      .send({ ...VALID_BODY, merchantId: 7 })
      .expect(400)
  })

  it('isolates merchants: cannot see or withdraw another merchant\'s application', async () => {
    const a = await loginMerchant('cat-app-iso-a@test.local')
    const b = await loginMerchant('cat-app-iso-b@test.local')

    const created = await api
      .post('/api/merchant/category-applications')
      .set(authHeader(a.token))
      .send(VALID_BODY)
      .expect(201)
    const id = created.body.id as number

    const listB = await api.get('/api/merchant/category-applications').set(authHeader(b.token)).expect(200)
    expect(listB.body.total).toBe(0)

    await api
      .post(`/api/merchant/category-applications/${id}/withdraw`)
      .set(authHeader(b.token))
      .expect(404)
  })
})

describe('admin category application API — list/approve/reject', () => {
  it('lists all applications and approves via create_new (Category + AdminLog)', async () => {
    const adminToken = await loginAdmin()
    const merchant = await loginMerchant('cat-app-adm1@test.local')
    const created = await api
      .post('/api/merchant/category-applications')
      .set(authHeader(merchant.token))
      .send(VALID_BODY)
      .expect(201)
    const id = created.body.id as number

    const list = await api
      .get('/api/admin/category-applications?status=pending')
      .set(authHeader(adminToken))
      .expect(200)
    expect(list.body.total).toBe(1)
    expect(list.body.items[0].id).toBe(id)

    const approved = await api
      .post(`/api/admin/category-applications/${id}/approve`)
      .set(authHeader(adminToken))
      .send({ resolution: 'create_new', category: { code: 'cloud-tool', label: '云工具' }, reviewReason: '符合平台目录' })
      .expect(200)
    expect(approved.body).toMatchObject({ status: 'approved', resolution: 'create_new' })
    expectNoInternalFields(approved.body)

    const category = await prisma.productCategory.findUniqueOrThrow({ where: { code: 'cloud-tool' } })
    expect(approved.body.approvedCategoryId).toBe(category.id)
    expect(await prisma.adminLog.count({ where: { targetId: id } })).toBe(1)
  })

  it('second review returns 409 CATEGORY_APPLICATION_ALREADY_REVIEWED', async () => {
    const adminToken = await loginAdmin()
    const merchant = await loginMerchant('cat-app-adm2@test.local')
    const created = await api
      .post('/api/merchant/category-applications')
      .set(authHeader(merchant.token))
      .send(VALID_BODY)
      .expect(201)
    const id = created.body.id as number

    await api
      .post(`/api/admin/category-applications/${id}/reject`)
      .set(authHeader(adminToken))
      .send({ reviewReason: '与现有分类重复' })
      .expect(200)

    const second = await api
      .post(`/api/admin/category-applications/${id}/approve`)
      .set(authHeader(adminToken))
      .send({ resolution: 'map_existing', categoryId: 1, reviewReason: '再试一次' })
      .expect(409)
    expect(second.body.error.code).toBe('CATEGORY_APPLICATION_ALREADY_REVIEWED')
    expect(await prisma.adminLog.count({ where: { targetId: id } })).toBe(1)
  })

  it('rejects an invalid approve body (strict schema → 400)', async () => {
    const adminToken = await loginAdmin()
    await api
      .post('/api/admin/category-applications/1/approve')
      .set(authHeader(adminToken))
      .send({ resolution: 'create_new', category: { code: 'CloudTool', label: 'x' }, reviewReason: 'x' })
      .expect(400)
    await api
      .post('/api/admin/category-applications/1/approve')
      .set(authHeader(adminToken))
      .send({ resolution: 'map_existing', categoryId: 0, reviewReason: 'x' })
      .expect(400)
    await api
      .post('/api/admin/category-applications/1/reject')
      .set(authHeader(adminToken))
      .send({})
      .expect(400)
  })
})
