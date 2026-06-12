import { describe, it, expect } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { api, createTestMerchant, createTestUser, loginAs, loginAsMerchant, authHeader } from '../../__tests__/helpers.js'

async function merchantToken(email: string) {
  await createTestMerchant(email, 'pass123', { role: 'merchant', status: 'active', name: `商家-${email}` })
  const login = await loginAsMerchant(email, 'pass123')
  return login.accessToken
}

const baseBody = {
  name: '邀请链接商品', type: '邀请码', price: 50,
  deliveryMode: 'instant_fixed',
  fixedContent: 'https://example.com/group-invite', fixedContentType: 'url',
  stockMode: 'unlimited',
}

describe('merchant instant_fixed product validation', () => {
  it('creates an unlimited instant_fixed product', async () => {
    const token = await merchantToken('if-create@test.local')
    const res = await api.post('/api/merchant/products').set(authHeader(token))
      .send(baseBody).expect(201)
    const product = await prisma.product.findUnique({ where: { id: res.body.id } })
    expect(product?.deliveryMode).toBe('instant_fixed')
    expect(product?.stockMode).toBe('unlimited')
    expect(product?.fixedContent).toBe('https://example.com/group-invite')
  })

  it('creates a limited instant_fixed product with stock', async () => {
    const token = await merchantToken('if-limited@test.local')
    const res = await api.post('/api/merchant/products').set(authHeader(token))
      .send({ ...baseBody, stockMode: 'limited', stock: 10 }).expect(201)
    const product = await prisma.product.findUnique({ where: { id: res.body.id } })
    expect(product?.stockMode).toBe('limited')
    expect(product?.stock).toBe(10)
  })

  it('rejects instant_fixed without fixedContent', async () => {
    const token = await merchantToken('if-nocontent@test.local')
    const { fixedContent: _omit, ...body } = baseBody
    await api.post('/api/merchant/products').set(authHeader(token)).send(body).expect(400)
  })

  it('rejects dangerous url protocols', async () => {
    const token = await merchantToken('if-xss@test.local')
    await api.post('/api/merchant/products').set(authHeader(token))
      .send({ ...baseBody, fixedContent: 'javascript:alert(1)' }).expect(400)
  })

  it('rejects limited stockMode without stock for instant_fixed', async () => {
    const token = await merchantToken('if-nostock@test.local')
    await api.post('/api/merchant/products').set(authHeader(token))
      .send({ ...baseBody, stockMode: 'limited' }).expect(400)
  })

  it('rejects fixedContent for instant_inventory products', async () => {
    const token = await merchantToken('if-inv-fc@test.local')
    await api.post('/api/merchant/products').set(authHeader(token))
      .send({ name: '卡密带内容', type: '充值卡密', price: 10, deliveryMode: 'instant_inventory', fixedContent: '不该有' })
      .expect(400)
  })

  it('rejects unlimited stockMode for instant_inventory', async () => {
    const token = await merchantToken('if-inv@test.local')
    await api.post('/api/merchant/products').set(authHeader(token))
      .send({ name: '卡密', type: '充值卡密', price: 10, deliveryMode: 'instant_inventory', stockMode: 'unlimited' })
      .expect(400)
  })
})

describe('merchant instant_fixed product update', () => {
  async function createInstantFixedProduct(token: string) {
    const res = await api.post('/api/merchant/products').set(authHeader(token))
      .send(baseBody).expect(201)
    return res.body.id as number
  }

  it('updates price only without touching delivery fields', async () => {
    const token = await merchantToken('if-up-price@test.local')
    const productId = await createInstantFixedProduct(token)
    await api.put(`/api/merchant/products/${productId}`).set(authHeader(token))
      .send({ price: 99 }).expect(200)
    const product = await prisma.product.findUnique({ where: { id: productId } })
    expect(product?.price).toBe(99)
    expect(product?.deliveryMode).toBe('instant_fixed')
    expect(product?.fixedContent).toBe('https://example.com/group-invite')
  })

  it('switches instant_fixed to manual_service with fixedContent null', async () => {
    const token = await merchantToken('if-up-switch@test.local')
    const productId = await createInstantFixedProduct(token)
    await api.put(`/api/merchant/products/${productId}`).set(authHeader(token))
      .send({ deliveryMode: 'manual_service', fixedContent: null }).expect(200)
    const product = await prisma.product.findUnique({ where: { id: productId } })
    expect(product?.deliveryMode).toBe('manual_service')
    expect(product?.fixedContent).toBeNull()
    expect(product?.stockMode).toBe('unlimited')
  })

  it('rejects mode switch without clearing fixedContent with guiding message', async () => {
    const token = await merchantToken('if-up-noclear@test.local')
    const productId = await createInstantFixedProduct(token)
    const res = await api.put(`/api/merchant/products/${productId}`).set(authHeader(token))
      .send({ deliveryMode: 'manual_service' }).expect(400)
    expect(res.body.error?.message).toContain('切换交付模式')
  })

  it('rejects direct stock update for instant_inventory products', async () => {
    const token = await merchantToken('if-up-stock@test.local')
    const res = await api.post('/api/merchant/products').set(authHeader(token))
      .send({ name: '卡密更新', type: '充值卡密', price: 10, deliveryMode: 'instant_inventory' })
      .expect(201)
    await api.put(`/api/merchant/products/${res.body.id}`).set(authHeader(token))
      .send({ stock: 100 }).expect(400)
  })
})

describe('inventory operations restricted to instant_inventory', () => {
  it('rejects inventory import for instant_fixed products', async () => {
    const token = await merchantToken('if-noimport@test.local')
    const created = await api.post('/api/merchant/products').set(authHeader(token))
      .send(baseBody).expect(201)

    await api.post(`/api/merchant/products/${created.body.id}/inventory/preview`)
      .set(authHeader(token)).send({ text: 'CARD-001' }).expect(400)
    await api.post(`/api/merchant/products/${created.body.id}/inventory`)
      .set(authHeader(token)).send({ text: 'CARD-001' }).expect(400)
    await api.post(`/api/merchant/products/${created.body.id}/inventory/void`)
      .set(authHeader(token)).send({ count: 1 }).expect(400)
  })

  it('rejects admin inventory import for instant_fixed products', async () => {
    const merchantTokenValue = await merchantToken('if-admin-noimport@test.local')
    const created = await api.post('/api/merchant/products').set(authHeader(merchantTokenValue))
      .send(baseBody).expect(201)

    const { user, password } = await createTestUser('if-admin@test.local', 'admin123', 'admin')
    const { accessToken } = await loginAs(user.email, password)

    await api.post(`/api/admin/products/${created.body.id}/inventory`)
      .set(authHeader(accessToken)).send({ items: ['CARD-001'] }).expect(400)
  })
})
