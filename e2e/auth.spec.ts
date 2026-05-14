import { expect, test } from '@playwright/test'

test('register a new user, login, see profile', async ({ page }) => {
  const email = `e2e+${Date.now()}@test.local`
  const password = 'TestPass123!'

  await page.goto('/login')
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  })
  await page.getByRole('button', { name: '没有账号？注册新账号' }).click()
  await page.getByPlaceholder('邮箱地址').fill(email)
  await page.getByPlaceholder('密码（至少 6 位）').fill(password)
  await page.getByRole('button', { name: '注册账号' }).click()

  await expect(page).toHaveURL(/\/$/)
  await page.goto('/profile')
  await expect(page.getByText('我的可用积分')).toBeVisible({ timeout: 10_000 })

  const persistedEmail = await page.evaluate(() => {
    const raw = localStorage.getItem('monexus-auth')
    return raw ? JSON.parse(raw).state?.user?.email : undefined
  })
  expect(persistedEmail).toBe(email)

  await page.getByRole('button', { name: /退出当前账号/ }).click()
  await expect(page).toHaveURL(/\/login$/)

  await page.getByPlaceholder('邮箱地址').fill(email)
  await page.getByPlaceholder('密码（至少 6 位）').fill(password)
  await page.getByRole('button', { name: '登录' }).click()

  await expect(page).toHaveURL(/\/$/)
  await page.goto('/profile')
  await expect(page.getByText('我的可用积分')).toBeVisible({ timeout: 10_000 })
})
