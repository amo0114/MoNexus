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

describe('M5 merchant offer FakaBridge fields', () => {
  beforeEach(() => {
    enableFakaBridgeConfig()
  })

  afterEach(() => {
    Object.assign(config.fakaBridge, ORIG_FAKA)
  })

  it('creates an offer with faka_bridge + externalSku', async () => {
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

    const offer = await api
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
      .expect(201)

    expect(offer.body.externalIntegration).toBe('faka_bridge')
    expect(offer.body.externalSku).toBe('aster-basic-monthly')

    const row = await prisma.offer.findUniqueOrThrow({ where: { id: offer.body.id } })
    expect(row.externalIntegration).toBe('faka_bridge')
    expect(row.externalSku).toBe('aster-basic-monthly')
  })

  it('rejects faka_bridge with non-manual deliveryMode', async () => {
    const { accessToken } = await setupMerchant(`faka-m5-mode-${Date.now()}@test.local`)
    const product = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({
        name: '错模式',
        type: '网络节点',
        price: 100,
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        fixedContent: 'x',
      })
      .expect(201)

    const res = await api
      .post(`/api/merchant/products/${product.body.id}/offers`)
      .set(authHeader(accessToken))
      .send({
        name: '坏规格',
        price: 100,
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        fixedContent: 'secret',
        externalIntegration: 'faka_bridge',
        externalSku: 'aster-basic-monthly',
      })
      .expect(400)

    expect(JSON.stringify(res.body)).toMatch(/manual_service|FakaBridge|履约/)
  })

  it('rejects when platform FakaBridge env is missing', async () => {
    Object.assign(config.fakaBridge, ORIG_FAKA) // disabled
    const { accessToken } = await setupMerchant(`faka-m5-env-${Date.now()}@test.local`)
    const product = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({
        name: '无配置',
        type: '网络节点',
        price: 100,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
      })
      .expect(201)

    await api
      .post(`/api/merchant/products/${product.body.id}/offers`)
      .set(authHeader(accessToken))
      .send({
        name: '月卡',
        price: 100,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
        externalIntegration: 'faka_bridge',
        externalSku: 'aster-basic-monthly',
      })
      .expect(400)
  })

  it('updates and clears faka fields', async () => {
    const { accessToken } = await setupMerchant(`faka-m5-upd-${Date.now()}@test.local`)
    const product = await api
      .post('/api/merchant/products')
      .set(authHeader(accessToken))
      .send({
        name: '可更新',
        type: '网络节点',
        price: 200,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
      })
      .expect(201)

    const created = await api
      .post(`/api/merchant/products/${product.body.id}/offers`)
      .set(authHeader(accessToken))
      .send({
        name: '季卡',
        price: 500,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
        externalIntegration: 'faka_bridge',
        externalSku: 'aster-basic-quarterly',
      })
      .expect(201)

    const updated = await api
      .put(`/api/merchant/products/${product.body.id}/offers/${created.body.id}`)
      .set(authHeader(accessToken))
      .send({
        externalSku: 'aster-pro-monthly',
      })
      .expect(200)

    expect(updated.body.externalSku).toBe('aster-pro-monthly')
    expect(updated.body.externalIntegration).toBe('faka_bridge')

    const cleared = await api
      .put(`/api/merchant/products/${product.body.id}/offers/${created.body.id}`)
      .set(authHeader(accessToken))
      .send({
        externalIntegration: null,
        externalSku: null,
      })
      .expect(200)

    expect(cleared.body.externalIntegration).toBeNull()
    expect(cleared.body.externalSku).toBeNull()
  })

  it('lists offers with faka fields for the merchant', async () => {
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

    await api
      .post(`/api/merchant/products/${product.body.id}/offers`)
      .set(authHeader(accessToken))
      .send({
        name: '年卡',
        price: 900,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
        externalIntegration: 'faka_bridge',
        externalSku: 'aster-basic-yearly',
      })
      .expect(201)

    const list = await api
      .get(`/api/merchant/products/${product.body.id}/offers`)
      .set(authHeader(accessToken))
      .expect(200)

    const fakaOffer = list.body.find((o: { externalSku?: string }) => o.externalSku === 'aster-basic-yearly')
    expect(fakaOffer).toBeTruthy()
    expect(fakaOffer.externalIntegration).toBe('faka_bridge')
  })
})
