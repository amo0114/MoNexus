import { describe, expect, it } from 'vitest'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'

async function adminToken(email: string) {
  const { user } = await createTestUser(email, 'admin123', 'admin')
  const { accessToken } = await loginAs(user.email, 'admin123')
  return accessToken
}

describe('admin product delivery contract', () => {
  it('supports the same fixed-content/manual product configurations as merchant authoring', async () => {
    const token = await adminToken('admin-product-delivery-create@test.local')
    const cover = 'https://cdn.test.local/admin-cover.png'
    const second = 'https://cdn.test.local/admin-second.png'

    const fixed = await api.post('/api/admin/products').set(authHeader(token)).send({
      name: '管理员固定链接商品',
      type: '邀请码',
      price: 100,
      deliveryMode: 'instant_fixed',
      stockMode: 'unlimited',
      fixedContent: 'https://example.test/invite',
      fixedContentType: 'url',
      images: [cover, second],
    }).expect(201)

    expect(fixed.body).toMatchObject({
      deliveryMode: 'instant_fixed',
      stockMode: 'unlimited',
      fixedContent: 'https://example.test/invite',
      fixedContentType: 'url',
      imageUrl: cover,
      images: [cover, second],
      stock: 0,
    })

    const manual = await api.post('/api/admin/products').set(authHeader(token)).send({
      name: '管理员限量人工服务',
      type: '网络节点',
      price: 200,
      deliveryMode: 'manual_service',
      stockMode: 'limited',
      imageUrl: cover,
    }).expect(201)

    // Catalog Ops：建品与可售量分离——草稿初始名额恒 0，名额由 offer 容量调整补充。
    expect(manual.body).toMatchObject({
      deliveryMode: 'manual_service',
      stockMode: 'limited',
      stock: 0,
      imageUrl: cover,
      images: [cover],
    })

    const limitedFixed = await api.post('/api/admin/products').set(authHeader(token)).send({
      name: '管理员限量固定内容商品',
      type: '邀请码',
      price: 150,
      deliveryMode: 'instant_fixed',
      stockMode: 'limited',
      fixedContent: 'FIXED-ADMIN-LIMITED-001',
      fixedContentType: 'text',
      imageUrl: cover,
    }).expect(201)

    expect(limitedFixed.body).toMatchObject({
      deliveryMode: 'instant_fixed',
      stockMode: 'limited',
      fixedContent: 'FIXED-ADMIN-LIMITED-001',
      fixedContentType: 'text',
      stock: 0,
      imageUrl: cover,
      images: [cover],
    })
  })

  it('rejects invalid combinations instead of creating an ambiguous stock source', async () => {
    const token = await adminToken('admin-product-delivery-invalid@test.local')
    const base = { type: '邀请码', price: 100 }

    await api.post('/api/admin/products').set(authHeader(token))
      .send({ ...base, name: '卡密不能直设库存', deliveryMode: 'instant_inventory', stock: 0 })
      .expect(400)

    await api.post('/api/admin/products').set(authHeader(token))
      .send({ ...base, name: '固定内容不能为空', deliveryMode: 'instant_fixed' })
      .expect(400)

    await api.post('/api/admin/products').set(authHeader(token))
      .send({
        ...base,
        name: '人工服务不能携带固定内容',
        deliveryMode: 'manual_service',
        fixedContent: '不应接受',
      })
      .expect(400)

    await api.post('/api/admin/products').set(authHeader(token))
      .send({
        ...base,
        name: '图库封面必须一致',
        imageUrl: 'https://cdn.test.local/cover-a.png',
        images: ['https://cdn.test.local/cover-b.png'],
      })
      .expect(400)
  })

  it('validates effective cross-field updates and keeps the gallery cover canonical', async () => {
    const token = await adminToken('admin-product-delivery-update@test.local')
    const first = 'https://cdn.test.local/admin-update-1.png'
    const second = 'https://cdn.test.local/admin-update-2.png'

    const created = await api.post('/api/admin/products').set(authHeader(token)).send({
      name: '管理员可转换商品', type: '邀请码', price: 100,
    }).expect(201)

    const fixed = await api.put(`/api/admin/products/${created.body.id}`).set(authHeader(token)).send({
      deliveryMode: 'instant_fixed',
      stockMode: 'limited',
      fixedContent: 'FIXED-ADMIN-001',
      fixedContentType: 'text',
      images: [first, second],
    }).expect(200)
    expect(fixed.body).toMatchObject({
      deliveryMode: 'instant_fixed', stockMode: 'limited', stock: 0,
      imageUrl: first, images: [first, second],
    })

    await api.put(`/api/admin/products/${created.body.id}`).set(authHeader(token))
      .send({ deliveryMode: 'manual_service' })
      .expect(400)

    const manual = await api.put(`/api/admin/products/${created.body.id}`).set(authHeader(token)).send({
      deliveryMode: 'manual_service',
      fixedContent: null,
      imageUrl: second,
    }).expect(200)
    expect(manual.body).toMatchObject({
      deliveryMode: 'manual_service',
      fixedContent: null,
      imageUrl: second,
      images: [second, first],
    })
  })
})
