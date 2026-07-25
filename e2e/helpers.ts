import { expect, Page } from '@playwright/test'

export const SEED_ACCOUNTS = {
  admin: { email: 'admin@moyuan.net', password: 'admin123' },
  user: { email: 'test@moyuan.net', password: 'user123' },
  merchant: { email: 'merchant@moyuan.net', password: 'merchant123' },
} as const

export const API_BASE = process.env.E2E_API_URL || 'http://localhost:3000'

/** 用 seed 账号通过登录页登录，登录成功后停在商城首页（/）。 */
export async function loginAs(page: Page, account: { email: string; password: string }) {
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
  await page.getByTestId('wizard-type').selectOption(options.type ?? '邀请码')
  await page.getByTestId('wizard-next').click()

  await page.getByTestId('wizard-price').fill(options.price ?? '1')
  await page.getByTestId('wizard-next').click()

  await page.getByRole('radio', { name: '外部链接' }).check()
  await page.getByTestId('fixed-content-input').fill(options.url)
  await expect(page.getByTestId('stock-mode-select')).toHaveValue('unlimited')
  await page.getByTestId('wizard-next').click()

  await page.getByTestId('wizard-publish').click()
  await expect(page.getByText('商品创建成功')).toBeVisible({ timeout: 10_000 })
}
