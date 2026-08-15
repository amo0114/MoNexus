import { expect, test } from '@playwright/test'
import { API_BASE, SEED_ACCOUNTS, loginAs, loginAsApi, publishMerchantProduct } from './helpers'

/**
 * SPEC-NOTIFY-001 Phase 1 E2E.
 * Requires server with NOTIFICATION_ENABLED=true (otherwise API returns 404).
 */

async function ensureNotificationsEnabled(request: import('@playwright/test').APIRequestContext, token: string) {
  const res = await request.get(`${API_BASE}/api/notifications/unread-count`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status() === 404) {
    test.skip(true, 'NOTIFICATION_ENABLED=false — skip notification E2E in this environment')
  }
  expect(res.ok(), await res.text()).toBeTruthy()
}

test.describe('Order notification system Phase 1', () => {
  test('A-01: manual order increases merchant unread count', async ({ request }) => {
    const merchant = await loginAsApi(request, SEED_ACCOUNTS.merchant)
    const buyer = await loginAsApi(request, SEED_ACCOUNTS.user)
    await ensureNotificationsEnabled(request, merchant.accessToken)

    const before = await request.get(`${API_BASE}/api/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${merchant.accessToken}` },
    })
    const beforeCount = (await before.json()).count as number

    const productName = `E2E通知人工-${Date.now()}`
    const createProduct = await request.post(`${API_BASE}/api/merchant/products`, {
      headers: { Authorization: `Bearer ${merchant.accessToken}` },
      data: {
        name: productName,
        type: '网络节点',
        price: 40,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
      },
    })
    expect(createProduct.ok(), await createProduct.text()).toBeTruthy()
    const product = await createProduct.json()
    await publishMerchantProduct(request, merchant.accessToken, product.id)

    const orderRes = await request.post(`${API_BASE}/api/orders`, {
      headers: { Authorization: `Bearer ${buyer.accessToken}` },
      data: { productId: product.id },
    })
    expect(orderRes.ok(), await orderRes.text()).toBeTruthy()
    const orderId = (await orderRes.json()).orderId as number

    await expect
      .poll(
        async () => {
          const r = await request.get(`${API_BASE}/api/notifications/unread-count`, {
            headers: { Authorization: `Bearer ${merchant.accessToken}` },
          })
          if (!r.ok()) return -1
          return (await r.json()).count as number
        },
        { timeout: 10_000, intervals: [200, 500, 1000] },
      )
      .toBeGreaterThanOrEqual(beforeCount + 1)

    const list = await request.get(`${API_BASE}/api/notifications?status=unread`, {
      headers: { Authorization: `Bearer ${merchant.accessToken}` },
    })
    expect(list.ok()).toBeTruthy()
    const body = await list.json()
    const match = (body.notifications as Array<{ relatedOrderId: number; eventType: string }>).find(
      (n) => n.relatedOrderId === orderId && n.eventType === 'order.created_merchant',
    )
    expect(match).toBeTruthy()
  })

  test('A-02: instant order does not notify merchant of new order', async ({ request }) => {
    const merchant = await loginAsApi(request, SEED_ACCOUNTS.merchant)
    const buyer = await loginAsApi(request, SEED_ACCOUNTS.user)
    await ensureNotificationsEnabled(request, merchant.accessToken)

    const productName = `E2E通知即时-${Date.now()}`
    const createProduct = await request.post(`${API_BASE}/api/merchant/products`, {
      headers: { Authorization: `Bearer ${merchant.accessToken}` },
      data: {
        name: productName,
        type: '网络节点',
        price: 30,
        deliveryMode: 'instant_fixed',
        fixedContent: 'E2E-FIXED-CODE',
        fixedContentType: 'text',
        stockMode: 'unlimited',
      },
    })
    expect(createProduct.ok(), await createProduct.text()).toBeTruthy()
    const product = await createProduct.json()
    await publishMerchantProduct(request, merchant.accessToken, product.id)

    const orderRes = await request.post(`${API_BASE}/api/orders`, {
      headers: { Authorization: `Bearer ${buyer.accessToken}` },
      data: { productId: product.id },
    })
    expect(orderRes.ok(), await orderRes.text()).toBeTruthy()
    const orderId = (await orderRes.json()).orderId as number

    const list = await request.get(`${API_BASE}/api/notifications?limit=50`, {
      headers: { Authorization: `Bearer ${merchant.accessToken}` },
    })
    expect(list.ok()).toBeTruthy()
    const notes = (await list.json()).notifications as Array<{ relatedOrderId: number; eventType: string }>
    expect(notes.some((n) => n.relatedOrderId === orderId && n.eventType === 'order.created_merchant')).toBe(false)

    // Buyer weak delivered record
    const buyerList = await request.get(`${API_BASE}/api/notifications?limit=50`, {
      headers: { Authorization: `Bearer ${buyer.accessToken}` },
    })
    expect(buyerList.ok()).toBeTruthy()
    const buyerNotes = (await buyerList.json()).notifications as Array<{
      relatedOrderId: number
      eventType: string
      body: string
      title: string
    }>
    const delivered = buyerNotes.find(
      (n) => n.relatedOrderId === orderId && n.eventType === 'order.delivered_buyer',
    )
    expect(delivered).toBeTruthy()
    expect(delivered!.body).not.toContain('E2E-FIXED-CODE')
    expect(delivered!.title).toBe('订单已交付')
  })

  test('A-03: merchant deliver → buyer notification with deeplink', async ({ request }) => {
    const merchant = await loginAsApi(request, SEED_ACCOUNTS.merchant)
    const buyer = await loginAsApi(request, SEED_ACCOUNTS.user)
    await ensureNotificationsEnabled(request, buyer.accessToken)

    const productName = `E2E通知发货-${Date.now()}`
    const createProduct = await request.post(`${API_BASE}/api/merchant/products`, {
      headers: { Authorization: `Bearer ${merchant.accessToken}` },
      data: {
        name: productName,
        type: '网络节点',
        price: 35,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
      },
    })
    expect(createProduct.ok(), await createProduct.text()).toBeTruthy()
    const product = await createProduct.json()
    await publishMerchantProduct(request, merchant.accessToken, product.id)

    const orderRes = await request.post(`${API_BASE}/api/orders`, {
      headers: { Authorization: `Bearer ${buyer.accessToken}` },
      data: { productId: product.id },
    })
    expect(orderRes.ok(), await orderRes.text()).toBeTruthy()
    const orderId = (await orderRes.json()).orderId as number

    await request
      .post(`${API_BASE}/api/merchant/orders/${orderId}/fulfillment/start`, {
        headers: { Authorization: `Bearer ${merchant.accessToken}` },
      })
      .then(async (r) => expect(r.ok(), await r.text()).toBeTruthy())

    const deliver = await request.post(`${API_BASE}/api/merchant/orders/${orderId}/fulfillment/deliver`, {
      headers: { Authorization: `Bearer ${merchant.accessToken}` },
      data: { deliveryContent: 'DELIVER-SECRET-SHOULD-NOT-LEAK' },
    })
    expect(deliver.ok(), await deliver.text()).toBeTruthy()

    const list = await request.get(`${API_BASE}/api/notifications?limit=50`, {
      headers: { Authorization: `Bearer ${buyer.accessToken}` },
    })
    const notes = (await list.json()).notifications as Array<{
      relatedOrderId: number
      eventType: string
      deeplink: string
      body: string
    }>
    const delivered = notes.find(
      (n) => n.relatedOrderId === orderId && n.eventType === 'order.delivered_buyer',
    )
    expect(delivered).toBeTruthy()
    expect(delivered!.deeplink).toBe(`/orders?focus=${orderId}`)
    expect(delivered!.body).not.toContain('DELIVER-SECRET')
  })

  test('A-12: single bell opens dual-tab center dialog', async ({ page, request }) => {
    const session = await loginAsApi(request, SEED_ACCOUNTS.user)
    await ensureNotificationsEnabled(request, session.accessToken)
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto('/')

    // Exactly one desktop + one mobile trigger (mutually exclusive by viewport; count exists in DOM once each)
    await expect(page.getByTestId('announcement-center-desktop-trigger')).toHaveCount(1)
    await expect(page.getByTestId('announcement-center-mobile-trigger')).toHaveCount(1)

    // Prefer desktop trigger if visible, else mobile
    const desktop = page.getByTestId('announcement-center-desktop-trigger')
    if (await desktop.isVisible()) {
      await desktop.click()
    } else {
      await page.getByTestId('announcement-center-mobile-trigger').click()
    }

    await expect(page.getByTestId('announcement-center')).toBeVisible()
    await expect(page.getByTestId('notification-center-tab-announcements')).toBeVisible()
    await expect(page.getByTestId('notification-center-tab-messages')).toBeVisible()

    await page.getByTestId('notification-center-tab-messages').click()
    await expect(page.getByTestId('notification-center-view-all')).toBeVisible()
    await page.getByTestId('notification-center-view-all').click()
    await expect(page).toHaveURL(/\/notifications/)
    await expect(page.getByTestId('notifications-page')).toBeVisible()
  })

  test('A-13: notification body is plain text (no HTML render)', async ({ page, request }) => {
    const buyer = await loginAsApi(request, SEED_ACCOUNTS.user)
    await ensureNotificationsEnabled(request, buyer.accessToken)

    // Seed a notification-like payload via order flow if possible; otherwise open messages page
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto('/notifications')
    await expect(page.getByTestId('notifications-page')).toBeVisible({ timeout: 10_000 })
    // Page should not inject raw HTML nodes from body; React text render has no img/script from body
    const scriptsInItems = await page.locator('[data-testid^="notification-item-"] script').count()
    expect(scriptsInItems).toBe(0)
  })

  test('A-07: cross-user mark-as-read is 404', async ({ request }) => {
    const a = await loginAsApi(request, SEED_ACCOUNTS.user)
    const b = await loginAsApi(request, SEED_ACCOUNTS.merchant)
    await ensureNotificationsEnabled(request, a.accessToken)

    const list = await request.get(`${API_BASE}/api/notifications?limit=1`, {
      headers: { Authorization: `Bearer ${b.accessToken}` },
    })
    if (!list.ok()) {
      test.skip(true, 'merchant has no notifications to attempt cross-user read')
    }
    const notes = (await list.json()).notifications as Array<{ id: number }>
    if (notes.length === 0) {
      test.skip(true, 'no merchant notifications available')
    }
    const cross = await request.post(`${API_BASE}/api/notifications/${notes[0]!.id}/read`, {
      headers: { Authorization: `Bearer ${a.accessToken}` },
    })
    expect(cross.status()).toBe(404)
  })
})
