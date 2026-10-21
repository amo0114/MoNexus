import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../../lib/prisma.js'
import { config } from '../../config/index.js'
import {
  __clearFakaCapacityCacheForTests,
  __setFakaCapacityProbeForTests,
  prewarmFakaCapacityForSkus,
} from '../../lib/fakaBridge/capacity.js'
import { getActiveNetworkNodeCategoryId } from '../../__tests__/catalogFixture.js'
import { productDetail, searchProducts } from './catalog.js'

const baseUrl = 'https://shop.test'

async function makeProduct(name: string, offer: Record<string, unknown>) {
  const product = await prisma.product.create({
    data: {
      name, type: '网络节点', categoryId: await getActiveNetworkNodeCategoryId(), price: 100, stock: 9,
      status: 'active', visibility: 'public', deliveryMode: 'manual_service', stockMode: 'unlimited',
    },
  })
  await prisma.offer.create({
    data: {
      productId: product.id, name: '默认', isDefault: true, price: 100, stock: 0,
      deliveryMode: 'manual_service', stockMode: 'unlimited', ...offer,
    },
  })
  return product
}

describe('chatbot catalog stock labels follow public availability', () => {
  const originalFaka = { ...config.fakaBridge }

  afterEach(() => {
    __setFakaCapacityProbeForTests(undefined)
    __clearFakaCapacityCacheForTests()
    Object.assign(config.fakaBridge, originalFaka)
  })

  it('reports unsellable Faka quota and offer-less products as unavailable, unknown capacity as pending', async () => {
    Object.assign(config.fakaBridge, {
      enabled: true,
      url: 'https://v.uuwu.de/plugin/faka-bridge/order-paid',
      statusUrl: 'https://v.uuwu.de/plugin/faka-bridge/order-status',
      secret: 'unit-test-faka-secret-at-least-32-characters!!',
      timeoutMs: 5_000,
      maxAttempts: 3,
      allowInsecureTargets: false,
    })
    __setFakaCapacityProbeForTests(async sku => sku === 'bot-blocked'
      ? { sku, planId: 1, capacityLimit: 10, activeUsers: 6, remaining: 4, sellable: false, source: 'xboard' }
      : { sku, planId: null, capacityLimit: null, activeUsers: null, remaining: null, sellable: true, source: 'unavailable' })
    await prewarmFakaCapacityForSkus(['bot-blocked', 'bot-unknown'])

    const blocked = await makeProduct('机器人禁售名额', { externalIntegration: 'faka_bridge', externalSku: 'bot-blocked' })
    const unknown = await makeProduct('机器人容量未知', { externalIntegration: 'faka_bridge', externalSku: 'bot-unknown' })
    const noOffer = await makeProduct('机器人无启用套餐', { status: 'inactive' })
    const open = await makeProduct('机器人可售', {})

    // 视角显式传 guest：这些商品都是 visibility='public'，库存文案与视角无关，
    // 但 audience 现在是必填参数（BOT-1 之后不再有隐含的 member 默认值）。
    const { items } = await searchProducts({ keyword: '机器人', page: 1, baseUrl, audience: 'guest' })
    const labels = Object.fromEntries(items.map(item => [item.id, [item.stockLabel, item.soldOut]]))
    expect(labels).toEqual({
      [blocked.id]: ['暂不可售', true],
      [unknown.id]: ['待确认', false],
      [noOffer.id]: ['暂不可售', true],
      [open.id]: ['不限', false],
    })

    const detail = await productDetail({ id: blocked.id, baseUrl, audience: 'guest' })
    expect(detail).toMatchObject({
      kind: 'found',
      product: { stockLabel: '暂不可售', soldOut: true },
    })
  })
})
