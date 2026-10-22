import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test'
import {
  API_BASE,
  E2E_PRODUCT_COVER,
  SEED_ACCOUNTS,
  approveGuestEligibility,
  loginAs,
  loginAsApi,
  publishMerchantProduct,
  selectAdminTab,
} from './helpers'

/**
 * SPEC-CATALOG-VIS-001 P1.5-B — the two cross-stack guest journeys:
 *   1. merchant asks for public → admin approves in the product panel → guest sees it
 *      → a content edit sends it back to review and hides it again;
 *   2. admin restricts the product's category → guest entry points hide it while a
 *      logged-in user still sees it.
 */

async function merchantToken(request: APIRequestContext) {
  return (await loginAsApi(request, SEED_ACCOUNTS.merchant)).accessToken
}

async function patchContent(
  request: APIRequestContext,
  token: string,
  productId: number,
  data: Record<string, unknown>,
) {
  const editor = await request.get(`${API_BASE}/api/merchant/products/${productId}/editor`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(editor.ok(), await editor.text()).toBeTruthy()
  const { product } = (await editor.json()) as { product: { contentVersion: number } }
  const patched = await request.patch(`${API_BASE}/api/merchant/products/${productId}/content`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { expectedContentVersion: product.contentVersion, ...data },
  })
  expect(patched.ok(), await patched.text()).toBeTruthy()
}

/** Published merchant product whose visibility is public but not yet approved for guests. */
async function createPendingPublicProduct(
  request: APIRequestContext,
  name: string,
  category: { categoryId: number } | { type: string } = { type: '邀请码' },
) {
  const token = await merchantToken(request)
  const created = await request.post(`${API_BASE}/api/merchant/products`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name,
      ...category,
      price: 1,
      deliveryMode: 'instant_fixed',
      fixedContent: 'https://example.com/e2e-guest-review',
      fixedContentType: 'url',
      stockMode: 'unlimited',
    },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const productId = ((await created.json()) as { id: number }).id
  await publishMerchantProduct(request, token, productId)
  // Switching to public is itself a public-content change and resets the approval.
  await patchContent(request, token, productId, { visibility: 'public' })
  return { productId, token }
}

async function openAsGuest(browser: Browser, productId: number): Promise<Page> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`/product/${productId}`)
  return page
}

async function expectGuestLocked(page: Page, name: string) {
  await expect(page.getByTestId('product-login-required')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText(name)).toHaveCount(0)
}

async function guestListIds(request: APIRequestContext, name: string) {
  const res = await request.get(`${API_BASE}/api/products`, { params: { q: name } })
  expect(res.ok(), await res.text()).toBeTruthy()
  const body = (await res.json()) as { items: Array<{ id: number }> }
  return body.items.map((item) => item.id)
}

test('merchant public request → admin approves in panel → guest sees it → edit sends it back', async ({
  page,
  browser,
  request,
}) => {
  const name = `E2E公开审核-${Date.now()}`
  const { productId, token } = await createPendingPublicProduct(request, name)

  const guest = await openAsGuest(browser, productId)
  await expectGuestLocked(guest, name)

  await loginAs(page, SEED_ACCOUNTS.admin)
  await page.goto('/admin')
  await selectAdminTab(page, 'products')
  await page.getByTestId('admin-products-search-input').fill(name)
  await page.getByTestId('admin-products-guest-review-filter').selectOption('pending')
  await page.getByTestId('admin-products-search-btn').click()
  await expect(page.getByTestId(`admin-product-guest-review-${productId}`)).toHaveText('待公开审核', {
    timeout: 10_000,
  })

  await page.getByTestId(`admin-guest-review-open-${productId}`).click()
  const dialog = page.getByTestId('admin-guest-review-dialog')
  await expect(dialog.getByTestId('admin-guest-review-state')).toContainText('待公开审核')
  const approval = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === `/api/admin/products/${productId}/guest-eligibility` &&
      res.request().method() === 'POST',
  )
  await dialog.getByTestId('admin-guest-review-approve').click()
  expect((await approval).status()).toBe(200)
  await expect(dialog).toBeHidden()
  // Approved products leave the pending queue.
  await expect(page.getByTestId(`admin-product-guest-review-${productId}`)).toHaveCount(0)

  await guest.reload()
  await expect(guest.getByText(name).first()).toBeVisible({ timeout: 10_000 })
  expect(await guestListIds(request, name)).toContain(productId)

  const renamed = `${name}-改`
  await patchContent(request, token, productId, { name: renamed })
  await guest.reload()
  await expectGuestLocked(guest, renamed)
  expect(await guestListIds(request, renamed)).not.toContain(productId)

  await page.getByTestId('admin-products-search-input').fill(renamed)
  await page.getByTestId('admin-products-search-btn').click()
  await expect(page.getByTestId(`admin-product-guest-review-${productId}`)).toHaveText('待公开审核', {
    timeout: 10_000,
  })
  await guest.context().close()
})

test('admin restricts the category → guest entry points hide the product, members still see it', async ({
  page,
  browser,
  request,
}) => {
  const admin = await loginAsApi(request, SEED_ACCOUNTS.admin)
  const tag = Date.now().toString(36)
  const createdCategory = await request.post(`${API_BASE}/api/admin/product-categories`, {
    headers: { Authorization: `Bearer ${admin.accessToken}` },
    data: { code: `e2e-guest-${tag}`, label: `E2E游客分类${tag}`, defaultCoverUrl: E2E_PRODUCT_COVER },
  })
  expect(createdCategory.ok(), await createdCategory.text()).toBeTruthy()
  const categoryId = ((await createdCategory.json()) as { id: number }).id

  const name = `E2E分类收紧-${Date.now()}`
  const { productId } = await createPendingPublicProduct(request, name, { categoryId })
  await approveGuestEligibility(request, productId)

  const guest = await openAsGuest(browser, productId)
  await expect(guest.getByText(name).first()).toBeVisible({ timeout: 10_000 })
  expect(await guestListIds(request, name)).toContain(productId)

  const restricted = await request.patch(`${API_BASE}/api/admin/product-categories/${categoryId}`, {
    headers: { Authorization: `Bearer ${admin.accessToken}` },
    data: { guestVisibility: 'members_only' },
  })
  expect(restricted.ok(), await restricted.text()).toBeTruthy()

  await guest.reload()
  await expectGuestLocked(guest, name)
  expect(await guestListIds(request, name)).not.toContain(productId)

  await loginAs(page, SEED_ACCOUNTS.user)
  await page.goto(`/product/${productId}`)
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('product-login-required')).toHaveCount(0)
  await guest.context().close()
})
