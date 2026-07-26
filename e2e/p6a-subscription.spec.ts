import { expect, test, type APIRequestContext } from '@playwright/test'
import { API_BASE, SEED_ACCOUNTS, loginAs } from './helpers'

/**
 * P6a 订阅到期冒烟：购前「有效期 N 天」徽标 → UI 购买 → 订单详情有效期
 * 展示 → 「续费」全链路（预检 → 标准结算 → 顺延断言）。
 * 过期遮蔽/文件 403 无法在 e2e 快进时间，由 subscription-expiry vitest
 * 矩阵锁定。
 */

const STAMP = Date.now()
const PRODUCT_NAME = `E2E订阅-${STAMP}`
const OFFER_NAME = `月卡-${STAMP}`
const VALIDITY_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

const state = { productId: 0, offerId: 0, orderId: 0, expiresAt: '' }

async function tokenOf(request: APIRequestContext, account: { email: string; password: string }) {
  const login = await request.post(`${API_BASE}/api/auth/login`, { data: account })
  expect(login.ok(), await login.text()).toBeTruthy()
  return (await login.json()).accessToken as string
}

test.describe.serial('P6a subscription', () => {
  test('merchant publishes a 30-day subscription offer', async ({ request }) => {
    const token = await tokenOf(request, SEED_ACCOUNTS.merchant)
    const created = await request.post(`${API_BASE}/api/merchant/products`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: PRODUCT_NAME, type: '网络节点', price: 2, deliveryMode: 'manual_service', stockMode: 'unlimited' },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    state.productId = (await created.json()).id

    const offer = await request.post(`${API_BASE}/api/merchant/products/${state.productId}/offers`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: OFFER_NAME,
        price: 2,
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        fixedContentType: 'text',
        fixedContent: `NODE-${STAMP}`,
        validityDays: VALIDITY_DAYS,
      },
    })
    expect(offer.ok(), await offer.text()).toBeTruthy()
    state.offerId = (await offer.json()).id

    // 下架默认人工档 → 唯一 active 规格，买家免选规格。
    const offers = await request.get(`${API_BASE}/api/merchant/products/${state.productId}/offers`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const defaultOffer = ((await offers.json()) as { id: number; isDefault: boolean }[]).find(o => o.isDefault)!
    const deactivate = await request.put(
      `${API_BASE}/api/merchant/products/${state.productId}/offers/${defaultOffer.id}`,
      { headers: { Authorization: `Bearer ${token}` }, data: { status: 'inactive' } },
    )
    expect(deactivate.ok(), await deactivate.text()).toBeTruthy()
  })

  test('buyer sees the validity badge and purchases; detail shows the expiry line', async ({ page, request }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto(`/product/${state.productId}`)

    await expect(page.getByTestId('validity-days-preview')).toContainText(`有效期 ${VALIDITY_DAYS} 天`, { timeout: 10_000 })

    await page.getByRole('button', { name: '立即兑换' }).click()
    await expect(page.getByTestId('preview-validity-days')).toContainText(`有效期 ${VALIDITY_DAYS} 天`, { timeout: 10_000 })
    await page.getByRole('button', { name: '确认支付' }).click()
    await expect(page.getByText('兑换成功').first()).toBeVisible({ timeout: 10_000 })

    // API 拿到订单与到期时刻，供顺延断言。
    const buyerToken = await tokenOf(request, SEED_ACCOUNTS.user)
    const orders = await request.get(`${API_BASE}/api/orders`, {
      headers: { Authorization: `Bearer ${buyerToken}` },
    })
    const order = ((await orders.json()) as { id: number; product?: { id: number } }[])
      .find(o => o.product?.id === state.productId)!
    state.orderId = order.id
    const detail = await request.get(`${API_BASE}/api/orders/${state.orderId}`, {
      headers: { Authorization: `Bearer ${buyerToken}` },
    })
    const delivery = (await detail.json()).delivery as { expiresAt: string; expired: boolean }
    expect(delivery.expired).toBe(false)
    state.expiresAt = delivery.expiresAt

    // 订单详情：有效期行 + 续费按钮。
    await page.goto('/profile')
    const orderCard = page
      .locator('div.shadow-sm')
      .filter({ has: page.getByRole('heading', { name: PRODUCT_NAME }) })
      .first()
    await orderCard.getByRole('button', { name: '查看发货内容' }).click()
    await expect(page.getByText('订阅有效期至')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('order-renew-button')).toBeVisible()
  })

  test('renewal creates a linked order and extends expiry from the old deadline', async ({ page, request }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto('/profile')
    const orderCard = page
      .locator('div.shadow-sm')
      .filter({ has: page.getByRole('heading', { name: PRODUCT_NAME }) })
      .first()
    await orderCard.getByRole('button', { name: '查看发货内容' }).click()

    await page.getByTestId('order-renew-button').click()
    await expect(page.getByTestId('preview-validity-days')).toContainText(`有效期 ${VALIDITY_DAYS} 天`, { timeout: 10_000 })
    await page.getByRole('button', { name: '确认支付' }).click()
    await expect(page.getByText('续费成功').first()).toBeVisible({ timeout: 10_000 })

    // 顺延断言：新单 renewalOfOrderId 指向原单，expiresAt = 原到期 + 30 天。
    const buyerToken = await tokenOf(request, SEED_ACCOUNTS.user)
    const orders = await request.get(`${API_BASE}/api/orders`, {
      headers: { Authorization: `Bearer ${buyerToken}` },
    })
    const renewal = ((await orders.json()) as { id: number; product?: { id: number } }[])
      .filter(o => o.product?.id === state.productId)
      .sort((a, b) => b.id - a.id)[0]
    expect(renewal.id).not.toBe(state.orderId)

    const detail = await request.get(`${API_BASE}/api/orders/${renewal.id}`, {
      headers: { Authorization: `Bearer ${buyerToken}` },
    })
    const body = (await detail.json()) as { renewalOfOrderId: number; delivery: { expiresAt: string } }
    expect(body.renewalOfOrderId).toBe(state.orderId)
    expect(new Date(body.delivery.expiresAt).getTime()).toBe(
      new Date(state.expiresAt).getTime() + VALIDITY_DAYS * DAY_MS
    )
  })
})
