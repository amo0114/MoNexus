import { describe, it, expect } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { api, createTestMerchant, loginAsMerchant, authHeader } from '../../__tests__/helpers.js'

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
