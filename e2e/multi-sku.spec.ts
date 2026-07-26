import { expect, test, type APIRequestContext } from '@playwright/test'
import { API_BASE, SEED_ACCOUNTS, loginAs } from './helpers'

/**
 * P4a SKU/套餐（Offer）全链路（spec: docs/specs/product-model-and-checkout.md §5）：
 * 1. 多规格商品：详情页渲染 SKU 选择器，切换规格改价，购买贵的那一档
 * 2. 订单沉淀规格快照：个人中心订单详情显示成交时的规格名
 * 3. 单规格透明：只有一个规格的商品不渲染选择器，购买链路与 P3 前一致
 * 4. 商家端规格管理：列表 + 弹窗内新增规格
 * 商品经商家 API 创建（名称带时间戳，每次运行独立），断言全在 UI 层。
 */

const MULTI_SKU_PRODUCT = `E2E多规格-${Date.now()}`
const BASIC_OFFER = `基础版-${Date.now()}`
const PREMIUM_OFFER = `高级版-${Date.now()}`
const BASIC_PRICE = 2
const PREMIUM_PRICE = 5
const PREMIUM_CARD = `E2E-SKU-PREMIUM-${Date.now()}`
const NEW_OFFER_NAME = `新增规格-${Date.now()}`

type Offer = { id: number; name: string; price: number }

const state: { productId: number; basicOfferId: number; premiumOfferId: number } = {
  productId: 0,
  basicOfferId: 0,
  premiumOfferId: 0,
}

async function merchantToken(request: APIRequestContext) {
  const login = await request.post(`${API_BASE}/api/auth/login`, { data: SEED_ACCOUNTS.merchant })
  expect(login.ok(), await login.text()).toBeTruthy()
  return (await login.json()).accessToken as string
}

async function createProduct(request: APIRequestContext, token: string, body: Record<string, unknown>) {
  const res = await request.post(`${API_BASE}/api/merchant/products`, {
    headers: { Authorization: `Bearer ${token}` },
    data: body,
  })
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json()) as { id: number }
}

