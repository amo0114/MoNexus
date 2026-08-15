import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { createRequire } from 'node:module'

export const SEED_ACCOUNTS = {
  admin: { email: 'admin@moyuan.net', password: 'admin123' },
  user: { email: 'test@moyuan.net', password: 'user123' },
  merchant: { email: 'merchant@moyuan.net', password: 'merchant123' },
} as const

export const API_BASE = process.env.E2E_API_URL || 'http://localhost:3000'
export const E2E_PRODUCT_COVER = '/assets/network.webp'

type SeedAccount = { email: string; password: string }

type AuthenticatedSession = {
  user: Record<string, unknown>
  accessToken: string
}

type MfaLoginChallenge = {
  status: 'mfa_enrollment_required' | 'mfa_required'
  challengeId: string
}

const serverRequire = createRequire(new URL('../server/package.json', import.meta.url))
const { TOTP } = serverRequire('otpauth') as {
  TOTP: new (options: Record<string, unknown>) => { generate: (options: { timestamp: number }) => string }
}

const TEST_TOTP_FACTOR = /^[A-Z2-7]{32}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function authUrl(base: string, path: string) {
  return base ? `${base}/api/auth${path}` : `/api/auth${path}`
}

function seededAdminTotpFactor() {
  const factor = process.env.E2E_ADMIN_MFA_TOTP_SECRET
  if (!factor || !TEST_TOTP_FACTOR.test(factor)) {
    throw new Error('Default E2E administrator MFA factor is not configured')
  }
  return factor
}

function currentTotp(factor: string) {
  return new TOTP({
    issuer: 'MoNexus',
    label: 'administrator',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: factor,
  }).generate({ timestamp: Date.now() })
}

function authenticatedSession(body: unknown): AuthenticatedSession {
  if (!isRecord(body) || !isRecord(body.user) || typeof body.accessToken !== 'string' || body.accessToken.length === 0) {
    throw new Error('Authentication response did not create a usable session')
  }
  return { user: body.user, accessToken: body.accessToken }
}

function mfaChallenge(body: unknown): MfaLoginChallenge {
  if (
    !isRecord(body)
    || (body.status !== 'mfa_enrollment_required' && body.status !== 'mfa_required')
    || typeof body.challengeId !== 'string'
    || body.challengeId.length === 0
  ) {
    throw new Error('Administrator MFA challenge response is invalid')
  }
  return { status: body.status, challengeId: body.challengeId }
}

async function verifySeededAdminMfa(request: APIRequestContext, account: SeedAccount, apiBase: string): Promise<AuthenticatedSession> {
  const login = await request.post(authUrl(apiBase, '/login'), { data: account })
  await expect(login.status(), 'administrator password login response status').toBe(202)
  const challenge = mfaChallenge(await login.json())
  if (challenge.status !== 'mfa_required') {
    throw new Error('Default E2E seed administrator is not MFA-enrolled')
  }
  const verification = await request.post(authUrl(apiBase, '/mfa/verify'), {
    data: { challengeId: challenge.challengeId, method: 'totp', code: currentTotp(seededAdminTotpFactor()) },
  })
  await expect(verification.status(), 'administrator MFA verification response status').toBe(200)
  const issued = authenticatedSession(await verification.json())
  const profile = await request.get(authUrl(apiBase, '/me'), {
    headers: { Authorization: `Bearer ${issued.accessToken}` },
  })
  await expect(profile.status(), 'administrator MFA profile response status').toBe(200)
  const user = await profile.json()
  if (!isRecord(user)) throw new Error('Administrator MFA profile response is invalid')
  return { accessToken: issued.accessToken, user }
}

/**
 * Creates a normal server-issued E2E session. The CI-only seed pre-enrolls
 * the administrator, so it follows the public MFA verify state machine while
 * non-admin accounts retain the existing 200 path.
 */
export async function loginAsApi(request: APIRequestContext, account: SeedAccount): Promise<AuthenticatedSession> {
  if (account.email === SEED_ACCOUNTS.admin.email) {
    return verifySeededAdminMfa(request, account, API_BASE)
  }

  const login = await request.post(authUrl(API_BASE, '/login'), { data: account })
  await expect(login.status(), 'login response status').toBe(200)
  return authenticatedSession(await login.json())
}

