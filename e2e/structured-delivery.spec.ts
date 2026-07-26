import { expect, test, type APIRequestContext } from '@playwright/test'
import { API_BASE, SEED_ACCOUNTS, loginAs } from './helpers'

/**
 * P4b 结构化库存导入与结构化交付全链路：
 * 1. 商家为规格配置交付字段模板（账号/密码/地区，密码敏感）
 * 2. 按 | 分隔导入结构化卡密（走真实导入接口，含 canonical 文本落库）
 * 3. 详情页购前显示「购买后您将获得」字段预告
 * 4. 购买后成功弹窗字段化展示：逐字段复制、敏感字段默认遮蔽可切换
 * 5. 订单详情同样字段化展示
 * 商品经 API 创建（名称带时间戳），断言全在 UI 层。
 */

const PRODUCT_NAME = `E2E结构化交付-${Date.now()}`
const ACCOUNT = `sd-${Date.now()}@example.com`
const PASSWORD_VALUE = `pw-${Date.now()}`

const state = { productId: 0, offerId: 0 }

async function merchantToken(request: APIRequestContext) {
  const login = await request.post(`${API_BASE}/api/auth/login`, { data: SEED_ACCOUNTS.merchant })
  expect(login.ok(), await login.text()).toBeTruthy()
  return (await login.json()).accessToken as string
}

test.describe.serial('P4b structured delivery chain', () => {
  test('merchant provisions a templated offer and imports structured inventory', async ({ request }) => {
    const token = await merchantToken(request)
    const created = await request.post(`${API_BASE}/api/merchant/products`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: PRODUCT_NAME, type: '共享账号', price: 3, deliveryMode: 'instant_inventory' },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    state.productId = (await created.json()).id

    const offers = await request.get(`${API_BASE}/api/merchant/products/${state.productId}/offers`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    state.offerId = (await offers.json())[0].id as number

    // 配置模板：密码字段标记敏感
    const tpl = await request.put(`${API_BASE}/api/merchant/products/${state.productId}/offers/${state.offerId}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        deliveryFields: [
          { key: 'account', label: '账号', sensitive: false },
          { key: 'password', label: '密码', sensitive: true },
          { key: 'region', label: '地区', sensitive: false },
        ],
      },
    })
    expect(tpl.ok(), await tpl.text()).toBeTruthy()

    // 结构化导入一条（| 分隔按模板顺序映射）
    const imported = await request.post(`${API_BASE}/api/merchant/products/${state.productId}/inventory`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { offerId: state.offerId, items: [`${ACCOUNT} | ${PASSWORD_VALUE} | US`] },
    })
    expect(imported.ok(), await imported.text()).toBeTruthy()
    expect((await imported.json()).imported).toBe(1)
  })

  test('buyer sees the field preview, purchases, and gets field-ized delivery with masking', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto(`/product/${state.productId}`)

    // 购前字段预告（模板公开，值不可见）
    const preview = page.getByTestId('delivery-template-preview')
    await expect(preview).toBeVisible({ timeout: 10_000 })
    await expect(preview).toContainText('账号')
    await expect(preview).toContainText('密码')

    await page.getByRole('button', { name: '立即兑换' }).click()
    await expect(page.getByTestId('purchase-modal')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: '确认支付' }).click()

    // 成功弹窗字段化：账号明文可见，密码默认遮蔽
    const structured = page.getByTestId('structured-delivery')
    await expect(structured).toBeVisible({ timeout: 10_000 })
    await expect(structured.getByTestId('structured-field-account')).toContainText(ACCOUNT)
    const passwordField = structured.getByTestId('structured-field-password')
    await expect(passwordField).toContainText('••••')
    await expect(passwordField).not.toContainText(PASSWORD_VALUE)

    // 点击眼睛显示敏感值
    await structured.getByTestId('structured-reveal-password').click()
    await expect(passwordField).toContainText(PASSWORD_VALUE)
  })

  test('order detail renders the structured snapshot', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto('/profile')

    const orderCard = page
      .locator('div.shadow-sm')
      .filter({ has: page.getByRole('heading', { name: PRODUCT_NAME }) })
      .first()
    await expect(orderCard).toBeVisible({ timeout: 10_000 })
    await orderCard.getByRole('button', { name: '查看发货内容' }).click()

    const structured = page.getByTestId('structured-delivery')
    await expect(structured).toBeVisible({ timeout: 10_000 })
    await expect(structured.getByTestId('structured-field-account')).toContainText(ACCOUNT)
    // 敏感字段在订单详情同样默认遮蔽
    await expect(structured.getByTestId('structured-field-password')).not.toContainText(PASSWORD_VALUE)
  })
})
