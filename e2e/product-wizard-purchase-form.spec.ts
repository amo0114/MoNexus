import { expect, test } from '@playwright/test'
import { API_BASE, SEED_ACCOUNTS, loginAs, publishMerchantProduct } from './helpers'

const PRODUCT_NAME = `E2E人工服务表单-${Date.now()}`

/**
 * P2 全链路（spec: docs/specs/product-model-and-checkout.md）：
 * 1. 商家用「人工服务」模板走分步创建页，模板预填购买前表单（联系方式必填）
 * 2. 买家兑换时必须填写表单才能确认支付；答案随订单提交
 * 3. 商家接单后在发货对话框看到买家填写的信息（履约依据）
 */
test.describe.serial('M-P2 product wizard + purchase form', () => {
  let productId = 0
  let orderId = 0

  test('merchant creates a manual_service product via wizard with template form', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.merchant)

    await page.goto('/merchant/products/new')
    await expect(page.getByTestId('product-create-wizard')).toBeVisible({ timeout: 10_000 })

    // 未选模板时不能进入下一步
    await expect(page.getByTestId('wizard-next')).toBeDisabled()
    await page.getByTestId('template-manual_service').click()
    await page.getByTestId('wizard-next').click()

    await page.getByTestId('wizard-name').fill(PRODUCT_NAME)
    await page.getByTestId('product-image-url-input').fill('/assets/network.webp')
    await page.getByTestId('product-image-url-hotlink').click()
    const category = page.getByTestId('product-category-select')
    if (!(await category.inputValue())) {
      await category.selectOption({ index: 1 })
    }
    await page.getByTestId('wizard-next').click()

    await page.getByTestId('wizard-price').fill('2')
    await page.getByTestId('wizard-next').click()

    // 模板预设 manual_service，名额默认不限
    await expect(page.getByRole('radio', { name: '人工服务履约' })).toBeChecked()
    await page.getByTestId('wizard-next').click()

    await page.getByTestId('wizard-save-draft').click()
    await expect(page.getByTestId('wizard-step-availability')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('wizard-next').click()
    await expect(page.getByTestId('publication-ready')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('publication-publish').click()
    await expect(page).toHaveURL(/\/merchant(?:\/|$)/, { timeout: 10_000 })

    // 购买前表单属于草稿保存后的编辑契约；通过真实编辑弹窗配置，
    // 再由后续买家/商家步骤验证其订单快照。
    await page.getByRole('button', { name: '商品管理' }).click()
    await page.getByTestId('merchant-product-search').fill(PRODUCT_NAME)
    const row = page.locator('tbody tr').filter({ hasText: PRODUCT_NAME }).first()
    await expect(row).toBeVisible({ timeout: 10_000 })
    await row.getByRole('button', { name: '编辑' }).click()
    const section = page.getByTestId('edit-purchase-form-section')
    await expect(section).toBeVisible({ timeout: 10_000 })
    await section.getByTestId('add-form-field').click()
    await section.getByTestId('add-form-field').click()
    const fields = section.getByTestId('form-field-list')
    await fields.getByTestId('form-field-label-0').fill('联系方式')
    await fields.getByTestId('form-field-label-1').fill('需求说明')
    await fields.locator('input[type=checkbox]').nth(0).check()
    await fields.locator('input[type=checkbox]').nth(1).check()
    await page.getByRole('button', { name: '确认保存' }).click()
    await expect(section).toBeHidden({ timeout: 10_000 })
  })

  test('buyer must fill the required field before confirming', async ({ page, request }) => {
    await loginAs(page, SEED_ACCOUNTS.user)

    await page.getByPlaceholder('搜账号、卡密、教程...').fill(PRODUCT_NAME)
    const card = page.getByText(PRODUCT_NAME)
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.click()
    await expect(page).toHaveURL(/\/product\/\d+/, { timeout: 10_000 })
    productId = Number(page.url().match(/\/product\/(\d+)/)![1])

    await page.getByRole('button', { name: '立即兑换' }).click()
    const modal = page.getByTestId('purchase-modal')
    await expect(modal.getByTestId('purchase-form-fields')).toBeVisible({ timeout: 10_000 })

    // 必填未填 → 确认按钮禁用
    await expect(modal.getByRole('button', { name: '确认支付' })).toBeDisabled()
    const answerInputs = modal.getByTestId('purchase-form-fields').locator('input[type="text"]')
    await answerInputs.nth(0).fill('tg:@e2e-buyer')
    await answerInputs.nth(1).fill('尽快开通')
    await expect(modal.getByRole('button', { name: '确认支付' })).toBeEnabled()

    await modal.getByRole('button', { name: '确认支付' }).click()
    // 成功反馈契约 = SuccessModal（V4 起不再叠加 toast）
    await expect(page.getByRole('heading', { name: /兑换成功|下单成功/ })).toBeVisible({ timeout: 10_000 })

    // 记录订单号，供商家侧断言
    const userLogin = await request.post(`${API_BASE}/api/auth/login`, {
      data: SEED_ACCOUNTS.user,
    })
    const userToken = (await userLogin.json()).accessToken as string
    const orders = await request.get(`${API_BASE}/api/orders?pageSize=5`, {
      headers: { Authorization: `Bearer ${userToken}` },
    })
    const found = ((await orders.json()) as Array<{ id: number; product: { id: number } }>)
      .find(o => o.product.id === productId)
    expect(found).toBeTruthy()
    orderId = found!.id
  })

  test('merchant sees buyer answers in the deliver dialog', async ({ page, request }) => {
    // 接单（pending → processing）走 API，UI 专注验证发货对话框中的答案展示
    const merchantLogin = await request.post(`${API_BASE}/api/auth/login`, {
      data: SEED_ACCOUNTS.merchant,
    })
    const merchantToken = (await merchantLogin.json()).accessToken as string
    const start = await request.post(`${API_BASE}/api/merchant/orders/${orderId}/fulfillment/start`, {
      headers: { Authorization: `Bearer ${merchantToken}` },
      data: {},
    })
    expect(start.ok(), await start.text()).toBeTruthy()

    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant')
    await page.getByRole('button', { name: '订单管理' }).click()
    const orderRow = page.locator('tbody tr').filter({ hasText: PRODUCT_NAME }).first()
    await expect(orderRow).toBeVisible({ timeout: 15_000 })
    await orderRow.getByRole('button', { name: '发货' }).click()

    const answersBox = page.getByTestId('merchant-buyer-answers')
    await expect(answersBox).toBeVisible({ timeout: 10_000 })
    await expect(answersBox).toContainText('联系方式')
    await expect(answersBox).toContainText('tg:@e2e-buyer')
    await expect(answersBox).toContainText('尽快开通')
  })
})

