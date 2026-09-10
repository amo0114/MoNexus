import { expect, test } from '@playwright/test'
import { API_BASE, SEED_ACCOUNTS, publishMerchantProduct } from './helpers'

async function createPublishedProduct(request: import('@playwright/test').APIRequestContext, name: string, visibility: 'public' | 'members_only') {
  const merchantLogin = await request.post(`${API_BASE}/api/auth/login`, { data: SEED_ACCOUNTS.merchant })
  const merchantToken = (await merchantLogin.json()).accessToken as string
  const created = await request.post(`${API_BASE}/api/merchant/products`, {
    headers: { Authorization: `Bearer ${merchantToken}` },
    data: {
      name,
      type: '邀请码',
      price: 1,
      deliveryMode: 'instant_fixed',
      fixedContent: 'https://example.com/e2e-visibility',
      fixedContentType: 'url',
      stockMode: 'unlimited',
    },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const productId = ((await created.json()) as { id: number }).id
  await publishMerchantProduct(request, merchantToken, productId)
  if (visibility === 'public') {
    const editor = await request.get(`${API_BASE}/api/merchant/products/${productId}/editor`, {
      headers: { Authorization: `Bearer ${merchantToken}` },
    })
    expect(editor.ok(), await editor.text()).toBeTruthy()
    const editorBody = (await editor.json()) as { product?: { contentVersion?: number } }
    const product = editorBody.product
    if (!product || typeof product.contentVersion !== 'number') {
      throw new Error('GET /editor 缺少 product.contentVersion')
    }
    const contentVersion = product.contentVersion
    const patched = await request.patch(`${API_BASE}/api/merchant/products/${productId}/content`, {
      headers: { Authorization: `Bearer ${merchantToken}` },
      data: { expectedContentVersion: contentVersion, visibility: 'public' },
    })
    expect(patched.ok(), await patched.text()).toBeTruthy()
  }
  return productId
}

test('exchange modal opens on product detail and can be cancelled', async ({ page }) => {
  await page.goto('/login')
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  })
  await page.getByPlaceholder('邮箱地址').fill('test@moyuan.net')
  await page.getByPlaceholder('密码（至少 6 位）').fill('user123')
  await page.getByRole('button', { name: '登录' }).click()

  await expect(page).toHaveURL(/\/$/)
  await page.goto('/product/2')

  await page.getByRole('button', { name: '立即兑换' }).click()

  const modalTitle = page.getByText('确认兑换')
  await expect(modalTitle).toBeVisible({ timeout: 10_000 })
  await expect(modalTitle).toBeInViewport()

  await page.getByRole('button', { name: '再想想' }).click()
  await expect(modalTitle).not.toBeVisible()
})

test('guest browses a public product, logs in via returnTo, and can redeem', async ({ page, request }) => {
  const productId = await createPublishedProduct(request, `E2E公开回跳-${Date.now()}`, 'public')
  await page.goto(`/product/${productId}`)
  await expect(page.getByRole('button', { name: '登录后兑换' })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: '登录后兑换' }).click()
  await expect(page).toHaveURL(/\/login\?returnTo=/)
  await page.getByPlaceholder('邮箱地址').fill(SEED_ACCOUNTS.user.email)
  await page.getByPlaceholder('密码（至少 6 位）').fill(SEED_ACCOUNTS.user.password)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page).toHaveURL(new RegExp(`/product/${productId}`))
  await page.getByRole('button', { name: '立即兑换' }).click()
  await expect(page.getByText('确认兑换')).toBeVisible({ timeout: 10_000 })
})

test('guest sees a generic login lock for members_only products', async ({ page, request }) => {
  const name = `E2E会员锁定-${Date.now()}`
  const productId = await createPublishedProduct(request, name, 'members_only')
  await page.goto(`/product/${productId}`)
  await expect(page.getByTestId('product-login-required')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('登录后查看商品')).toBeVisible()
  await expect(page.getByText(name)).toHaveCount(0)
})