/**
 * Publish a merchant-owned fixture through the real readiness gate.
 *
 * Product creation is intentionally draft-only.  E2E fixtures that exercise
 * public detail/checkout must therefore provide the canonical cover and use
 * the publish endpoint instead of relying on the old implicit-active behavior.
 */
export async function publishMerchantProduct(
  request: APIRequestContext,
  token: string,
  productId: number,
) {
  const cover = await request.put(`${API_BASE}/api/merchant/products/${productId}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { imageUrl: E2E_PRODUCT_COVER, images: [E2E_PRODUCT_COVER] },
  })
  expect(cover.ok(), await cover.text()).toBeTruthy()

  const published = await request.post(`${API_BASE}/api/merchant/products/${productId}/publish`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(published.ok(), await published.text()).toBeTruthy()
}

async function loginAdminPage(page: Page, account: SeedAccount) {
  // page.request shares the BrowserContext cookie jar. Open the same origin
  // first, then use its relative Vite-proxied API path rather than API_BASE.
  await page.goto('/login')
  const session = await verifySeededAdminMfa(page.request, account, '')
  await page.evaluate((authenticated: AuthenticatedSession) => {
    localStorage.setItem('monexus-auth', JSON.stringify({
      state: {
        user: authenticated.user,
        accessToken: authenticated.accessToken,
        isLoggedIn: true,
      },
      version: 0,
    }))
  }, session)
  await page.goto('/')
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 })
}

/** 用 seed 账号通过登录页登录，登录成功后停在商城首页（/）。 */
export async function loginAs(page: Page, account: SeedAccount) {
  if (account.email === SEED_ACCOUNTS.admin.email) {
    await loginAdminPage(page, account)
    return
  }

  await page.goto('/login')
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  })
  await page.getByPlaceholder('邮箱地址').fill(account.email)
  await page.getByPlaceholder('密码（至少 6 位）').fill(account.password)
  const loginResponse = page.waitForResponse((response) =>
    response.url().includes('/api/auth/login') && response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: '登录' }).click()
  const loginResult = await loginResponse
  const loginBody = loginResult.ok() ? '' : `: ${(await loginResult.text()).slice(0, 500)}`
  await expect(loginResult.status(), `login response status${loginBody}`).toBe(200)
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 })
}

/**
 * 走分步创建页发布一个「固定内容直发 · 外部链接」商品。
 * P2 起商品创建不再走弹窗，统一使用 /merchant/products/new 向导。
 */
export async function createInstantFixedProductViaWizard(
  page: Page,
  options: { name: string; url: string; price?: string; type?: string }
) {
  await page.goto('/merchant/products/new')
  await expect(page.getByTestId('product-create-wizard')).toBeVisible({ timeout: 10_000 })

  await page.getByTestId('template-digital_content').click()
  await page.getByTestId('wizard-next').click()

  await page.getByTestId('wizard-name').fill(options.name)
  await page.getByTestId('product-image-url-input').fill(E2E_PRODUCT_COVER)
  await page.getByTestId('product-image-url-hotlink').click()
  const category = page.getByTestId('product-category-select')
  if (!(await category.inputValue())) {
    await category.selectOption({ index: 1 })
  }
  await page.getByTestId('wizard-next').click()

  await page.getByTestId('wizard-price').fill(options.price ?? '1')
  await page.getByTestId('wizard-next').click()

  await page.getByRole('radio', { name: '外部链接' }).check()
  await page.getByTestId('fixed-content-input').fill(options.url)
  await expect(page.getByTestId('stock-mode-select')).toHaveValue('unlimited')
  await page.getByTestId('wizard-next').click()

  await page.getByTestId('wizard-save-draft').click()
  await expect(page.getByTestId('wizard-step-availability')).toBeVisible({ timeout: 10_000 })
  await page.getByTestId('wizard-next').click()
  await expect(page.getByTestId('publication-ready')).toBeVisible({ timeout: 10_000 })
  await page.getByTestId('publication-publish').click()
  await expect(page).toHaveURL(/\/merchant(?:\/|$)/, { timeout: 10_000 })
}
