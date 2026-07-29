import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import {
  api,
  createTestMerchant,
  loginAsMerchant,
  authHeader,
} from './helpers.js'

const ORIG_FAKA = { ...config.fakaBridge }

function enableFakaBridgeConfig() {
  Object.assign(config.fakaBridge, {
    enabled: true,
    url: 'https://v.uuwu.de/plugin/faka-bridge/order-paid',
    statusUrl: 'https://v.uuwu.de/plugin/faka-bridge/order-status',
    secret: 'unit-test-faka-secret-at-least-32-characters!!',
    timeoutMs: 5000,
    maxAttempts: 3,
    allowInsecureTargets: false,
  })
}

async function setupMerchant(email: string) {
  await createTestMerchant(email, 'pass123', {
    role: 'merchant',
    status: 'active',
    name: 'Faka 商家',
  })
  const { accessToken } = await loginAsMerchant(email, 'pass123')
  return { accessToken }
}

describe('M5 merchant offer FakaBridge fields (admin-only v1)', () => {
  beforeEach(() => {
    enableFakaBridgeConfig()
  })

  afterEach(() => {
    Object.assign(config.fakaBridge, ORIG_FAKA)
  })

  it('rejects merchant creating offer with faka_bridge (platform credentials)', async () => {
    const { accessToken } = await setupMerchant(`faka-m5-create-${Date.now()}@test.local`)

    const product = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({
        name: 'Aster 套餐',
        type: '网络节点',
        price: 999,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
      })
      .expect(201)

    const res = await api
      .post(`/api/merchant/products/${product.body.id}/offers`)
      .set(authHeader(accessToken))
      .send({
        name: '月卡',
        price: 999,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
        externalIntegration: 'faka_bridge',
        externalSku: 'aster-basic-monthly',
        validityDays: 30,
      })
      .expect(400)

    expect(JSON.stringify(res.body)).toMatch(/管理员|FakaBridge|平台/)
  })

  it('rejects merchant writing externalSku alone', async () => {
    const { accessToken } = await setupMerchant(`faka-m5-sku-${Date.now()}@test.local`)
    const product = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({
        name: 'SKU only',
        type: '网络节点',
        price: 100,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
      })
      .expect(201)

    const offer = await api
      .post(`/api/merchant/products/${product.body.id}/offers`)
      .set(authHeader(accessToken))
      .send({
        name: '普通规格',
        price: 100,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
      })
      .expect(201)

    const res = await api
      .put(`/api/merchant/products/${product.body.id}/offers/${offer.body.id}`)
      .set(authHeader(accessToken))
      .send({ externalSku: 'aster-basic-monthly' })
      .expect(400)

    expect(JSON.stringify(res.body)).toMatch(/管理员|externalSku|FakaBridge/)
  })

  it('allows merchant to create non-faka offers normally', async () => {
    const { accessToken } = await setupMerchant(`faka-m5-plain-${Date.now()}@test.local`)
    const product = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({
        name: '普通商品',
        type: '网络节点',
        price: 100,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
      })
      .expect(201)

    const offer = await api
      .post(`/api/merchant/products/${product.body.id}/offers`)
      .set(authHeader(accessToken))
      .send({
        name: '人工交付',
        price: 100,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
      })
      .expect(201)

    expect(offer.body.externalIntegration ?? null).toBeNull()
  })

  it('merchant can list admin-provisioned faka offers on their product', async () => {
    const { accessToken } = await setupMerchant(`faka-m5-list-${Date.now()}@test.local`)
    const product = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({
        name: '列表商品',
        type: '网络节点',
        price: 100,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
      })
      .expect(201)

    // Admin path / seed: attach faka via prisma (platform only)
    await prisma.offer.create({
      data: {
        productId: product.body.id,
        name: '年卡',
        price: 900,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
        stock: 0,
        externalIntegration: 'faka_bridge',
        externalSku: 'aster-basic-yearly',
      },
    })

    const list = await api
      .get(`/api/merchant/products/${product.body.id}/offers`)
      .set(authHeader(accessToken))
      .expect(200)

    const fakaOffer = list.body.find(
      (o: { externalSku?: string }) => o.externalSku === 'aster-basic-yearly'
    )
    expect(fakaOffer).toBeTruthy()
    expect(fakaOffer.externalIntegration).toBe('faka_bridge')
  })
})
