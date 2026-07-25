import { expect, test } from '@playwright/test'
import { API_BASE, SEED_ACCOUNTS, loginAs } from './helpers'

/**
 * P3 高风险二次验证（spec: docs/specs/product-model-and-checkout.md）：
 * 单笔金额 ≥ 阈值时弹窗要求输入登录密码；错密码被拒（弹窗保持、同幂等键），
 * 正确密码成交；低于阈值的商品无密码框。
 * 阈值设 500——其余 e2e 用例商品价格均 ≤5，互不影响。
 */
test.describe.serial('M-P3 checkout verification', () => {
  const THRESHOLD = 500

  async function adminSetThreshold(request: import('@playwright/test').APIRequestContext, value: number) {
    const login = await request.post(`${API_BASE}/api/auth/login`, { data: SEED_ACCOUNTS.admin })
    expect(login.ok()).toBeTruthy()
    const token = (await login.json()).accessToken as string
    const res = await request.put(`${API_BASE}/api/admin/config/checkoutVerifyAmountThreshold`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { value },
    })
    expect(res.ok(), await res.text()).toBeTruthy()
  }

  test.afterAll(async ({ request }) => {
    // 阈值是全局配置，测试结束必须复位，避免污染后续运行。
    await adminSetThreshold(request, 0)
  })

  test('high-value order requires the login password; wrong then right', async ({ page, request }) => {
    await adminSetThreshold(request, THRESHOLD)

    const merchantLogin = await request.post(`${API_BASE}/api/auth/login`, { data: SEED_ACCOUNTS.merchant })
    const merchantToken = (await merchantLogin.json()).accessToken as string
    const name = `E2E高额验证-${Date.now()}`
    const created = await request.post(`${API_BASE}/api/merchant/products`, {
      headers: { Authorization: `Bearer ${merchantToken}` },
      data: {
        name,
        type: '邀请码',
        price: 800,
        deliveryMode: 'instant_fixed',
        fixedContent: 'https://example.com/e2e-verify',
        fixedContentType: 'url',
        stockMode: 'unlimited',
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const productId = ((await created.json()) as { id: number }).id

    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto(`/product/${productId}`)
    await page.getByRole('button', { name: '立即兑换' }).click()

    const modal = page.getByTestId('purchase-modal')
    await expect(modal.getByTestId('purchase-verify-section')).toBeVisible({ timeout: 10_000 })

    // 密码未填 → 确认按钮禁用
    await expect(modal.getByRole('button', { name: '确认支付' })).toBeDisabled()

    // 错密码 → 被拒，弹窗保持打开并清空密码。
    // 回归（R3）：业务型 401 不得触发 Axios 自动续签重放——一次点击
    // 只发出一次 POST /api/orders，且不请求 /api/auth/refresh
    // （重放会把同一错误密码提交两次，防爆破计数翻倍）。
    let orderPosts = 0
    let refreshCalls = 0
    page.on('request', req => {
      if (req.method() === 'POST' && req.url().includes('/api/orders')) orderPosts += 1
      if (req.url().includes('/api/auth/refresh')) refreshCalls += 1
    })
    await modal.getByTestId('purchase-verify-password').fill('wrong-password')
    await modal.getByRole('button', { name: '确认支付' }).click()
    await expect(page.getByText('密码错误，请重新输入')).toBeVisible({ timeout: 10_000 })
    await expect(modal).toBeVisible()
    await expect(modal.getByTestId('purchase-verify-password')).toHaveValue('')
    expect(orderPosts).toBe(1)
    expect(refreshCalls).toBe(0)

    // 正确密码 → 成交
    await modal.getByTestId('purchase-verify-password').fill(SEED_ACCOUNTS.user.password)
    await modal.getByRole('button', { name: '确认支付' }).click()
    await expect(page.getByTestId('success-delivery-link')).toBeVisible({ timeout: 10_000 })
  })

  test('risk change after preview refreshes the dialog with the password field', async ({ page, request }) => {
    // 买家打开预览时不需要密码（阈值 1000 > 价格 800）；确认前管理员把
    // 阈值降到 500 → VERIFICATION_REQUIRED → 弹窗自动重新报价并出现密码框。
    await adminSetThreshold(request, 1000)

    const merchantLogin = await request.post(`${API_BASE}/api/auth/login`, { data: SEED_ACCOUNTS.merchant })
    const merchantToken = (await merchantLogin.json()).accessToken as string
    const name = `E2E风控变化-${Date.now()}`
    const created = await request.post(`${API_BASE}/api/merchant/products`, {
      headers: { Authorization: `Bearer ${merchantToken}` },
      data: {
        name,
        type: '邀请码',
        price: 800,
        deliveryMode: 'instant_fixed',
        fixedContent: 'https://example.com/e2e-risk-change',
        fixedContentType: 'url',
        stockMode: 'unlimited',
      },
    })
    const productId = ((await created.json()) as { id: number }).id

    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto(`/product/${productId}`)
    await page.getByRole('button', { name: '立即兑换' }).click()

    const modal = page.getByTestId('purchase-modal')
    await expect(modal.getByText('本次扣除')).toBeVisible({ timeout: 10_000 })
    await expect(modal.getByTestId('purchase-verify-section')).toHaveCount(0)

    // 弹窗打开期间管理员下调阈值，本单跨入验证范围
    await adminSetThreshold(request, THRESHOLD)

    await modal.getByRole('button', { name: '确认支付' }).click()
    // 弹窗自动重新报价并渲染密码框（不需要用户关闭重开）
    await expect(modal.getByTestId('purchase-verify-section')).toBeVisible({ timeout: 10_000 })
    await modal.getByTestId('purchase-verify-password').fill(SEED_ACCOUNTS.user.password)
    await modal.getByRole('button', { name: '确认支付' }).click()
    await expect(page.getByTestId('success-delivery-link')).toBeVisible({ timeout: 10_000 })
  })

  test('low-value order shows no password field', async ({ page, request }) => {
    const merchantLogin = await request.post(`${API_BASE}/api/auth/login`, { data: SEED_ACCOUNTS.merchant })
    const merchantToken = (await merchantLogin.json()).accessToken as string
    const name = `E2E低额免验证-${Date.now()}`
    const created = await request.post(`${API_BASE}/api/merchant/products`, {
      headers: { Authorization: `Bearer ${merchantToken}` },
      data: {
        name,
        type: '邀请码',
        price: 3,
        deliveryMode: 'instant_fixed',
        fixedContent: 'https://example.com/e2e-noverify',
        fixedContentType: 'url',
        stockMode: 'unlimited',
      },
    })
    const productId = ((await created.json()) as { id: number }).id

    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto(`/product/${productId}`)
    await page.getByRole('button', { name: '立即兑换' }).click()

    const modal = page.getByTestId('purchase-modal')
    await expect(modal.getByText('本次扣除')).toBeVisible({ timeout: 10_000 })
    await expect(modal.getByTestId('purchase-verify-section')).toHaveCount(0)
    await modal.getByRole('button', { name: '确认支付' }).click()
    await expect(page.getByTestId('success-delivery-link')).toBeVisible({ timeout: 10_000 })
  })
})
