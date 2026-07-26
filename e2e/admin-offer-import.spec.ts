import { expect, test, type APIRequestContext } from '@playwright/test'
import { API_BASE, SEED_ACCOUNTS, loginAs } from './helpers'

/**
 * P4a F2（P1-1 评审修复）：管理端按规格导入的 UI 闭环。
 * 场景刻意构造成"投影会误导入口"的形态——默认规格是人工服务、
 * 另有两个即时库存规格：
 * 1. 商品行仍出现「导入交付库存」入口（按规格集合判定，非商品级投影）
 * 2. 弹窗要求从下拉框选择目标规格（多个可导入规格时不自动选）
 * 3. 导入后库存只进被选规格，另一个规格不受影响（公开详情逐规格断言）
 */

const PRODUCT_NAME = `E2E管理端规格导入-${Date.now()}`
const OFFER_A = `卡密A-${Date.now()}`
const OFFER_B = `卡密B-${Date.now()}`
const CARD_1 = `E2E-ADMIN-IMP-1-${Date.now()}`
const CARD_2 = `E2E-ADMIN-IMP-2-${Date.now()}`

const state = { productId: 0, offerAId: 0, offerBId: 0 }

async function merchantToken(request: APIRequestContext) {
  const login = await request.post(`${API_BASE}/api/auth/login`, { data: SEED_ACCOUNTS.merchant })
  expect(login.ok(), await login.text()).toBeTruthy()
  return (await login.json()).accessToken as string
}

test.describe.serial('admin offer-scoped inventory import', () => {
  test('merchant provisions a manual-default product with two instant offers (atomic publish)', async ({ request }) => {
    const token = await merchantToken(request)
    // F3 原子发布：默认规格人工服务 + 两个附加即时库存规格，单请求建齐。
    const res = await request.post(`${API_BASE}/api/merchant/products`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: PRODUCT_NAME,
        type: '充值卡密',
        price: 3,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
        primaryOfferName: '人工服务档',
        offers: [
          { name: OFFER_A, price: 2, deliveryMode: 'instant_inventory' },
          { name: OFFER_B, price: 4, deliveryMode: 'instant_inventory' },
        ],
      },
    })
    expect(res.ok(), await res.text()).toBeTruthy()
    state.productId = (await res.json()).id

    const offersRes = await request.get(`${API_BASE}/api/merchant/products/${state.productId}/offers`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(offersRes.ok()).toBeTruthy()
    const offers = (await offersRes.json()) as { id: number; name: string }[]
    state.offerAId = offers.find(o => o.name === OFFER_A)!.id
    state.offerBId = offers.find(o => o.name === OFFER_B)!.id
  })

  test('admin sees the import entry, must pick an offer, and stock lands on the picked offer only', async ({ page, request }) => {
    await loginAs(page, SEED_ACCOUNTS.admin)
    await page.goto('/admin')
    await page.getByRole('button', { name: '商品与库存' }).click()

    // 商品级投影是 manual_service，但存在可导入规格 → 入口必须出现。
    const importButton = page.getByTestId(`admin-import-inventory-${state.productId}`)
    await expect(importButton).toBeVisible({ timeout: 10_000 })
    await importButton.click()

    // 多个可导入规格：必须显式选择，不选直接导会被前端拦下。
    const select = page.getByTestId('admin-import-offer-select')
    await expect(select).toBeVisible()
    await page.getByTestId('admin-import-inventory-text').fill(`${CARD_1}\n${CARD_2}`)
    await page.getByTestId('admin-import-inventory-confirm').click()
    await expect(page.getByText('请选择目标规格')).toBeVisible()

    await select.selectOption(String(state.offerBId))
    await page.getByTestId('admin-import-inventory-confirm').click()
    await expect(page.getByText('成功导入 2 个交付单元')).toBeVisible({ timeout: 10_000 })

    // 公开详情逐规格断言：即时库存规格的公开 stock = 实际可用条目数。
    const detail = await request.get(`${API_BASE}/api/products/${state.productId}`)
    expect(detail.ok()).toBeTruthy()
    const offers = (await detail.json()).offers as { id: number; stock: number }[]
    expect(offers.find(o => o.id === state.offerBId)?.stock).toBe(2)
    expect(offers.find(o => o.id === state.offerAId)?.stock).toBe(0)
  })
})
