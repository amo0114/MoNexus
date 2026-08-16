import { expect, test, type APIRequestContext } from '@playwright/test'
import { API_BASE, SEED_ACCOUNTS, loginAs } from './helpers'

/**
 * SPEC-LEGAL-001：法律页面与协议同意的端到端验收（独立 e2e 栈，
 * LEGAL_PAGES_ENABLED=true + ENFORCEMENT=enforce）：
 * 1. 五份文档未登录直接访问 + 刷新后内容仍在
 * 2. 登录后 footer 分组链接可见且可跳转
 * 3. 注册勾选门控（未勾选禁用提交，勾选后可注册）
 * 4. 下单勾选门控 + 退款披露（未勾选禁用支付，勾选后成交）
 * 5. enforce 模式下 API 层的 LEGAL_AGREEMENT_REQUIRED 契约
 */

const LEGAL_PAGES = [
  { path: '/terms', title: '服务协议' },
  { path: '/privacy', title: '隐私政策' },
  { path: '/refund', title: '退款政策' },
  { path: '/points-rules', title: '积分规则' },
  { path: '/about', title: '关于我们' },
] as const

test.describe('legal pages: direct access & refresh', () => {
  for (const { path, title } of LEGAL_PAGES) {
    test(`${path} renders ${title} for anonymous visitors and survives refresh`, async ({ page }) => {
      await page.goto(path)
      await expect(page.getByTestId('legal-document-title')).toHaveText(title, { timeout: 10_000 })
      await expect(page.getByTestId('legal-document-meta')).toContainText('版本')

      await page.reload()
      await expect(page.getByTestId('legal-document-title')).toHaveText(title, { timeout: 10_000 })
    })
  }

  test('unknown legal slugs are not routable (fall through to protected area)', async ({ page }) => {
    // 未登录访问未知路径会被受保护区重定向到登录页，而不是渲染空白文档。
    await page.goto('/legal/nonsense')
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 })
  })
})

test.describe('legal pages: footer links (gate-aware)', () => {
  test('footer shows grouped legal links after login and navigates to the document', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)

    const links = page.getByTestId('footer-legal-links')
    await expect(links).toBeVisible({ timeout: 10_000 })
    for (const { title } of LEGAL_PAGES) {
      await expect(links.getByRole('link', { name: title })).toBeVisible()
    }

    await links.getByRole('link', { name: '服务协议' }).click()
    await expect(page).toHaveURL(/\/terms$/, { timeout: 10_000 })
    await expect(page.getByTestId('legal-document-title')).toHaveText('服务协议')
  })
})

test.describe('registration consent gate', () => {
  test('submit stays disabled until agreements are checked; registration then succeeds', async ({ page }) => {
    await page.goto('/login')
    await page.addStyleTag({
      content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
    })
    await page.getByRole('button', { name: '没有账号？立即注册' }).click()

    const agreement = page.getByTestId('register-agreement')
    await expect(agreement).toBeVisible()
    // 勾选文案含两份必读文档的链接（新标签页打开，不中断注册）。
    await expect(agreement.getByRole('link', { name: '《服务协议》' })).toBeVisible()
    await expect(agreement.getByRole('link', { name: '《隐私政策》' })).toBeVisible()

    const email = `legal-e2e-${Date.now()}@test.local`
    await page.getByPlaceholder('邮箱地址').fill(email)
    await page.getByPlaceholder('密码（至少 6 位）').fill('legalpass123')

    const submit = page.getByRole('button', { name: '创建账号' })
    await expect(submit).toBeDisabled()

    await agreement.getByRole('checkbox').check()
    await expect(submit).toBeEnabled()

    const registerResponse = page.waitForResponse((response) =>
      response.url().includes('/api/auth/register') && response.request().method() === 'POST'
    )
    await submit.click()
    const result = await registerResponse
    const body = result.ok() ? '' : `: ${(await result.text()).slice(0, 500)}`
    await expect(result.status(), `register response status${body}`).toBe(201)
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 })
  })
})

