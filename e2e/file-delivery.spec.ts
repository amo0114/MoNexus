import { expect, test, type APIRequestContext } from '@playwright/test'
import { API_BASE, SEED_ACCOUNTS, loginAs, publishMerchantProduct } from './helpers'

/**
 * P5 T7：受控文件交付全链路（memory 适配器——dev 栈未配私有桶时的模拟签名，
 * 权限/过期/篡改语义与 S3 版逐项对齐；真实 MinIO 四项验证另见集成脚本
 * server/scripts/delivery-storage-integration.ts）。
 * 1. 商家上传文件 → file 形态规格上架 → 买家 UI 购买 → 成功弹窗下载卡片可下载
 * 2. 订单详情下载卡片；争议期间买家被拒（403 文案提示）
 * 3. 篡改签名 URL → 403
 */

const PRODUCT_NAME = `E2E文件交付-${Date.now()}`
const FILE_CONTENT = `paid-file-${Date.now()}`

const state = { productId: 0, offerId: 0, fileId: 0, orderId: 0 }

async function tokenOf(request: APIRequestContext, account: { email: string; password: string }) {
  const login = await request.post(`${API_BASE}/api/auth/login`, { data: account })
  expect(login.ok(), await login.text()).toBeTruthy()
  return (await login.json()).accessToken as string
}

test.describe.serial('P5 controlled file delivery', () => {
  test('merchant uploads a file and publishes a file-form offer', async ({ request }) => {
    const token = await tokenOf(request, SEED_ACCOUNTS.merchant)

    const uploaded = await request.post(`${API_BASE}/api/uploads/delivery-file`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        file: { name: 'E2E交付包.zip', mimeType: 'application/zip', buffer: Buffer.from(FILE_CONTENT) },
      },
    })
    expect(uploaded.status(), await uploaded.text()).toBe(201)
    state.fileId = (await uploaded.json()).id

    const created = await request.post(`${API_BASE}/api/merchant/products`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: PRODUCT_NAME,
        type: '充值卡密',
        price: 2,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    state.productId = (await created.json()).id

    const offer = await request.post(`${API_BASE}/api/merchant/products/${state.productId}/offers`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: '文件版',
        price: 2,
        deliveryMode: 'instant_fixed',
        stockMode: 'unlimited',
        fixedContentType: 'file',
        fixedFileId: state.fileId,
      },
    })
    expect(offer.ok(), await offer.text()).toBeTruthy()
    state.offerId = (await offer.json()).id

    // 下架默认人工档 → 唯一 active 规格，买家免选规格。
    const offers = await request.get(`${API_BASE}/api/merchant/products/${state.productId}/offers`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const defaultOffer = ((await offers.json()) as { id: number; isDefault: boolean }[]).find(o => o.isDefault)!
    const deactivate = await request.put(
      `${API_BASE}/api/merchant/products/${state.productId}/offers/${defaultOffer.id}`,
      { headers: { Authorization: `Bearer ${token}` }, data: { status: 'inactive' } },
    )
    expect(deactivate.ok(), await deactivate.text()).toBeTruthy()
    await publishMerchantProduct(request, token, state.productId)
  })

  test('buyer purchases via UI and downloads from the success modal', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto(`/product/${state.productId}`)

    // 购前提示：文件交付 + 大小，不出现文件名。
    await expect(page.getByTestId('file-delivery-preview')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('file-delivery-preview')).toContainText('文件交付')
    await expect(page.getByTestId('file-delivery-preview')).not.toContainText('E2E交付包')

    await page.getByRole('button', { name: '立即兑换' }).click()
    await expect(page.getByText('确认兑换')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: '确认支付' }).click()

    const card = page.getByTestId('file-delivery-card')
    await expect(card).toBeVisible({ timeout: 10_000 })
    await expect(card).toContainText('E2E交付包.zip')

    const downloadPromise = page.waitForEvent('download')
    await page.getByTestId('file-delivery-download').click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toContain('E2E')
  })

  test('order detail keeps the download card; dispute suspends buyer issuance', async ({ page, request }) => {
    const buyerToken = await tokenOf(request, SEED_ACCOUNTS.user)
    const orders = await request.get(`${API_BASE}/api/orders`, {
      headers: { Authorization: `Bearer ${buyerToken}` },
    })
    const order = ((await orders.json()) as { id: number; product?: { id: number } }[])
      .find(o => o.product?.id === state.productId)!
    state.orderId = order.id

    // 争议前发放正常。
    const ok = await request.post(`${API_BASE}/api/orders/${state.orderId}/files/download-url`, {
      headers: { Authorization: `Bearer ${buyerToken}` },
    })
    expect(ok.status(), await ok.text()).toBe(200)
    const grant = await ok.json()

    // 篡改签名 → 403（与真实 SigV4 失败同语义）。
    const tampered = await request.get(`${API_BASE}${grant.url}x`)
    expect(tampered.status()).toBe(403)

    // 争议 → 买家新签发被拒且 UI 有明确文案。
    const dispute = await request.post(`${API_BASE}/api/orders/${state.orderId}/dispute`, {
      headers: { Authorization: `Bearer ${buyerToken}` },
    })
    expect(dispute.ok(), await dispute.text()).toBeTruthy()

    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto('/profile')
    // 全量套件下同一买家有多笔订单：定位到本商品所在卡片再点它的
    //「查看发货内容」，不能拿列表第一个。
    const orderCard = page
      .locator('div')
      .filter({ has: page.getByRole('heading', { name: PRODUCT_NAME }) })
      .filter({ has: page.getByRole('button', { name: '查看发货内容' }) })
      .last()
    await expect(orderCard).toBeVisible({ timeout: 10_000 })
    await orderCard.getByRole('button', { name: '查看发货内容' }).click()
    await expect(page.getByTestId('file-delivery-card')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('file-delivery-download').click()
    await expect(page.getByText('订单争议处理中，文件下载已暂停')).toBeVisible({ timeout: 10_000 })
  })
})
