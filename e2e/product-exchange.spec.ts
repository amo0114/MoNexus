import { expect, test } from '@playwright/test'

test('exchange modal opens on product detail and can be cancelled', async ({ page }) => {
  await page.goto('/login')
  await page.addStyleTag({
    content: '*, *::before, *::after { animation: none !important; transition: none !important; }',
  })
  await page.getByPlaceholder('邮箱地址').fill('test@moyuan.net')
  await page.getByPlaceholder('密码（至少 6 位）').fill('user123')
  await page.getByRole('button', { name: '登录' }).click()

  await expect(page).toHaveURL(/\/$/)
  await page.goto('/product/2')

  await page.getByRole('button', { name: '立即兑换' }).click()

  const modalTitle = page.getByText('确认兑换')
  await expect(modalTitle).toBeVisible({ timeout: 10_000 })
  await expect(modalTitle).toBeInViewport()

  await page.getByRole('button', { name: '再想想' }).click()
  await expect(modalTitle).not.toBeVisible()
})