test.describe('checkout consent gate', () => {
  async function merchantToken(request: APIRequestContext) {
    const login = await request.post(`${API_BASE}/api/auth/login`, {
      data: SEED_ACCOUNTS.merchant,
    })
    expect(login.ok()).toBeTruthy()
    return (await login.json()).accessToken as string
  }

  async function publishProduct(request: APIRequestContext, token: string, productId: number) {
    const published = await request.post(`${API_BASE}/api/merchant/products/${productId}/publish`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(published.ok(), await published.text()).toBeTruthy()
  }

  async function userToken(request: APIRequestContext) {
    const login = await request.post(`${API_BASE}/api/auth/login`, {
      data: SEED_ACCOUNTS.user,
    })
    expect(login.ok()).toBeTruthy()
    return (await login.json()).accessToken as string
  }

  test('pay button stays disabled until agreements are checked; purchase then succeeds with refund disclosure', async ({ page, request }) => {
    const token = await merchantToken(request)
    const created = await request.post(`${API_BASE}/api/merchant/products`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: `E2E法律勾选-${Date.now()}`,
        type: '邀请码',
        price: 1,
        deliveryMode: 'instant_fixed',
        fixedContent: 'https://example.com/legal-e2e',
        fixedContentType: 'url',
        stockMode: 'unlimited',
        imageUrl: '/assets/network.webp',
        images: ['/assets/network.webp'],
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const product = (await created.json()) as { id: number }
    await publishProduct(request, token, product.id)

    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto(`/product/${product.id}`)
    await page.getByRole('button', { name: '立即兑换' }).click()

    const modal = page.getByTestId('purchase-modal')
    // 退款披露条与勾选区随预览下发渲染。
    await expect(modal.getByTestId('refund-disclosure')).toBeVisible({ timeout: 10_000 })
    await expect(modal.getByTestId('refund-disclosure')).toContainText('非质量问题不支持退款')
    const agreement = modal.getByTestId('purchase-agreement')
    await expect(agreement).toBeVisible()
    await expect(agreement.getByRole('link', { name: '《服务协议》' })).toBeVisible()
    await expect(agreement.getByRole('link', { name: '《退款政策》' })).toBeVisible()

    const payButton = page.getByRole('button', { name: '确认支付' })
    await expect(payButton).toBeDisabled()

    await agreement.getByRole('checkbox').check()
    await expect(payButton).toBeEnabled()

    await payButton.click()
    await expect(page.getByTestId('success-delivery-link')).toBeVisible({ timeout: 10_000 })
  })

  test('enforce mode rejects agreement-less orders and registrations at the API boundary', async ({ request }) => {
    // 注册：缺协议确认 → 400 REQUIRED
    const register = await request.post(`${API_BASE}/api/auth/register`, {
      data: { email: `legal-api-${Date.now()}@test.local`, password: 'legalpass123' },
    })
    expect(register.status()).toBe(400)
    expect((await register.json()).error.code).toBe('LEGAL_AGREEMENT_REQUIRED')

    // 下单：缺协议确认 → 400 REQUIRED；携带当前版本 → 201
    const token = await merchantToken(request)
    const created = await request.post(`${API_BASE}/api/merchant/products`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: `E2E法律契约-${Date.now()}`,
        type: '邀请码',
        price: 1,
        deliveryMode: 'instant_fixed',
        fixedContent: 'https://example.com/legal-api',
        fixedContentType: 'url',
        stockMode: 'unlimited',
        imageUrl: '/assets/network.webp',
        images: ['/assets/network.webp'],
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const product = (await created.json()) as { id: number }
    await publishProduct(request, token, product.id)

    const buyer = await userToken(request)
    const rejected = await request.post(`${API_BASE}/api/orders`, {
      headers: { Authorization: `Bearer ${buyer}` },
      data: { productId: product.id },
    })
    expect(rejected.status()).toBe(400)
    expect((await rejected.json()).error.code).toBe('LEGAL_AGREEMENT_REQUIRED')

    // 当前版本从公开清单取（不硬编码版本号）。
    const documents = await request.get(`${API_BASE}/api/legal/documents`)
    expect(documents.ok()).toBeTruthy()
    const versions = Object.fromEntries(
      ((await documents.json()).documents as Array<{ slug: string; version: string }>).map(d => [d.slug, d.version]),
    )
    const accepted = await request.post(`${API_BASE}/api/orders`, {
      headers: { Authorization: `Bearer ${buyer}` },
      data: { productId: product.id, agreementVersions: { terms: versions.terms, refund: versions.refund } },
    })
    expect(accepted.status(), await accepted.text()).toBe(201)
  })
})
