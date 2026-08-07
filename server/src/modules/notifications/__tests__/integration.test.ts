import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  api,
  authHeader,
  createTestMerchant,
  createTestProduct,
  createTestUser,
  getDefaultOfferId,
  loginAs,
  makeManualService,
} from '../../../__tests__/helpers.js'
import { prisma } from '../../../lib/prisma.js'
import { config } from '../../../config/index.js'
import { transitionOrderStatus } from '../../orders/fulfillment.js'
import * as outbound from '../../../lib/outboundWebhook.js'
import * as webhookConfigService from '../../merchant/webhookConfig.js'

describe('Order notification integration (T04)', () => {
  const prev = config.notification.enabled

  beforeEach(() => {
    config.notification.enabled = true
  })

  afterEach(() => {
    config.notification.enabled = prev
  })

  it('A-01: manual merchant order creates order.created_merchant for merchant owner', async () => {
    const { user: merchantUser, merchant } = await createTestMerchant('int-m1@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
      name: '通知商家',
    })
    await createTestUser('int-b1@test.local', 'pass123', 'user', 5000)
    const product = await createTestProduct('人工服务', 200, 0, [], merchant.id)
    await makeManualService(product.id)
    const { accessToken } = await loginAs('int-b1@test.local', 'pass123')

    const created = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: product.id })
      .expect(201)

    const merchantNotes = await prisma.notification.findMany({
      where: { recipientUserId: merchantUser.id, relatedOrderId: created.body.orderId },
    })
    expect(merchantNotes).toHaveLength(1)
    expect(merchantNotes[0]!.eventType).toBe('order.created_merchant')
    expect(merchantNotes[0]!.deeplink).toBe(`/merchant/orders/${created.body.orderId}`)

    const buyerNotes = await prisma.notification.findMany({
      where: {
        relatedOrderId: created.body.orderId,
        eventType: 'order.delivered_buyer',
      },
    })
    expect(buyerNotes).toHaveLength(0)
  })

  it('A-02/A-11: instant order notifies buyer weakly, never merchant new order', async () => {
    const { user: merchantUser, merchant } = await createTestMerchant('int-m2@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
    })
    const { user: buyer } = await createTestUser('int-b2@test.local', 'pass123', 'user', 5000)
    const product = await createTestProduct('即时卡密', 100, 2, ['CARD-A', 'CARD-B'], merchant.id)
    const { accessToken } = await loginAs('int-b2@test.local', 'pass123')

    const created = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: product.id })
      .expect(201)

    expect(created.body.status).toBe('delivered')
    expect(created.body.deliveryContent).toBeTruthy()

    const buyerNotes = await prisma.notification.findMany({
      where: { recipientUserId: buyer.id, relatedOrderId: created.body.orderId },
    })
    expect(buyerNotes).toHaveLength(1)
    expect(buyerNotes[0]!.eventType).toBe('order.delivered_buyer')
    expect(buyerNotes[0]!.title).toBe('订单已交付')
    expect(JSON.stringify(buyerNotes[0]!.payload)).not.toContain('CARD-')
    expect(buyerNotes[0]!.body).not.toContain('CARD-')

    const merchantNotes = await prisma.notification.findMany({
      where: { recipientUserId: merchantUser.id, relatedOrderId: created.body.orderId },
    })
    expect(merchantNotes).toHaveLength(0)
  })

  it('A-03: merchant deliver → buyer order.delivered_buyer', async () => {
    const { merchant } = await createTestMerchant('int-m3@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
    })
    const { user: buyer } = await createTestUser('int-b3@test.local', 'pass123', 'user', 5000)
    const product = await createTestProduct('人工交付', 150, 0, [], merchant.id)
    await makeManualService(product.id)
    const buyerLogin = await loginAs('int-b3@test.local', 'pass123')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyerLogin.accessToken))
      .send({ productId: product.id })
      .expect(201)

    await transitionOrderStatus({
      orderId: created.body.orderId,
      toStatus: 'processing',
      actorRole: 'merchant',
      action: 'merchant.fulfillment.start',
    })
    await transitionOrderStatus({
      orderId: created.body.orderId,
      toStatus: 'delivered',
      actorRole: 'merchant',
      action: 'merchant.fulfillment.deliver',
      deliveryContent: 'SECRET-DELIVERY-PAYLOAD',
    })

    const delivered = await prisma.notification.findMany({
      where: {
        recipientUserId: buyer.id,
        eventType: 'order.delivered_buyer',
        relatedOrderId: created.body.orderId,
      },
    })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.deeplink).toBe(`/orders?focus=${created.body.orderId}`)
    expect(JSON.stringify(delivered[0]!.payload)).not.toContain('SECRET-DELIVERY')

    const processing = await prisma.notification.findFirst({
      where: {
        recipientUserId: buyer.id,
        eventType: 'order.processing_buyer',
        relatedOrderId: created.body.orderId,
      },
    })
    expect(processing).toBeTruthy()
  })

  it('A-14: platform-owned manual_service does not create merchant_new or admin fanout', async () => {
    await createTestUser('int-admin@test.local', 'admin123', 'admin')
    const { user: buyer } = await createTestUser('int-b4@test.local', 'pass123', 'user', 5000)
    // platform product: merchantId null
    const product = await createTestProduct('平台人工', 120, 0, [])
    await makeManualService(product.id)
    const { accessToken } = await loginAs('int-b4@test.local', 'pass123')

    const created = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: product.id })
      .expect(201)

    const createdMerchant = await prisma.notification.count({
      where: {
        eventType: 'order.created_merchant',
        relatedOrderId: created.body.orderId,
      },
    })
    expect(createdMerchant).toBe(0)

    const anyForOrder = await prisma.notification.findMany({
      where: { relatedOrderId: created.body.orderId },
    })
    // no merchant_new; buyer not delivered yet for manual pending
    expect(anyForOrder.every((n) => n.eventType !== 'order.created_merchant')).toBe(true)
    expect(anyForOrder.filter((n) => n.recipientUserId === buyer.id)).toHaveLength(0)
  })

  it('dispute notifies both parties; refund notifies both parties', async () => {
    const { user: merchantUser, merchant } = await createTestMerchant('int-m5@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
    })
    const { user: buyer } = await createTestUser('int-b5@test.local', 'pass123', 'user', 5000)
    const product = await createTestProduct('争议商品', 100, 1, ['D-1'], merchant.id)
    const buyerLogin = await loginAs('int-b5@test.local', 'pass123')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyerLogin.accessToken))
      .send({ productId: product.id })
      .expect(201)

    await api
      .post(`/api/orders/${created.body.orderId}/dispute`)
      .set(authHeader(buyerLogin.accessToken))
      .expect(200)

    const disputedBuyer = await prisma.notification.findFirst({
      where: { recipientUserId: buyer.id, eventType: 'order.disputed_buyer', relatedOrderId: created.body.orderId },
    })
    const disputedMerchant = await prisma.notification.findFirst({
      where: {
        recipientUserId: merchantUser.id,
        eventType: 'order.disputed_merchant',
        relatedOrderId: created.body.orderId,
      },
    })
    expect(disputedBuyer).toBeTruthy()
    expect(disputedMerchant).toBeTruthy()

    await transitionOrderStatus({
      orderId: created.body.orderId,
      toStatus: 'refunded',
      actorRole: 'admin',
      action: 'admin.dispute.refund',
    })

    expect(await prisma.notification.count({
      where: { recipientUserId: buyer.id, eventType: 'order.refunded_buyer', relatedOrderId: created.body.orderId },
    })).toBe(1)
    expect(await prisma.notification.count({
      where: {
        recipientUserId: merchantUser.id,
        eventType: 'order.refunded_merchant',
        relatedOrderId: created.body.orderId,
      },
    })).toBe(1)
    expect(await prisma.notification.count({
      where: {
        recipientUserId: buyer.id,
        eventType: 'order.dispute_resolved_buyer',
        relatedOrderId: created.body.orderId,
      },
    })).toBe(1)
  })

  it('NOTIFICATION_ENABLED=false writes nothing on checkout', async () => {
    config.notification.enabled = false
    const { merchant } = await createTestMerchant('int-m6@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
    })
    await createTestUser('int-b6@test.local', 'pass123', 'user', 5000)
    const product = await createTestProduct('关闭开关人工', 200, 0, [], merchant.id)
    await makeManualService(product.id)
    const { accessToken } = await loginAs('int-b6@test.local', 'pass123')

    const created = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: product.id })
      .expect(201)

    expect(await prisma.notification.count({ where: { relatedOrderId: created.body.orderId } })).toBe(0)
  })

  it('A-04: autoProvision checkout is silent for merchant; system deliver notifies buyer only without secret leak', async () => {
    // DNS inject so webhook URL validation accepts test hostnames (same as p7b suite).
    outbound.__setWebhookDnsResolverForTests(async () => [{ address: '93.184.216.34', family: 4 }])
    try {
      const { user: merchantUser, merchant } = await createTestMerchant('int-ap-m@test.local', 'pass123', {
        role: 'merchant',
        status: 'active',
        name: '自动开通商家',
        contactEmail: 'int-ap-m@test.local',
      })
      const { user: buyer } = await createTestUser('int-ap-b@test.local', 'pass123', 'user', 5000)
      const product = await createTestProduct('自动开通服务', 200, 0, [], merchant.id)
      await makeManualService(product.id)
      const offerId = await getDefaultOfferId(product.id)
      await webhookConfigService.saveMyWebhookConfig(merchant.id, 'https://hook-notify.example.test/provision')
      await prisma.offer.update({ where: { id: offerId }, data: { autoProvision: true } })

      // Brake first-attempt setImmediate so we only assert checkout emit first.
      await prisma.systemConfig.upsert({
        where: { key: 'autoProvisionMaxAttempts' },
        update: { value: 0 },
        create: { key: 'autoProvisionMaxAttempts', value: 0, description: 'test brake' },
      })

      const buyerLogin = await loginAs('int-ap-b@test.local', 'pass123')
      const created = await api
        .post('/api/orders')
        .set(authHeader(buyerLogin.accessToken))
        .send({ productId: product.id })
        .expect(201)

      const orderId = created.body.orderId as number
      expect(await prisma.provisionTask.count({ where: { orderId } })).toBe(1)

      // NTF-05 / D-08: ProvisionTask present → no merchant new-order notification.
      expect(await prisma.notification.count({
        where: {
          recipientUserId: merchantUser.id,
          eventType: 'order.created_merchant',
          relatedOrderId: orderId,
        },
      })).toBe(0)

      // Simulate autoProvision success path (same transitionOrderStatus + action as provisionCron).
      await transitionOrderStatus({
        orderId,
        toStatus: 'processing',
        actorRole: 'system',
        action: 'system.auto_provision.start',
      })
      await transitionOrderStatus({
        orderId,
        toStatus: 'delivered',
        actorRole: 'system',
        action: 'system.auto_provision.deliver',
        deliveryContent: 'AUTO-PROVISION-SECRET-TOKEN',
      })

      const buyerDelivered = await prisma.notification.findMany({
        where: {
          recipientUserId: buyer.id,
          eventType: 'order.delivered_buyer',
          relatedOrderId: orderId,
        },
      })
      expect(buyerDelivered).toHaveLength(1)
      expect(buyerDelivered[0]!.title).toBe('订阅已开通')
      expect(JSON.stringify(buyerDelivered[0]!.payload)).not.toContain('AUTO-PROVISION-SECRET')
      expect(buyerDelivered[0]!.body).not.toContain('AUTO-PROVISION-SECRET')

      // Merchant remains silent on success (no new-order, no delivered ack).
      expect(await prisma.notification.count({
        where: { recipientUserId: merchantUser.id, relatedOrderId: orderId },
      })).toBe(0)

      // Idempotent re-emit of the same delivered event.
      await prisma.$transaction(async (tx) => {
        const { NotificationDispatcher, orderNotificationSnapshot } = await import('../dispatcher.js')
        const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
        await NotificationDispatcher.emit({
          type: 'order.delivered_buyer',
          recipientUserId: buyer.id,
          recipientRole: 'user',
          order: orderNotificationSnapshot(order),
          context: { deliveryKind: 'auto' },
        }, tx)
      })
      expect(await prisma.notification.count({
        where: {
          recipientUserId: buyer.id,
          eventType: 'order.delivered_buyer',
          relatedOrderId: orderId,
        },
      })).toBe(1)
    } finally {
      outbound.__setWebhookDnsResolverForTests(null)
    }
  })

  it('A-04 faka-style system deliver uses faka copy and never notifies merchant on success', async () => {
    const { user: merchantUser, merchant } = await createTestMerchant('int-faka-m@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
    })
    const { user: buyer } = await createTestUser('int-faka-b@test.local', 'pass123', 'user', 5000)
    const product = await createTestProduct('Faka风格人工', 180, 0, [], merchant.id)
    await makeManualService(product.id)
    const buyerLogin = await loginAs('int-faka-b@test.local', 'pass123')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyerLogin.accessToken))
      .send({ productId: product.id })
      .expect(201)
    const orderId = created.body.orderId as number

    // Manual pending would notify merchant once; clear so success path is isolated.
    await prisma.notification.deleteMany({ where: { relatedOrderId: orderId } })

    await transitionOrderStatus({
      orderId,
      toStatus: 'processing',
      actorRole: 'system',
      action: 'system.faka_bridge.start',
    })
    await transitionOrderStatus({
      orderId,
      toStatus: 'delivered',
      actorRole: 'system',
      action: 'system.faka_bridge.deliver',
      deliveryContent: 'FAKA-PANEL-SECRET',
    })

    const buyerNotes = await prisma.notification.findMany({
      where: { recipientUserId: buyer.id, relatedOrderId: orderId, eventType: 'order.delivered_buyer' },
    })
    expect(buyerNotes).toHaveLength(1)
    expect(buyerNotes[0]!.title).toBe('订阅已开通')
    expect(JSON.stringify(buyerNotes[0]!.payload)).not.toContain('FAKA-PANEL-SECRET')

    expect(await prisma.notification.count({
      where: { recipientUserId: merchantUser.id, relatedOrderId: orderId },
    })).toBe(0)
  })

  it('A-05: repeated transition does not duplicate delivered notification', async () => {
    const { merchant } = await createTestMerchant('int-m7@test.local', 'pass123', {
      role: 'merchant',
      status: 'active',
    })
    const { user: buyer } = await createTestUser('int-b7@test.local', 'pass123', 'user', 5000)
    const product = await createTestProduct('幂等交付', 150, 0, [], merchant.id)
    await makeManualService(product.id)
    const buyerLogin = await loginAs('int-b7@test.local', 'pass123')
    const created = await api
      .post('/api/orders')
      .set(authHeader(buyerLogin.accessToken))
      .send({ productId: product.id })
      .expect(201)

    await transitionOrderStatus({
      orderId: created.body.orderId,
      toStatus: 'processing',
      actorRole: 'merchant',
    })
    await transitionOrderStatus({
      orderId: created.body.orderId,
      toStatus: 'delivered',
      actorRole: 'merchant',
      deliveryContent: 'once',
    })
    // illegal re-deliver would throw; emit same event via dispatcher twice is covered elsewhere
    // re-emit delivered via direct dispatcher after transition
    const { NotificationDispatcher, orderNotificationSnapshot } = await import('../dispatcher.js')
    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.body.orderId } })
    await prisma.$transaction(async (tx) => {
      await NotificationDispatcher.emit({
        type: 'order.delivered_buyer',
        recipientUserId: buyer.id,
        recipientRole: 'user',
        order: orderNotificationSnapshot(order),
      }, tx)
    })

    expect(await prisma.notification.count({
      where: {
        recipientUserId: buyer.id,
        eventType: 'order.delivered_buyer',
        relatedOrderId: created.body.orderId,
      },
    })).toBe(1)
  })
})
