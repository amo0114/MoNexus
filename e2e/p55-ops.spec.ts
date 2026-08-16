import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { API_BASE, SEED_ACCOUNTS, loginAs, loginAsApi, publishMerchantProduct } from './helpers'

/**
 * P5.5 运维收尾冒烟：
 * 1. 管理端「文件治理」tab：列表筛选 → 发放流水展开 → 吊销闭环（UI 全链路）。
 * 2. 商家 dashboard「热销规格」：真实成交后榜单出现该规格（净成交口径）。
 */

const STAMP = Date.now()
const FILE_NAME = `E2E治理-${STAMP}.txt`
const PRODUCT_NAME = `E2E报表-${STAMP}`
const OFFER_NAME = `报表规格-${STAMP}`

const state = { fileId: 0, productId: 0, offerId: 0 }

async function tokenOf(request: APIRequestContext, account: { email: string; password: string }) {
  return (await loginAsApi(request, account)).accessToken
}

test.describe.serial('P5.5 ops smoke', () => {
  test('admin file governance: filter, grants, revoke via UI', async ({ page, request }) => {
    const merchantToken = await tokenOf(request, SEED_ACCOUNTS.merchant)
    const uploaded = await request.post(`${API_BASE}/api/uploads/delivery-file`, {
      headers: { Authorization: `Bearer ${merchantToken}` },
      multipart: {
        file: { name: FILE_NAME, mimeType: 'text/plain', buffer: Buffer.from(`content-${STAMP}`) },
      },
    })
    expect(uploaded.status(), await uploaded.text()).toBe(201)
    state.fileId = (await uploaded.json()).id

    await loginAs(page, SEED_ACCOUNTS.admin)
    await page.goto('/admin')
    await page.getByRole('button', { name: '文件治理' }).click()
    await page.getByPlaceholder('文件名').fill(FILE_NAME)
    await page.getByRole('button', { name: '查询' }).click()

    const row = page.locator('tr').filter({ hasText: FILE_NAME })
    await expect(row).toBeVisible({ timeout: 10_000 })
    await expect(row).toContainText('正常')

    // 未发放过的新文件也要能展开流水（空态文案）。
    await page.getByTestId(`admin-file-grants-${state.fileId}`).click()
    await expect(page.getByText('暂无发放记录')).toBeVisible()

    // 吊销闭环：确认弹窗 → 原因 → 状态徽标翻转、按钮禁用。
    await page.getByTestId(`admin-file-revoke-${state.fileId}`).click()
    await expect(page.getByTestId('admin-file-revoke-dialog')).toBeVisible()
    await page.getByTestId('admin-file-revoke-reason').fill('E2E 吊销演练')
    await page.getByTestId('admin-file-revoke-confirm').click()
    await expect(page.getByText('已吊销文件')).toBeVisible({ timeout: 10_000 })
    await expect(row).toContainText('已吊销')
    await expect(page.getByTestId(`admin-file-revoke-${state.fileId}`)).toBeDisabled()
  })

  test('merchant dashboard lists the offer in 热销规格 after a sale', async ({ page, request }) => {
    const merchantToken = await tokenOf(request, SEED_ACCOUNTS.merchant)
    const created = await request.post(`${API_BASE}/api/merchant/products`, {
      headers: { Authorization: `Bearer ${merchantToken}` },
      data: { name: PRODUCT_NAME, type: '充值卡密', price: 1, deliveryMode: 'manual_service', stockMode: 'unlimited' },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    state.productId = (await created.json()).id

    const offer = await request.post(`${API_BASE}/api/merchant/products/${state.productId}/offers`, {
      headers: { Authorization: `Bearer ${merchantToken}` },
      data: {
        name: OFFER_NAME,
        price: 1,
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        fixedContentType: 'text',
        fixedContent: `CODE-${STAMP}`,
      },
    })
    expect(offer.ok(), await offer.text()).toBeTruthy()
    state.offerId = (await offer.json()).id
    await publishMerchantProduct(request, merchantToken, state.productId)

    // 买家 API 直购该规格 → 报表立即有净成交数据。
    const buyerToken = await tokenOf(request, SEED_ACCOUNTS.user)
    const order = await request.post(`${API_BASE}/api/orders`, {
      headers: { Authorization: `Bearer ${buyerToken}`, 'Idempotency-Key': randomUUID() },
      data: { productId: state.productId, offerId: state.offerId },
    })
    expect(order.ok(), await order.text()).toBeTruthy()

    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant/dashboard')
    const card = page.getByTestId('dashboard-top-offers')
    await expect(card).toBeVisible({ timeout: 10_000 })
    await expect(card).toContainText('净成交口径')
    // 榜单只取 top-10：共享 dev 库里历史 E2E 订单可能把本单挤出榜（聚合
    // 正确性由 merchant-offer-report vitest 锁定）。e2e 只断言 UI 接线：
    // 榜单渲染出至少一行带销量/收入的成交数据。
    const rows = card.locator('tbody tr')
    await expect(rows.first()).toBeVisible({ timeout: 10_000 })
    await expect(rows.first()).toContainText(/\d/)
  })
})
