import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../../lib/prisma.js'
import { config } from '../../../config/index.js'
import {
  NotificationDispatcher,
  buildDedupeKey,
  shouldNotifyBuyerDelivered,
  shouldNotifyMerchantNewOrder,
} from '../dispatcher.js'

async function seedUser(email: string, role = 'user') {
  return prisma.user.create({
    data: {
      email,
      password: 'hashed',
      role,
      status: '正常',
      pointAccount: { create: { balance: 10_000 } },
    },
  })
}

describe('shouldNotifyMerchantNewOrder (NTF-05)', () => {
  it('allows merchant manual pending without auto tasks', () => {
    expect(shouldNotifyMerchantNewOrder({
      merchantId: 1,
      deliveryMode: 'manual_service',
      status: 'pending',
      hasProvisionTask: false,
      hasFakaBridgeTask: false,
    })).toBe(true)
  })

  it('rejects platform-owned manual (merchantId null)', () => {
    expect(shouldNotifyMerchantNewOrder({
      merchantId: null,
      deliveryMode: 'manual_service',
      status: 'pending',
      hasProvisionTask: false,
      hasFakaBridgeTask: false,
    })).toBe(false)
  })

  it('rejects instant modes', () => {
    expect(shouldNotifyMerchantNewOrder({
      merchantId: 1,
      deliveryMode: 'instant_inventory',
      status: 'delivered',
      hasProvisionTask: false,
      hasFakaBridgeTask: false,
    })).toBe(false)
  })

  it('rejects when ProvisionTask exists', () => {
    expect(shouldNotifyMerchantNewOrder({
      merchantId: 1,
      deliveryMode: 'manual_service',
      status: 'pending',
      hasProvisionTask: true,
      hasFakaBridgeTask: false,
    })).toBe(false)
  })

  it('rejects when FakaBridgeTask exists', () => {
    expect(shouldNotifyMerchantNewOrder({
      merchantId: 1,
      deliveryMode: 'manual_service',
      status: 'pending',
      hasProvisionTask: false,
      hasFakaBridgeTask: true,
    })).toBe(false)
  })

  it('rejects terminal statuses', () => {
    expect(shouldNotifyMerchantNewOrder({
      merchantId: 1,
      deliveryMode: 'manual_service',
      status: 'delivered',
      hasProvisionTask: false,
      hasFakaBridgeTask: false,
    })).toBe(false)
  })
})

describe('shouldNotifyBuyerDelivered (NTF-06)', () => {
  it('true for delivered/completed', () => {
    expect(shouldNotifyBuyerDelivered({ status: 'delivered' })).toBe(true)
    expect(shouldNotifyBuyerDelivered({ status: 'completed' })).toBe(true)
  })
  it('false for other statuses', () => {
    expect(shouldNotifyBuyerDelivered({ status: 'pending' })).toBe(false)
  })
})

describe('buildDedupeKey', () => {
  it('matches Phase 1 event key patterns', () => {
    expect(buildDedupeKey('order.created_merchant', 9)).toBe('order:9:merchant_new')
    expect(buildDedupeKey('order.delivered_buyer', 9)).toBe('order:9:delivered')
    expect(buildDedupeKey('order.disputed_merchant', 9)).toBe('order:9:disputed_m')
    expect(buildDedupeKey('order.refunded_merchant', 9)).toBe('order:9:refunded_m')
  })
})

describe('NotificationDispatcher.emit', () => {
  const prevEnabled = config.notification.enabled

  beforeEach(() => {
    config.notification.enabled = true
  })

  afterEach(() => {
    config.notification.enabled = prevEnabled
  })

  it('creates one notification for merchant new order', async () => {
    const merchantUser = await seedUser('merchant-n@test.com', 'merchant')
    await prisma.$transaction(async (tx) => {
      await NotificationDispatcher.emit({
        type: 'order.created_merchant',
        recipientUserId: merchantUser.id,
        recipientRole: 'merchant',
        order: {
          id: 1001,
          merchantId: 1,
          deliveryMode: 'manual_service',
          productName: '人工商品',
        },
      }, tx)
    })
    const rows = await prisma.notification.findMany({ where: { recipientUserId: merchantUser.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.eventType).toBe('order.created_merchant')
    expect(rows[0]!.deeplink).toBe('/merchant/orders/1001')
    expect(JSON.stringify(rows[0]!.payload)).not.toMatch(/content/)
  })

  it('is idempotent for the same dedupeKey', async () => {
    const user = await seedUser('buyer-dup@test.com')
    const event = {
      type: 'order.delivered_buyer' as const,
      recipientUserId: user.id,
      recipientRole: 'user' as const,
      order: {
        id: 2002,
        merchantId: null,
        deliveryMode: 'instant_inventory',
        productName: '卡密',
      },
      context: { deliveryKind: 'instant' },
    }
    await prisma.$transaction(async (tx) => {
      await NotificationDispatcher.emit(event, tx)
      await NotificationDispatcher.emit(event, tx)
      await NotificationDispatcher.emit(event, tx)
    })
    expect(await prisma.notification.count({ where: { recipientUserId: user.id } })).toBe(1)
  })

  it('skips writes when notification.enabled is false', async () => {
    config.notification.enabled = false
    const user = await seedUser('buyer-off@test.com')
    await prisma.$transaction(async (tx) => {
      await NotificationDispatcher.emit({
        type: 'order.delivered_buyer',
        recipientUserId: user.id,
        recipientRole: 'user',
        order: {
          id: 3003,
          deliveryMode: 'instant_fixed',
          productName: '固定内容',
        },
        context: { deliveryKind: 'instant' },
      }, tx)
    })
    expect(await prisma.notification.count({ where: { recipientUserId: user.id } })).toBe(0)
  })

  it('instant delivered payload has no sensitive content keys', async () => {
    const user = await seedUser('buyer-safe@test.com')
    await prisma.$transaction(async (tx) => {
      await NotificationDispatcher.emit({
        type: 'order.delivered_buyer',
        recipientUserId: user.id,
        recipientRole: 'user',
        order: {
          id: 4004,
          deliveryMode: 'instant_inventory',
          productName: 'Secret SKU',
        },
        context: { deliveryKind: 'instant', content: 'LEAKED-CARD-CODE' },
      }, tx)
    })
    const row = await prisma.notification.findFirst({ where: { recipientUserId: user.id } })
    expect(row).toBeTruthy()
    const payload = row!.payload as Record<string, unknown>
    expect(payload).not.toHaveProperty('content')
    expect(JSON.stringify(payload)).not.toContain('LEAKED-CARD-CODE')
  })
})
