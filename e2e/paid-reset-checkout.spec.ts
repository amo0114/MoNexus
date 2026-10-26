import { expect, test } from '@playwright/test'
import { createMockAccessToken } from './auth-fixtures'

// Browser contract smoke with controlled APIs. Database/remote authority is
// exercised by server/src/__tests__/paid-reset-checkout.test.ts.
test('URL target, account choice and confirmed target version reach one paid reset order without email OTP', async ({ page }) => {
  const accountA = '11111111-1111-4111-8111-111111111111'
  const accountB = '22222222-2222-4222-8222-222222222222'
  const user = { id: 901, email: 'buyer@monexus.test', nickname: '购买者', role: 'user', status: '正常',
    points: 1000, emailVerified: '2026-01-01T00:00:00Z', merchant: null }
  const offer = { id: 7, name: '流量重置', price: 200, originalPrice: null, status: 'active',
    deliveryMode: 'manual_service', stockMode: 'unlimited', stock: 0, sales: 0,
    provisionsExternal: 'faka_bridge', availability: { status: 'available' } }
  const product = { id: 42, name: '套餐流量重置', description: '重置已用流量', type: '网络节点', icon: 'box',
    imageUrl: '', price: 200, stock: 0, stockMode: 'unlimited', sales: 0, merchant: null, offers: [offer],
    availability: { status: 'available' } }
  const submissions: Array<{ body: any; key: string | undefined }> = []
  const targets: Array<string | null> = []
  const emailRequests: string[] = []
  await page.addInitScript(({ user, accessToken }) => {
    localStorage.setItem('monexus-auth', JSON.stringify({ state: { user, accessToken, isLoggedIn: true }, version: 0 }))
  }, { user, accessToken: createMockAccessToken(user) })
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname
    if (path.includes('/provision-email/')) emailRequests.push(path)
    if (path === '/api/auth/me') return route.fulfill({ json: user })
    if (path === '/api/config/registry') return route.fulfill({ json: { productTypes: [], deliveryModes: [],
      orderStatuses: [], settlementStatuses: [], capabilities: {}, memberTiers: [],
      pagination: { defaultPageSize: 20, maxPageSize: 100 }, inventory: { lowStockThreshold: 5 } } })
    if (path === '/api/products/42') return route.fulfill({ json: product })
    if (path === '/api/products/42/reviews') return route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 20 } })
    if (path === '/api/products/42/recommendations') return route.fulfill({ json: { productId: 42, items: [] } })
    if (path === '/api/announcements') return route.fulfill({ json: [] })
    if (path === '/api/checkout/preview') {
      const id = url.searchParams.get('xboardAccountLinkId')
      targets.push(id)
      return route.fulfill({ json: { productId: 42, productName: product.name, offerId: 7, offerName: offer.name,
        price: 200, deliveryMode: 'manual_service', chargeType: 'hold', balanceBefore: 1000, balanceAfter: 800,
        sufficient: true, purchasable: true, purchaseForm: [], purchaseFormVersion: 'pf-v1', checkoutVersion: 'co-v1',
        requiresVerification: false, autoProvision: false, requiresProvisionEmailProof: false, productContentVersion: 1,
        assuranceGrantId: null, xboardPaidReset: { accounts: [{ id: accountA, maskedEmail: 'a***@panel.test' },
          { id: accountB, maskedEmail: 'b***@panel.test' }], selectedAccountLinkId: id,
          targetVersion: (id === accountB ? 'b' : 'a').repeat(64), eligible: true, blockReason: null } } })
    }
    if (path === '/api/orders' && req.method() === 'POST') {
      submissions.push({ body: req.postDataJSON(), key: req.headers()['idempotency-key'] })
      return route.fulfill({ status: 201, json: { orderId: 123, productName: product.name, price: 200, status: 'pending',
        deliveryMode: 'manual_service', balanceAfter: 800, merchantId: null, merchantName: null, provisionPending: true } })
    }
    return route.fulfill({ status: 404, json: { error: { message: 'unused browser fixture route' } } })
  })
  await page.goto(`/product/42?offerId=7&xboardAccountLinkId=${accountA}`)
  await page.getByRole('button', { name: '立即兑换', exact: true }).first().click()
  const modal = page.getByTestId('purchase-modal')
  await expect(modal.getByTestId('paid-reset-account')).toHaveValue(accountA)
  await modal.getByTestId('paid-reset-account').selectOption(accountB)
  await expect(modal.getByTestId('paid-reset-account')).toHaveValue(accountB)
  await expect(modal.getByRole('button', { name: '确认支付', exact: true })).toBeEnabled()
  await modal.getByRole('button', { name: '确认支付', exact: true }).click()
  await expect.poll(() => submissions.length).toBe(1)
  expect(submissions[0].body).toMatchObject({ productId: 42, xboardAccountLinkId: accountB,
    expectedXboardTargetVersion: 'b'.repeat(64), expectedPrice: 200 })
  expect(submissions[0].key).toMatch(/^[a-f0-9-]{36}$/)
  expect(targets).toContain(accountA)
  expect(targets).toContain(accountB)
  expect(emailRequests).toEqual([])
  await expect(modal).not.toBeVisible()
})
