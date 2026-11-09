import { expect, test } from '@playwright/test'

test('logged-in user can claim daily check-in', async ({ page }) => {
  const email = `checkin+${Date.now()}@test.local`
  const password = 'TestPass123!'

  await page.goto('/login')
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  })
  await page.getByRole('button', { name: '没有账号？立即注册' }).click()
  await page.getByPlaceholder('邮箱地址').fill(email)
  await page.getByPlaceholder('密码（至少 8 位）').fill(password)
  await page.getByRole('button', { name: '创建账号' }).click()

  await expect(page).toHaveURL(/\/$/)
  await page.goto('/profile')

  const checkinButton = page.getByRole('button', { name: '签到打卡' })
  await expect(checkinButton).toBeVisible({ timeout: 10_000 })
  await checkinButton.click()

  await expect(page.getByRole('button', { name: '今日已打卡' })).toBeVisible({ timeout: 10_000 })

  // SPEC-ENGAGE-001：签到卡显示连签与月历，首页今日面板同步为已签到。
  const card = page.getByTestId('checkin-card')
  await expect(card).toContainText('已连续签到 1 天')
  await expect(card.getByTestId('checkin-calendar').locator('[data-checked]')).toHaveCount(1)

  await page.goto('/')
  const today = page.getByTestId('today-panel')
  await expect(today).toBeVisible({ timeout: 10_000 })
  await expect(today.getByRole('button', { name: '今日已签到' })).toBeDisabled()
})
