import { expect, test } from '@playwright/test'

/**
 * The swipe-to-dismiss gesture is mounted on the card. This regression test
 * uses a native touch-pointer click on the close button so card-level pointer
 * capture cannot silently retarget the click away from the button.
 */
test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
})

test('toast close control works with touch input', async ({ page }) => {
  // App boot loads the public registry; the validation path below itself is
  // fully client-side, so keep this test independent of the local API stack.
  await page.route('**/api/config/registry', (route) => route.fulfill({ json: {} }))

  await page.goto('/reset-password/test-token')
  await page.getByPlaceholder('新密码', { exact: true }).fill('abcdef')
  await page.getByPlaceholder('再次输入新密码').fill('abcdefg')
  await page.getByRole('button', { name: '重置密码' }).click()

  const toast = page.locator('[data-toast-card]')
  await expect(toast).toContainText('两次输入的密码不一致')
  await toast.getByRole('button', { name: '关闭提示' }).click()
  await expect(toast).toBeHidden()
})
