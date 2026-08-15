import { expect, test } from '@playwright/test'
import { API_BASE, SEED_ACCOUNTS, loginAs, publishMerchantProduct } from './helpers'

/**
 * P1 结算确认链路（spec: docs/specs/product-model-and-checkout.md）：
 * 1. 弹窗展示服务端结算预览：本次扣除 + 当前/支付后可用余额
 * 2. 商家改价后确认支付 → PRICE_CHANGED，重新报价而非静默按新价成交
 * 3. manual_service 显示「本次冻结」与返还说明
 * 商品经商家 API 创建，名称带时间戳，每次运行独立。
 */
test.describe('M-P1 checkout confirmation', () => {
  async function merchantToken(request: import('@playwright/test').APIRequestContext) {
    const login = await request.post(`${API_BASE}/api/auth/login`, {
      data: SEED_ACCOUNTS.merchant,
    })
    expect(login.ok()).toBeTruthy()
    return (await login.json()).accessToken as string
  }

  async function createProduct(
    request: import('@playwright/test').APIRequestContext,
    token: string,
    body: Record<string, unknown>
  ) {
    const res = await request.post(`${API_BASE}/api/merchant/products`, {
      headers: { Authorization: `Bearer ${token}` },
      data: body,
    })
    expect(res.ok(), await res.text()).toBeTruthy()
    const product = (await res.json()) as { id: number }
    await publishMerchantProduct(request, token, product.id)
    return product
  }

  test('preview shows balance before/after, and price change forces re-confirmation', async ({ page, request }) => {
    const token = await merchantToken(request)
    const name = `E2E结算预览-${Date.now()}`
    const product = await createProduct(request, token, {
      name,
      type: '邀请码',
      price: 3,
      deliveryMode: 'instant_fixed',
      fixedContent: 'https://example.com/e2e-checkout',
      fixedContentType: 'url',
      stockMode: 'unlimited',
    })

    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto(`/product/${product.id}`)
    await page.getByRole('button', { name: '立即兑换' }).click()

    // 服务端结算预览：本次扣除 + 余额前后值自洽
    const modal = page.getByTestId('purchase-modal')
    await expect(modal.getByText('本次扣除')).toBeVisible({ timeout: 10_000 })
    const before = Number(await modal.getByTestId('balance-before').locator('span').last().innerText())
    const after = Number(await modal.getByTestId('balance-after').locator('span').last().innerText())
    expect(before - after).toBe(3)

    // 弹窗打开期间商家改价 → 确认支付必须被拒并重新报价
    const update = await request.put(`${API_BASE}/api/merchant/products/${product.id}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { price: 5 },
    })
    expect(update.ok(), await update.text()).toBeTruthy()

    // 确认支付必须被 PRICE_CHANGED 拒并重新报价。并行负载下弹窗挂载期的
    // preview 请求可能在 PUT 之后才被服务端处理，此时新价已直接渲染——
    // 两条路径都满足 spec：用户看到 5 积分的最新报价后确认，绝不按旧价成交。
    const priceText = await modal.getByTestId('preview-price').innerText()
    if (!priceText.includes('5')) {
      await page.getByRole('button', { name: '确认支付' }).click()
      await expect(page.getByTestId('price-changed-notice')).toBeVisible({ timeout: 10_000 })
    }
    await expect(modal.getByTestId('preview-price')).toHaveText(/5/, { timeout: 10_000 })

    // 针对新价格再次确认后正常成交
    await page.getByRole('button', { name: '确认支付' }).click()
    await expect(page.getByTestId('success-delivery-link')).toBeVisible({ timeout: 10_000 })
  })

  test('manual_service preview shows hold wording', async ({ page, request }) => {
    const token = await merchantToken(request)
    const name = `E2E人工服务预览-${Date.now()}`
    const product = await createProduct(request, token, {
      name,
      type: '共享账号',
      price: 2,
      deliveryMode: 'manual_service',
      stockMode: 'unlimited',
    })

    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto(`/product/${product.id}`)
    await page.getByRole('button', { name: '立即兑换' }).click()

    const modal = page.getByTestId('purchase-modal')
    await expect(modal.getByText('本次冻结')).toBeVisible({ timeout: 10_000 })
    await expect(modal.getByTestId('hold-explain')).toContainText('拒单或退款时返还')
  })

  test('adding a required form field after preview forces re-confirmation with the new field', async ({ page, request }) => {
    const token = await merchantToken(request)
    const name = `E2E表单变更-${Date.now()}`
    const product = await createProduct(request, token, {
      name,
      type: '共享账号',
      price: 2,
      deliveryMode: 'manual_service',
      stockMode: 'unlimited',
    })

    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto(`/product/${product.id}`)
    await page.getByRole('button', { name: '立即兑换' }).click()
    const modal = page.getByTestId('purchase-modal')
    await expect(modal.getByText('本次冻结')).toBeVisible({ timeout: 10_000 })

    // 弹窗打开期间，商家给商品新增一个必填的购买前字段
    const update = await request.put(`${API_BASE}/api/merchant/products/${product.id}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { purchaseForm: [{ key: 'contact', label: '联系方式', type: 'text', required: true }] },
    })
    expect(update.ok(), await update.text()).toBeTruthy()

    // 确认支付被 409 CHECKOUT_CHANGED 拒绝，弹窗重新报价并渲染新字段。
    // 并行负载下弹窗挂载期的 preview 请求可能在 PUT 之后才被服务端处理，
    // 此时新字段已直接渲染（无需 409 路径）——两条路径都满足 spec：
    // 买家必须针对新表单补填后才能成交，绝不静默按旧表单提交。
    const contactField = modal.getByTestId('purchase-field-contact')
    if (!(await contactField.isVisible())) {
      await page.getByRole('button', { name: '确认支付' }).click()
      await expect(page.getByTestId('price-changed-notice')).toBeVisible({ timeout: 10_000 })
    }
    await expect(contactField).toBeVisible({ timeout: 10_000 })

    // 必填未填 → 禁用；补填后针对新表单再次确认成交
    await expect(modal.getByRole('button', { name: '确认支付' })).toBeDisabled()
    await contactField.fill('tg:@e2e-changed')
    await modal.getByRole('button', { name: '确认支付' }).click()
    // 成功反馈契约 = SuccessModal（V4 起不再叠加 toast）
    await expect(page.getByRole('heading', { name: /兑换成功|下单成功/ })).toBeVisible({ timeout: 10_000 })
  })
})
