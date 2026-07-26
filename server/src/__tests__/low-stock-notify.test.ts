import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { CaptureMailer } from '../lib/mailer/capture.js'
import { __setMailerForTesting } from '../lib/mailer/index.js'
import type { Mailer } from '../lib/mailer/types.js'
import { runLowStockNotifyBatch } from '../lib/lowStockNotify.js'
import { createTestMerchant } from './helpers.js'

const HOUR_MS = 60 * 60 * 1000

let mailer: CaptureMailer

beforeEach(async () => {
  mailer = new CaptureMailer()
  __setMailerForTesting(mailer)
  await setConfig('lowStockThreshold', 2)
  await setConfig('lowStockNotifyCooldownHours', 24)
})

afterEach(async () => {
  __setMailerForTesting(null)
  // SystemConfig 不在 setup 的 TRUNCATE 列表里，须显式清理防跨文件泄漏。
  await prisma.systemConfig.deleteMany({
    where: { key: { in: ['lowStockThreshold', 'lowStockNotifyCooldownHours'] } },
  })
})

async function setConfig(key: string, value: number) {
  await prisma.systemConfig.upsert({
    where: { key },
    create: { key, value, description: 'test' },
    update: { value },
  })
}

async function createInstantInventoryOffer(input: {
  email: string
  contactEmail?: string | null
  productName?: string
  offerName?: string
  availableItems?: number
  productStatus?: string
  offerStatus?: string
}) {
  const { merchant, user } = await createTestMerchant(input.email, 'pass123', {
    role: 'merchant',
    status: 'active',
    name: `商家-${input.email}`,
  })
  // helper 总是回填 contactEmail=登录邮箱；测 user.email 回退时须显式置空。
  if (input.contactEmail !== undefined) {
    await prisma.merchant.update({
      where: { id: merchant.id },
      data: { contactEmail: input.contactEmail },
    })
  }
  const product = await prisma.product.create({
    data: {
      name: input.productName ?? '低库存商品',
      type: '网络节点',
      price: 100,
      status: input.productStatus ?? 'active',
      merchantId: merchant.id,
      deliveryMode: 'instant_inventory',
    },
  })
  const offer = await prisma.offer.create({
    data: {
      productId: product.id,
      name: input.offerName ?? '默认规格',
      isDefault: true,
      price: 100,
      status: input.offerStatus ?? 'active',
      deliveryMode: 'instant_inventory',
      stockMode: 'limited',
      stock: input.availableItems ?? 0,
    },
  })
  for (let i = 0; i < (input.availableItems ?? 0); i++) {
    await prisma.inventoryItem.create({
      data: { productId: product.id, offerId: offer.id, content: `${input.email}-item-${i}`, status: 'available' },
    })
  }
  return { merchant, user, product, offer }
}

async function getNotice(offerId: number) {
  return prisma.lowStockNotice.findUnique({ where: { offerId } })
}

