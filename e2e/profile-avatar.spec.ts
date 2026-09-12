import { test, expect } from '@playwright/test'
import { loginAs, SEED_ACCOUNTS } from './helpers'

test('a preset avatar persists across refresh and appears in desktop and mobile navigation', async ({ page }) => {
  await loginAs(page, SEED_ACCOUNTS.user)
  await page.goto('/profile')
  await page.getByRole('button', { name: '选择头像', exact: true }).click()
  await page.getByRole('tab', { name: '蜀汉' }).click()
  await page.getByRole('button', { name: '选择赵云', exact: true }).click()
  const url = '/assets/avatars/three-kingdoms/v2.3/shu-zhao-yun.webp'
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/auth/me') && r.request().method() === 'PATCH')
  await page.getByRole('button', { name: '使用此头像' }).click()
  expect((await saved).status()).toBe(200)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.reload()
  const portrait = page.getByTestId('avatar-edit').locator('img')
  await expect(portrait).toHaveAttribute('src', url)
  await expect(portrait).toHaveJSProperty('complete', true)
  expect(await portrait.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: '个人中心', exact: true }).locator('img')).toHaveAttribute('src', url)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.getByRole('button', { name: '打开导航菜单' }).click()
  await expect(page.getByRole('dialog').locator(`img[src="${url}"]`)).toBeVisible()
  await page.getByRole('button', { name: '关闭菜单' }).click()
  await page.getByRole('button', { name: '清除头像' }).click()
  await expect(page.getByTestId('avatar-edit').locator('img')).toHaveCount(0)
})
