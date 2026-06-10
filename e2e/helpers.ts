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
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 })
}