describe('runLowStockNotifyBatch', () => {
  it('sends one mail when an instant_inventory offer crosses into low stock (contactEmail preferred, user.email fallback)', async () => {
    const now = new Date()
    const withContact = await createInstantInventoryOffer({
      email: 'low-stock-contact@test.local',
      contactEmail: 'ops-contact@test.local',
      productName: '节点套餐',
      offerName: '月卡',
      availableItems: 2, // = 阈值 2，判定为低位（<=）
    })
    const noContact = await createInstantInventoryOffer({
      email: 'low-stock-nocontact@test.local',
      contactEmail: null,
      productName: '账号商品',
      offerName: '美区',
      availableItems: 1,
    })

    await runLowStockNotifyBatch(now)

    expect(mailer.sent).toHaveLength(2)

    const contactMail = mailer.lastTo('ops-contact@test.local')
    expect(contactMail).toBeDefined()
    expect(contactMail!.subject).toContain('低库存')
    expect(contactMail!.subject).toContain('节点套餐')
    expect(contactMail!.text).toContain('节点套餐')
    expect(contactMail!.text).toContain('月卡')
    expect(contactMail!.text).toContain('当前可用库存：2 件')
    expect(contactMail!.text).toContain('预警阈值：2 件')
    expect(contactMail!.text).toContain('商家后台')

    // contactEmail 缺失时回退到商家账号邮箱
    const fallbackMail = mailer.lastTo(noContact.user.email)
    expect(fallbackMail).toBeDefined()
    expect(fallbackMail!.text).toContain('美区')

    const notice = await getNotice(withContact.offer.id)
    expect(notice).toMatchObject({ isLow: true, lastAvailable: 2 })
    expect(notice!.lastNotifiedAt?.getTime()).toBe(now.getTime())
  })

  it('does not re-send within cooldown but re-sends after it elapses', async () => {
    const now = new Date()
    const { offer } = await createInstantInventoryOffer({
      email: 'low-stock-cooldown@test.local',
      availableItems: 1,
    })

    await runLowStockNotifyBatch(now)
    expect(mailer.sent).toHaveLength(1)

    // 冷却期内（+1 小时）持续低位：不重发，只刷新观测值
    await runLowStockNotifyBatch(new Date(now.getTime() + HOUR_MS))
    expect(mailer.sent).toHaveLength(1)

    // 冷却期满（24h 后）：重发并推进 lastNotifiedAt
    const later = new Date(now.getTime() + 25 * HOUR_MS)
    await runLowStockNotifyBatch(later)
    expect(mailer.sent).toHaveLength(2)
    const notice = await getNotice(offer.id)
    expect(notice!.lastNotifiedAt?.getTime()).toBe(later.getTime())
  })

  it('recovery above threshold resets isLow, and dropping again re-alerts immediately', async () => {
    const now = new Date()
    const { product, offer } = await createInstantInventoryOffer({
      email: 'low-stock-recover@test.local',
      availableItems: 1,
    })

    await runLowStockNotifyBatch(now)
    expect(mailer.sent).toHaveLength(1)

    // 回升到阈值之上：复位 isLow，不发信
    for (let i = 0; i < 4; i++) {
      await prisma.inventoryItem.create({
        data: { productId: product.id, offerId: offer.id, content: `recover-extra-${i}`, status: 'available' },
      })
    }
    await runLowStockNotifyBatch(new Date(now.getTime() + HOUR_MS))
    expect(mailer.sent).toHaveLength(1)
    expect((await getNotice(offer.id))!.isLow).toBe(false)

    // 再次跌破：即使距上次发信不足冷却期，也按新一轮跨入立即告警
    await prisma.inventoryItem.updateMany({
      where: { offerId: offer.id, content: { startsWith: 'recover-extra-' } },
      data: { status: 'sold' },
    })
    await runLowStockNotifyBatch(new Date(now.getTime() + 2 * HOUR_MS))
    expect(mailer.sent).toHaveLength(2)
    expect((await getNotice(offer.id))!.isLow).toBe(true)
  })

  it('limited manual_service offers alert on Offer.stock; unlimited offers never alert', async () => {
    const { merchant, product } = await createInstantInventoryOffer({
      email: 'low-stock-capacity@test.local',
      availableItems: 5, // 高于阈值的即时库存规格，不参与本例断言
    })
    const limited = await prisma.offer.create({
      data: {
        productId: product.id,
        name: '有限容量服务',
        price: 200,
        deliveryMode: 'manual_service',
        stockMode: 'limited',
        stock: 1,
      },
    })
    const unlimited = await prisma.offer.create({
      data: {
        productId: product.id,
        name: '无限容量服务',
        price: 200,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
        stock: 0,
      },
    })
    // 非在售商品的低位规格不参与告警
    const offShelf = await createInstantInventoryOffer({
      email: 'low-stock-offshelf@test.local',
      productStatus: 'inactive',
      availableItems: 0,
    })
    void merchant

    await runLowStockNotifyBatch()

    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0].text).toContain('有限容量服务')
    expect(mailer.sent[0].text).toContain('当前可用库存：1 件')
    expect((await getNotice(limited.id))!.isLow).toBe(true)
    expect(await getNotice(unlimited.id)).toBeNull()
    expect(await getNotice(offShelf.offer.id)).toBeNull()
  })

  it('mail failure keeps lastNotifiedAt null, continues the batch, and the next run retries', async () => {
    const now = new Date()
    const first = await createInstantInventoryOffer({
      email: 'low-stock-fail-a@test.local',
      offerName: '规格甲',
      availableItems: 1,
    })
    const second = await createInstantInventoryOffer({
      email: 'low-stock-fail-b@test.local',
      offerName: '规格乙',
      availableItems: 1,
    })

    const failingMailer: Mailer = {
      async send() {
        throw new Error('smtp down')
      },
    }
    __setMailerForTesting(failingMailer)
    await runLowStockNotifyBatch(now)

    // 两条规格都被处理（发信失败不中断批次），isLow 落位但 lastNotifiedAt 保持 null
    for (const offerId of [first.offer.id, second.offer.id]) {
      const notice = await getNotice(offerId)
      expect(notice).toMatchObject({ isLow: true, lastNotifiedAt: null })
    }

    // 下一轮换回可用邮箱：lastNotifiedAt=null 视为"待发送"，冷却期不拦截重试
    __setMailerForTesting(mailer)
    await runLowStockNotifyBatch(now)
    expect(mailer.sent).toHaveLength(2)
    expect(mailer.lastTo('low-stock-fail-a@test.local')!.text).toContain('规格甲')
    expect(mailer.lastTo('low-stock-fail-b@test.local')!.text).toContain('规格乙')
    for (const offerId of [first.offer.id, second.offer.id]) {
      expect((await getNotice(offerId))!.lastNotifiedAt?.getTime()).toBe(now.getTime())
    }
  })

  it('cooldown=0 means no re-send while continuously low', async () => {
    await setConfig('lowStockNotifyCooldownHours', 0)
    const now = new Date()
    const { offer } = await createInstantInventoryOffer({
      email: 'low-stock-zerocd@test.local',
      availableItems: 1,
    })

    await runLowStockNotifyBatch(now)
    expect(mailer.sent).toHaveLength(1)

    // 冷却关闭：持续低位期间无论过多久都不重发
    await runLowStockNotifyBatch(new Date(now.getTime() + 1000 * HOUR_MS))
    expect(mailer.sent).toHaveLength(1)
    expect((await getNotice(offer.id))!.lastNotifiedAt?.getTime()).toBe(now.getTime())
  })
})
