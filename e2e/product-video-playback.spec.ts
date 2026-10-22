import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { API_BASE, E2E_PRODUCT_COVER, SEED_ACCOUNTS, loginAs, loginAsApi, selectAdminTab } from './helpers'
const fixture = fileURLToPath(new URL('./fixtures/product-video.mp4', import.meta.url))

/** Real upload/save → admin preview/approval → guest decode, with no API stubs. */
test('private video waits for a click, plays real MP4 and releases media on gallery navigation across layouts', async ({ page, request, browser }) => {
  test.setTimeout(90_000)
  const merchant = await loginAsApi(request, SEED_ACCOUNTS.merchant)
  const name = `E2E商品视频-${Date.now()}`
  const created = await request.post(`${API_BASE}/api/merchant/products`, {
    headers: { Authorization: `Bearer ${merchant.accessToken}` },
    data: { name, type: '充值卡密', price: 2, deliveryMode: 'manual_service', stockMode: 'unlimited', imageUrl: E2E_PRODUCT_COVER, images: [E2E_PRODUCT_COVER] },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const productId = (await created.json()).id as number
  await loginAs(page, SEED_ACCOUNTS.merchant)
  await page.goto(`/merchant/products/${productId}/edit`)
  await page.getByTestId('product-edit-visibility-public').check()
  const uploaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/uploads/product-video' && response.request().method() === 'POST')
  await page.getByLabel('选择商品视频').setInputFiles(fixture)
  const upload = await uploaded
  expect(upload.status(), await upload.text()).toBe(201)
  const assetId = (await upload.json()).assetId as string
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === `/api/merchant/products/${productId}/content` && response.request().method() === 'PATCH')
  await page.getByTestId('product-edit-save').click()
  expect((await saved).ok()).toBeTruthy()
  const published = await request.post(`${API_BASE}/api/merchant/products/${productId}/publish`, { headers: { Authorization: `Bearer ${merchant.accessToken}` } })
  expect(published.ok(), await published.text()).toBeTruthy()
  expect((await request.get(`${API_BASE}/api/products/${productId}/video-playback`)).status()).toBe(403)

  const adminContext = await browser.newContext()
  const guestContext = await browser.newContext()
  try {
    const admin = await adminContext.newPage()
    await loginAs(admin, SEED_ACCOUNTS.admin)
    await admin.goto('/admin')
    await selectAdminTab(admin, 'products')
    await admin.getByTestId('admin-products-search-input').fill(name)
    await admin.getByTestId('admin-products-guest-review-filter').selectOption('pending')
    await admin.getByTestId('admin-products-search-btn').click()
    await admin.getByTestId(`admin-guest-review-open-${productId}`).click()
    const dialog = admin.getByTestId('admin-guest-review-dialog')
    const preview = dialog.getByRole('region', { name: '公开审核视频预览' })
    await expect(preview.getByTestId('admin-guest-review-video-version')).toContainText(assetId)
    await expect(preview.getByText(/此视频包含声音/)).toBeVisible()
    await preview.getByRole('button', { name: '▶ 播放商品视频' }).click()
    const adminVideo = preview.locator('video')
    await adminVideo.evaluate((element: HTMLVideoElement) => { element.muted = false; return element.play() })
    await expect.poll(() => adminVideo.evaluate((element: HTMLVideoElement) => element.ended)).toBe(true)
    expect(await adminVideo.evaluate((element: HTMLVideoElement) => element.muted)).toBe(false)
    const approved = admin.waitForResponse(response => new URL(response.url()).pathname === `/api/admin/products/${productId}/guest-eligibility` && response.request().method() === 'POST')
    await dialog.getByTestId('admin-guest-review-approve').click()
    expect((await approved).status()).toBe(200)
    await expect(dialog).toBeHidden()
    await adminContext.close()

    const guest = await guestContext.newPage()
    let tickets = 0; let bytes = 0
    guest.on('request', req => {
      const path = new URL(req.url()).pathname
      if (path === `/api/products/${productId}/video-playback`) tickets++
      if (path.startsWith('/api/uploads/product-video-signed/')) bytes++
    })
    for (const width of [1280, 820, 390]) {
      await guest.setViewportSize({ width, height: 900 })
      tickets = 0; bytes = 0
      await guest.goto(`/product/${productId}`)
      await expect(guest.getByRole('button', { name: '▶ 播放商品视频' })).toBeVisible()
      expect(tickets).toBe(0); expect(bytes).toBe(0)
      await guest.getByRole('button', { name: '▶ 播放商品视频' }).click()
      const video = guest.locator('video')
      await expect(video).toHaveAttribute('src', /product-video-signed/)
      await video.evaluate((element: HTMLVideoElement) => element.play())
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0)
      expect(tickets).toBe(1); expect(bytes).toBeGreaterThan(0)
      const handle = await video.elementHandle()
      await guest.getByRole('button', { name: '查看下一项商品媒体' }).click()
      await expect(video).toHaveCount(0)
      expect(await handle!.evaluate(element => element.getAttribute('src'))).toBeNull()
      await expect(guest.getByTestId('product-gallery-main')).toBeVisible()
    }
    const detail = await request.get(`${API_BASE}/api/products/${productId}`)
    expect((await detail.json()).promoVideo.assetId).toBe(assetId)
  } finally {
    await Promise.allSettled([adminContext.close(), guestContext.close()])
  }
})
