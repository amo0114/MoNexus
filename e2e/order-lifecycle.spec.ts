import { expect, test } from '@playwright/test'
import { API_BASE, SEED_ACCOUNTS, loginAs, publishMerchantProduct } from './helpers'

/**
 * M3 order lifecycle closure smoke.
 * Creates fixtures via API; exercises merchant reject control through the UI.
 */
test.describe('manual_service order lifecycle', () => {
  test('merchant can reject pending order from UI', async ({ page, request }, testInfo) => {
    await loginAs(page, SEED_ACCOUNTS.merchant)

    const merchantLogin = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: SEED_ACCOUNTS.merchant.email, password: SEED_ACCOUNTS.merchant.password },
    })
    expect(merchantLogin.ok(), await merchantLogin.text()).toBeTruthy()
    const merchantToken = (await merchantLogin.json()).accessToken as string

    const userLogin = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: SEED_ACCOUNTS.user.email, password: SEED_ACCOUNTS.user.password },
    })
    expect(userLogin.ok(), await userLogin.text()).toBeTruthy()
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
      },
    })
    expect(createProduct.ok(), await createProduct.text()).toBeTruthy()
    const product = await createProduct.json()
    expect(product.id).toBeTruthy()
    expect(product.deliveryMode).toBe('manual_service')
    await publishMerchantProduct(request, merchantToken, product.id)

    const orderRes = await request.post(`${API_BASE}/api/orders`, {
      headers: { Authorization: `Bearer ${userToken}` },
      data: { productId: product.id },
    })
    expect(orderRes.ok(), await orderRes.text()).toBeTruthy()
    const orderBody = await orderRes.json()
    const orderId = orderBody.orderId as number
    expect(orderId).toBeTruthy()

    // Sanity: order is pending before UI reject
    const before = await request.get(`${API_BASE}/api/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${userToken}` },
    })
    expect(before.ok()).toBeTruthy()
    expect((await before.json()).status).toBe('pending')

    await page.goto('/merchant')
    await page.getByRole('button', { name: '订单管理' }).click()
    await expect(page.getByTestId('merchant-order-todo')).toBeVisible({ timeout: 15_000 })

    // Prefer the row for this product in case of pagination noise
    const orderRow = page.locator('tbody tr').filter({ hasText: productName }).first()
    await expect(orderRow).toBeVisible({ timeout: 15_000 })

    const rejectBtn = orderRow.getByTestId(`merchant-reject-order-${orderId}`)
    await expect(rejectBtn).toBeVisible({ timeout: 15_000 })
    await rejectBtn.click()
    await expect(page.getByTestId('merchant-reject-dialog')).toBeVisible()
    await page.getByTestId('merchant-reject-note').fill('E2E 拒单')

    // Register waiter BEFORE click to avoid missing the response on slow CI.
    const rejectWait = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/merchant/orders/${orderId}/fulfillment/reject`) &&
        res.request().method() === 'POST',
      { timeout: 20_000 },
    )
    await page.getByTestId('merchant-reject-confirm').click()
    const rejectRes = await rejectWait
    const rejectText = await rejectRes.text()
    expect(rejectRes.status(), `reject body: ${rejectText.slice(0, 500)}`).toBe(200)

    if ((page.viewportSize()?.width ?? 1280) < 768) {
      const notice = page.getByTestId('action-island-notice')
      await expect(notice).toContainText('已拒单，冻结积分已退还')
      await expect(notice).toContainText('避免重复补充')
      await notice.screenshot({ path: testInfo.outputPath('reject-island.png') })
      await notice.getByRole('button', { name: '查看订单', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/merchant/orders/${orderId}$`))
      await expect(page.getByTestId('merchant-focused-order')).toContainText(`#${orderId}`)
    } else await expect(page.getByText(/已拒单|操作成功/).first()).toBeVisible({ timeout: 10_000 })

    // Poll until backend reflects refunded (covers eventual consistency / cache-free path).
    await expect
      .poll(
        async () => {
          const detail = await request.get(`${API_BASE}/api/orders/${orderId}`, {
            headers: { Authorization: `Bearer ${userToken}` },
          })
          if (!detail.ok()) return `http-${detail.status()}`
          const body = await detail.json()
          return body.status as string
        },
        { timeout: 15_000, intervals: [200, 500, 1000] },
      )
      .toBe('refunded')
  })

  // Critical settlement journey: dispute resume → redelivery → dispute close.
  test('merchant resumes and then closes a manual service dispute through the order entry', async ({ page, request }, testInfo) => {
    const login = async (account: { email: string; password: string }) => {
      const response = await request.post(`${API_BASE}/api/auth/login`, { data: account })
      expect(response.ok(), await response.text()).toBeTruthy()
      return (await response.json()).accessToken as string
    }
    const merchantToken = await login(SEED_ACCOUNTS.merchant)
    const buyerToken = await login(SEED_ACCOUNTS.user)
    const merchantHeaders = { Authorization: `Bearer ${merchantToken}` }
    const buyerHeaders = { Authorization: `Bearer ${buyerToken}` }
    const product = await request.post(`${API_BASE}/api/merchant/products`, {
      headers: merchantHeaders,
      data: { name: `E2E争议处理-${Date.now()}`, type: '网络节点', price: 3, deliveryMode: 'manual_service', stockMode: 'unlimited' },
    })
    expect(product.ok(), await product.text()).toBeTruthy()
    const productId = (await product.json()).id
    await publishMerchantProduct(request, merchantToken, productId)
    const created = await request.post(`${API_BASE}/api/orders`, {
      headers: { ...buyerHeaders, 'Idempotency-Key': crypto.randomUUID() }, data: { productId },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const orderId = (await created.json()).orderId as number
    const merchantOrderUrl = `${API_BASE}/api/merchant/orders/${orderId}`
    const start = await request.post(`${merchantOrderUrl}/fulfillment/start`, { headers: merchantHeaders })
    expect(start.ok(), await start.text()).toBeTruthy()
    await loginAs(page, SEED_ACCOUNTS.merchant)

    for (const resolution of ['resume', 'close'] as const) {
      const delivered = await request.post(`${merchantOrderUrl}/fulfillment/deliver`, {
        headers: merchantHeaders, data: { deliveryContent: 'private-dispute-delivery' },
      })
      expect(delivered.ok(), await delivered.text()).toBeTruthy()
      const disputed = await request.post(`${API_BASE}/api/orders/${orderId}/dispute`, { headers: buyerHeaders })
      expect(disputed.ok(), await disputed.text()).toBeTruthy()
      await page.goto(`/merchant/orders/${orderId}`)
      await page.getByRole('button', { name: '处理争议', exact: true }).click()
      await page.getByTestId(`merchant-dispute-${resolution}`).click()
      if ((page.viewportSize()?.width ?? 1280) < 768) {
        const notice = page.getByTestId('action-island-notice')
        await expect(notice).toContainText(resolution === 'resume' ? '争议已解除，已恢复履约' : '争议已处理，订单已关闭')
        await expect(notice).not.toContainText('private-dispute-delivery')
        await notice.screenshot({ path: testInfo.outputPath(`dispute-${resolution}-island.png`) })
        await notice.getByRole('button', { name: '查看订单', exact: true }).click()
        await expect(page).toHaveURL(new RegExp(`/merchant/orders/${orderId}$`))
      } else await expect(page.getByText('争议处理成功').first()).toBeVisible()

      const detail = await request.get(merchantOrderUrl, { headers: merchantHeaders })
      expect(detail.ok(), await detail.text()).toBeTruthy()
      const result = await detail.json()
      expect(result.status).toBe(resolution === 'resume' ? 'processing' : 'closed')
      if (resolution === 'close') {
        expect(result.holdingPoints).toBeNull()
        expect(result.settlement.status).toBe('pending')
      }
    }
  })
})