/** 按规格导入交付库存：省略 offerId 会落到默认 Offer，多规格必须显式指定。 */
async function importInventory(
  request: APIRequestContext,
  token: string,
  productId: number,
  offerId: number,
  items: string[]
) {
  const res = await request.post(`${API_BASE}/api/merchant/products/${productId}/inventory`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { items, offerId },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
}

/** 详情页主价格：锚定「兑换需要」标签后紧邻的价格块，避免误匹配库存/余额里的数字。 */
function displayPrice(page: import('@playwright/test').Page) {
  return page.getByText('兑换需要').locator('xpath=following-sibling::div[1]')
}

test.describe.serial('P4a multi-SKU purchase chain', () => {
  test('merchant provisions a two-SKU product with per-offer inventory', async ({ request }) => {
    const token = await merchantToken(request)
    const product = await createProduct(request, token, {
      name: MULTI_SKU_PRODUCT,
      type: '充值卡密',
      price: BASIC_PRICE,
      deliveryMode: 'instant_inventory',
    })
    state.productId = product.id

    // 建商品时自动生成的「默认规格」重命名为可断言的名字（多规格下默认名无展示意义）
    const offersRes = await request.get(`${API_BASE}/api/merchant/products/${product.id}/offers`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(offersRes.ok(), await offersRes.text()).toBeTruthy()
    const defaultOffer = ((await offersRes.json()) as Offer[])[0]
    state.basicOfferId = defaultOffer.id
    const rename = await request.put(
      `${API_BASE}/api/merchant/products/${product.id}/offers/${defaultOffer.id}`,
      { headers: { Authorization: `Bearer ${token}` }, data: { name: BASIC_OFFER } }
    )
    expect(rename.ok(), await rename.text()).toBeTruthy()

    // 第二个更贵的规格
    const created = await request.post(`${API_BASE}/api/merchant/products/${product.id}/offers`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: PREMIUM_OFFER,
        price: PREMIUM_PRICE,
        deliveryMode: 'instant_inventory',
        stockMode: 'limited',
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    state.premiumOfferId = ((await created.json()) as Offer).id

    // 两档各自导入互不相同的卡密：交付内容能证明成交落在选中的规格上
    await importInventory(request, token, product.id, state.basicOfferId, [
      `E2E-SKU-BASIC-${Date.now()}`,
    ])
    await importInventory(request, token, product.id, state.premiumOfferId, [PREMIUM_CARD])
  })

  test('buyer switches SKU, price follows, and purchases the premium offer', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto(`/product/${state.productId}`)

    // 多规格 → 选择器渲染两个选项，默认选中第一档（后端按 sortOrder→id 排序）
    const selector = page.getByTestId('sku-selector')
    await expect(selector).toBeVisible({ timeout: 10_000 })
    await expect(selector.getByTestId(`sku-option-${state.basicOfferId}`)).toBeVisible()
    await expect(selector.getByTestId(`sku-option-${state.premiumOfferId}`)).toBeVisible()
    await expect(displayPrice(page)).toHaveText(String(BASIC_PRICE))

    // 切换到贵的那一档：主价格随选中规格变化
    await selector.getByTestId(`sku-option-${state.premiumOfferId}`).click()
    await expect(displayPrice(page)).toHaveText(String(PREMIUM_PRICE))
    // 再切回来确认双向生效，然后正式选中高级版下单
    await selector.getByTestId(`sku-option-${state.basicOfferId}`).click()
    await expect(displayPrice(page)).toHaveText(String(BASIC_PRICE))
    await selector.getByTestId(`sku-option-${state.premiumOfferId}`).click()

    await page.getByRole('button', { name: '立即兑换' }).click()

    // 结算预览按选中规格报价，并展示规格名
    const modal = page.getByTestId('purchase-modal')
    await expect(modal.getByTestId('preview-offer-name')).toHaveText(PREMIUM_OFFER, { timeout: 10_000 })
    await expect(modal.getByTestId('preview-price')).toHaveText(new RegExp(String(PREMIUM_PRICE)))

    await modal.getByRole('button', { name: '确认支付' }).click()

    // 成功弹窗交付的是高级版库存里的那张卡密
    await expect(page.getByText('兑换成功', { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(PREMIUM_CARD)).toBeVisible({ timeout: 10_000 })
  })

  test('order detail shows the purchased spec snapshot', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto('/profile')

    const orderCard = page
      .locator('div.shadow-sm')
      .filter({ has: page.getByRole('heading', { name: MULTI_SKU_PRODUCT }) })
      .first()
    await expect(orderCard).toBeVisible({ timeout: 10_000 })
    // 列表卡片直接带规格徽标
    await expect(orderCard.getByText(PREMIUM_OFFER)).toBeVisible()

    await orderCard.getByRole('button', { name: '查看发货内容' }).click()
    // 订单详情展示成交时的规格名快照（商家后续改名不影响历史订单）
    await expect(page.getByTestId('order-offer-name')).toHaveText(PREMIUM_OFFER, { timeout: 10_000 })
  })

  test('merchant manages offers from the product list and adds a new one', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant')
    await page.getByRole('button', { name: '商品管理' }).click()
    await expect(page.getByTestId('merchant-product-filters')).toBeVisible({ timeout: 10_000 })

    // 搜索定位（列表分页，e2e 累积商品可能把它挤出第一页）
    await page.getByTestId('merchant-product-search').fill(MULTI_SKU_PRODUCT)
    const row = page.locator('tbody tr').filter({ hasText: MULTI_SKU_PRODUCT })
    await expect(row).toBeVisible({ timeout: 10_000 })

    await row.getByText('规格管理').click()
    const modal = page.getByTestId('merchant-offer-manager-modal')
    await expect(modal).toBeVisible({ timeout: 10_000 })

    // 现有两档都在列表里
    const list = modal.getByTestId('offer-list')
    await expect(list.getByTestId(`offer-row-${state.basicOfferId}`)).toContainText(BASIC_OFFER)
    await expect(list.getByTestId(`offer-row-${state.premiumOfferId}`)).toContainText(PREMIUM_OFFER)

    // 弹窗内新增一个人工服务规格（不限量 → 无需填名额）
    await modal.getByTestId('offer-add').click()
    await modal.getByTestId('offer-form-name').fill(NEW_OFFER_NAME)
    await modal.getByTestId('offer-form-price').fill('3')
    await modal.getByTestId('offer-form-delivery-mode').selectOption('manual_service')
    await modal.getByTestId('offer-form-stock-mode').selectOption('unlimited')
    await modal.getByTestId('offer-form-submit').click()

    await expect(page.getByText('规格已创建')).toBeVisible({ timeout: 10_000 })
    // 保存后回到列表视图，新规格出现
    await expect(modal.getByTestId('offer-list')).toContainText(NEW_OFFER_NAME, { timeout: 10_000 })
  })
})

/**
 * 混合规格商品（默认规格 = 交付库存，另有 manual_service 限量规格）：行内操作
 * 入口必须按「存在哪类规格」判定，而不是只看商品级投影（= 默认规格的模式）。
 * 否则另一半规格永远无法管理——交付库存商品拿不到「调整名额」，人工服务商品
 * 拿不到「管理交付库存」。
 */
test('mixed-mode multi-SKU product exposes both inventory and capacity actions', async ({ page, request }) => {
  const token = await merchantToken(request)
  const name = `E2E混合规格-${Date.now()}`
  const product = await createProduct(request, token, {
    name,
    type: '充值卡密',
    price: 2,
    deliveryMode: 'instant_inventory',
  })

  // 追加一个人工服务限量规格：商品级投影仍是 instant_inventory（默认规格）
  const created = await request.post(`${API_BASE}/api/merchant/products/${product.id}/offers`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name: `人工档-${Date.now()}`,
      price: 4,
      deliveryMode: 'manual_service',
      stockMode: 'limited',
      stock: 3,
    },
  })
  expect(created.ok(), await created.text()).toBeTruthy()

  await loginAs(page, SEED_ACCOUNTS.merchant)
  await page.goto('/merchant')
  await page.getByRole('button', { name: '商品管理' }).click()
  await expect(page.getByTestId('merchant-product-filters')).toBeVisible({ timeout: 10_000 })
  await page.getByTestId('merchant-product-search').fill(name)
  const row = page.locator('tbody tr').filter({ hasText: name })
  await expect(row).toBeVisible({ timeout: 10_000 })

  // 两类入口同时存在
  await expect(row.getByText('管理交付库存')).toBeVisible()
  await expect(row.getByText('调整可售名额')).toBeVisible()

  // 名额调整弹窗只列可调整的那条规格，且现存名额取自该规格而非商品投影
  await row.getByText('调整可售名额').click()
  const capacityModal = page.getByTestId('merchant-capacity-adjust-modal')
  await expect(capacityModal).toBeVisible({ timeout: 10_000 })
  await expect(capacityModal.getByTestId('merchant-capacity-current-stock')).toHaveText('3')
})

