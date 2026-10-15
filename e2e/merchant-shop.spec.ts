import { expect, test, type APIRequestContext } from '@playwright/test'
import { API_BASE, SEED_ACCOUNTS, loginAs, loginAsApi, publishMerchantProduct } from './helpers'

/**
 * PLAN-MERCHANT-STOREFRONT-001 S08: product detail → shop → in-shop search →
 * another product → browser back to the same search. Permissions, availability
 * and pagination are covered by backend/component tests, not repeated here.
 */
async function createMerchantProduct(request: APIRequestContext, token: string, name: string) {
  const res = await request.post(`${API_BASE}/api/merchant/products`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name,
      type: '邀请码',
      price: 3,
      deliveryMode: 'instant_fixed',
      fixedContent: 'https://example.com/e2e-shop',
      fixedContentType: 'url',
      stockMode: 'unlimited',
    },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
  const product = (await res.json()) as { id: number }
  await publishMerchantProduct(request, token, product.id)
  return product
}

test('buyer enters a merchant shop from a product and searches within it', async ({ page, request }) => {
  const stamp = Date.now()
  const { accessToken } = await loginAsApi(request, SEED_ACCOUNTS.merchant)
  const first = await createMerchantProduct(request, accessToken, `E2E店铺甲-${stamp}`)
  const second = await createMerchantProduct(request, accessToken, `E2E店铺乙-${stamp}`)

  await loginAs(page, SEED_ACCOUNTS.user)
  await page.goto(`/product/${first.id}`)
  await page.getByTestId('desktop-shop-link').click()
  await expect(page).toHaveURL(/\/shops\/\d+$/)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

  const query = `乙-${stamp}`
  await page.getByRole('searchbox', { name: '搜索本店商品' }).fill(query)
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`\\?q=${encodeURIComponent(query)}$`))
  const results = page.getByTestId('shop-products')
  await expect(results.getByRole('link', { name: `E2E店铺乙-${stamp}` })).toBeVisible()
  await expect(results.getByRole('link', { name: `E2E店铺甲-${stamp}` })).toHaveCount(0)

  await results.getByRole('link', { name: `E2E店铺乙-${stamp}` }).click()
  await expect(page).toHaveURL(new RegExp(`/product/${second.id}$`))

  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/shops/\\d+\\?q=`))
  await expect(page.getByRole('searchbox', { name: '搜索本店商品' })).toHaveValue(query)
  await expect(page.getByTestId('shop-products').getByRole('link', { name: `E2E店铺乙-${stamp}` })).toBeVisible()
})
