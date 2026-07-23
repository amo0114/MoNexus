import { expect, test } from '@playwright/test'
import { API_BASE, SEED_ACCOUNTS, loginAs } from './helpers'

/**
 * M3 order lifecycle closure smoke.
 * Prefers API for durable state transitions; uses UI for merchant reject control.
 */
test.describe('manual_service order lifecycle', () => {
  test('merchant can reject pending order from UI', async ({ page, request }) => {
    // Login as merchant via UI so session cookies are available for dashboard.
    await loginAs(page, SEED_ACCOUNTS.merchant)

    // Create a dedicated manual_service product + order via API as user.
    const merchantLogin = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: SEED_ACCOUNTS.merchant.email, password: SEED_ACCOUNTS.merchant.password },
    })
    expect(merchantLogin.ok()).toBeTruthy()
    const merchantBody = await merchantLogin.json()
    const merchantToken = merchantBody.accessToken as string

    const userLogin = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: SEED_ACCOUNTS.user.email, password: SEED_ACCOUNTS.user.password },
    })
    expect(userLogin.ok()).toBeTruthy()
    const userToken = (await userLogin.json()).accessToken as string

    const productName = `E2E拒单服务-${Date.now()}`
    const createProduct = await request.post(`${API_BASE}/api/merchant/products`, {
      headers: { Authorization: `Bearer ${merchantToken}` },
      data: {
        name: productName,
        type: '网络节点',
        price: 50,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
        status: 'active',
      },
    })
    expect(createProduct.ok(), await createProduct.text()).toBeTruthy()
    const product = await createProduct.json()

    const orderRes = await request.post(`${API_BASE}/api/orders`, {
      headers: { Authorization: `Bearer ${userToken}` },
      data: { productId: product.id },
    })
    expect(orderRes.ok(), await orderRes.text()).toBeTruthy()
    const orderId = (await orderRes.json()).orderId as number

    await page.goto('/merchant')
    // Orders tab
    await page.getByRole('button', { name: '订单管理' }).click()
    await expect(page.getByTestId('merchant-order-todo')).toBeVisible({ timeout: 15_000 })

    const rejectBtn = page.getByTestId(`merchant-reject-order-${orderId}`)
    await expect(rejectBtn).toBeVisible({ timeout: 15_000 })
    await rejectBtn.click()
    await expect(page.getByTestId('merchant-reject-dialog')).toBeVisible()
    await page.getByTestId('merchant-reject-note').fill('E2E 拒单')
    await page.getByTestId('merchant-reject-confirm').click()

    const detail = await request.get(`${API_BASE}/api/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${userToken}` },
    })
    expect(detail.ok()).toBeTruthy()
    const body = await detail.json()
    expect(body.status).toBe('refunded')
  })
})
