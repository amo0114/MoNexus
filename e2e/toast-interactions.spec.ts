import { expect, test } from '@playwright/test'

/**
 * The swipe-to-dismiss gesture is mounted on the card. This regression test
 * uses a native touch-pointer click on the close button so card-level pointer
 * capture cannot silently retarget the click away from the button.
 */
test.describe('toast interactions', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  })

  test('close control works with touch input', async ({ page }) => {
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
})

test.describe('desktop toast timing', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('auto-dismiss is not paused when a toast appears below a stationary mouse', async ({ page }) => {
    await page.route('**/api/config/registry', (route) => route.fulfill({ json: {} }))

    await page.goto('/reset-password/test-token')
    await page.getByPlaceholder('新密码', { exact: true }).fill('abcdef')
    await page.getByPlaceholder('再次输入新密码').fill('abcdefg')

    // A DOM click deliberately keeps the pointer in the desktop toast lane.
    // Browsers emit pointerenter when the card animates in beneath it; that must
    // not freeze the dismissal timer.
    await page.mouse.move(1100, 680)
    await page.getByRole('button', { name: '重置密码' }).evaluate((button: HTMLButtonElement) => button.click())

    const toast = page.locator('[data-toast-card]')
    await expect(toast).toContainText('两次输入的密码不一致')
    await expect(toast).toBeHidden({ timeout: 6_000 })
  })
})
