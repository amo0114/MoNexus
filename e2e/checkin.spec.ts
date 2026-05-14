import { expect, test } from '@playwright/test'

test('logged-in user can claim daily check-in', async ({ page }) => {
  const email = `checkin+${Date.now()}@test.local`
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

  const checkinButton = page.getByRole('button', { name: '每日打卡' })
  await expect(checkinButton).toBeVisible({ timeout: 10_000 })
  await checkinButton.click()

  await expect(page.getByRole('button', { name: '今日已打卡' })).toBeVisible({ timeout: 10_000 })
})