test.describe('M-P2.1 edit modal purchase form', () => {
  test('merchant adds a required field to an existing product via the edit modal', async ({ page, request }) => {
    const name = `E2E编辑表单-${Date.now()}`
    const login = await request.post(`${API_BASE}/api/auth/login`, { data: SEED_ACCOUNTS.merchant })
    const token = (await login.json()).accessToken as string
    const created = await request.post(`${API_BASE}/api/merchant/products`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name, type: '共享账号', price: 2, deliveryMode: 'manual_service', stockMode: 'unlimited' },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const productId = ((await created.json()) as { id: number }).id

    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant')
    await page.getByRole('button', { name: '商品管理' }).click()
    const row = page.locator('tbody tr').filter({ hasText: name }).first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.getByRole('button', { name: '编辑' }).click()

    // 编辑弹窗现在带购买前表单配置区
    const section = page.getByTestId('edit-purchase-form-section')
    await expect(section).toBeVisible({ timeout: 10_000 })
    await section.getByTestId('add-form-field').click()
    await section.getByTestId('form-field-label-0').fill('联系方式')
    await section.getByTestId('form-field-list').locator('input[type=checkbox]').first().check()
    await page.getByRole('button', { name: '确认保存' }).click()
    await expect(page.getByTestId('edit-purchase-form-section')).toBeHidden({ timeout: 10_000 })
    await publishMerchantProduct(request, token, productId)

    // 公开商品详情返回更新后的定义
    const detail = await request.get(`${API_BASE}/api/products/${productId}`)
    const body = (await detail.json()) as { purchaseForm: Array<{ label: string; required: boolean }> }
    expect(body.purchaseForm).toHaveLength(1)
    expect(body.purchaseForm[0]).toMatchObject({ label: '联系方式', required: true })
  })
})

test.describe('M-P2 wizard mobile smoke', () => {
  test.use({ viewport: { width: 320, height: 660 }, hasTouch: true })

  test('wizard is navigable at 320px', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant/products/new')
    await expect(page.getByTestId('product-create-wizard')).toBeVisible({ timeout: 10_000 })

    // 模板卡片可点、步骤条不阻塞视口、下一步/上一步可达
    await page.getByTestId('template-card_key').tap()
    await page.getByTestId('wizard-next').tap()
    await expect(page.getByTestId('wizard-name')).toBeVisible()
    await page.getByTestId('wizard-name').fill('移动端冒烟商品')
    await page.getByTestId('wizard-next').tap()
    await expect(page.getByTestId('wizard-price')).toBeVisible()
    await page.getByRole('button', { name: '上一步' }).tap()
    await expect(page.getByTestId('wizard-name')).toHaveValue('移动端冒烟商品')
  })
})
