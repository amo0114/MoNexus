import { expect, test, type APIRequestContext } from '@playwright/test'
import { API_BASE, SEED_ACCOUNTS, loginAs, publishMerchantProduct } from './helpers'

/**
 * P6b 进度与验收冒烟：人工服务下单 → 商家接单并 UI 发进度更新 →
 * 买家详情「履约动态」可见 → 商家交付带验收说明 → 买家侧按钮变
 * 「验收通过 / 验收异议」且验收通过关单。
 */

const STAMP = Date.now()
const PRODUCT_NAME = `E2E进度-${STAMP}`
const PROGRESS_NOTE = `已完成 50%：环境已部署-${STAMP}`
const ACCEPT_NOTE = `交付完成，请查收-${STAMP}`

const state = { productId: 0, orderId: 0 }

async function tokenOf(request: APIRequestContext, account: { email: string; password: string }) {
  const login = await request.post(`${API_BASE}/api/auth/login`, { data: account })
  expect(login.ok(), await login.text()).toBeTruthy()
  return (await login.json()).accessToken as string
}

test.describe.serial('P6b progress & acceptance', () => {
  test('setup: manual product, buyer order, merchant starts fulfillment', async ({ request }) => {
    const merchantToken = await tokenOf(request, SEED_ACCOUNTS.merchant)
    const created = await request.post(`${API_BASE}/api/merchant/products`, {
      headers: { Authorization: `Bearer ${merchantToken}` },
      data: { name: PRODUCT_NAME, type: '网络节点', price: 3, deliveryMode: 'manual_service', stockMode: 'unlimited' },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    state.productId = (await created.json()).id
    await publishMerchantProduct(request, merchantToken, state.productId)

    const buyerToken = await tokenOf(request, SEED_ACCOUNTS.user)
    const order = await request.post(`${API_BASE}/api/orders`, {
      headers: { Authorization: `Bearer ${buyerToken}`, 'Idempotency-Key': crypto.randomUUID() },
      data: { productId: state.productId },
    })
    expect(order.ok(), await order.text()).toBeTruthy()
    state.orderId = (await order.json()).orderId

    const start = await request.post(`${API_BASE}/api/merchant/orders/${state.orderId}/fulfillment/start`, {
      headers: { Authorization: `Bearer ${merchantToken}` },
    })
    expect(start.ok(), await start.text()).toBeTruthy()
  })

  test('merchant posts a progress update via UI', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant')
    await page.getByRole('button', { name: '订单管理' }).click()

    await page.getByTestId(`merchant-post-progress-${state.orderId}`).click()
    await page.getByTestId('merchant-progress-note').fill(PROGRESS_NOTE)
    await page.getByTestId('merchant-progress-submit').click()
    await expect(page.getByText('进度已更新').first()).toBeVisible({ timeout: 10_000 })
  })

  test('buyer sees the progress timeline; acceptance closes the order', async ({ page, request }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto('/orders')
    const orderCard = page
      .locator('[data-testid^="buyer-order-card-"]')
      .filter({ hasText: PRODUCT_NAME })
      .first()
    await orderCard.getByRole('button', { name: '查看订单详情' }).click()
    const timeline = page.getByTestId('order-progress-timeline')
    await expect(timeline).toBeVisible({ timeout: 10_000 })
    await expect(timeline).toContainText(PROGRESS_NOTE)

    // 商家交付（API）带验收说明。
    const merchantToken = await tokenOf(request, SEED_ACCOUNTS.merchant)
    const deliver = await request.post(`${API_BASE}/api/merchant/orders/${state.orderId}/fulfillment/deliver`, {
      headers: { Authorization: `Bearer ${merchantToken}` },
      data: { deliveryContent: `服务成果内容-${STAMP}`, publicNote: ACCEPT_NOTE },
    })
    expect(deliver.ok(), await deliver.text()).toBeTruthy()

    // 买家侧：验收措辞 + 验收通过关单。
    await page.reload()
    const cardAfter = page
      .locator('[data-testid^="buyer-order-card-"]')
      .filter({ hasText: PRODUCT_NAME })
      .first()
    await cardAfter.getByRole('button', { name: '查看订单详情' }).click()
    await expect(page.getByText(ACCEPT_NOTE).first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: '验收异议' })).toBeVisible()
    await page.getByRole('button', { name: '验收通过' }).click()
    await page.getByRole('button', { name: '确认验收通过' }).click()

    // 订单进入 closed。
    const buyerToken = await tokenOf(request, SEED_ACCOUNTS.user)
    await expect
      .poll(async () => {
        const detail = await request.get(`${API_BASE}/api/orders/${state.orderId}`, {
          headers: { Authorization: `Bearer ${buyerToken}` },
        })
        return ((await detail.json()) as { status: string }).status
      }, { timeout: 10_000 })
      .toBe('closed')
  })
})