test('single-SKU product stays transparent: no selector, purchase still works', async ({ page, request }) => {
  const token = await merchantToken(request)
  const name = `E2E单规格-${Date.now()}`
  const url = 'https://example.com/e2e-single-sku'
  const product = await createProduct(request, token, {
    name,
    type: '邀请码',
    price: 1,
    deliveryMode: 'instant_fixed',
    fixedContent: url,
    fixedContentType: 'url',
    stockMode: 'unlimited',
  })

  await loginAs(page, SEED_ACCOUNTS.user)
  await page.goto(`/product/${product.id}`)

  // 只有一个（自动生成的默认）规格：选择器完全不渲染
  await expect(page.getByRole('button', { name: '立即兑换' })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('sku-selector')).toHaveCount(0)

  await page.getByRole('button', { name: '立即兑换' }).click()
  const modal = page.getByTestId('purchase-modal')
  await expect(modal.getByTestId('preview-price')).toBeVisible({ timeout: 10_000 })
  // 默认规格名不外泄给买家
  await expect(modal.getByTestId('preview-offer-name')).toHaveCount(0)

  await modal.getByRole('button', { name: '确认支付' }).click()
  const successLink = page.getByTestId('success-delivery-link')
  await expect(successLink).toBeVisible({ timeout: 10_000 })
  await expect(successLink).toHaveAttribute('href', url)
})
