import { expect, test } from '@playwright/test'

test('fresh visits default to the 墨韵 theme while preserving explicit choices elsewhere', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem('theme')
  })

  await page.goto('/login')

  // This attribute is set by index.html before React hydrates, then retained
  // by ThemeProvider. Checking it here protects both first paint and runtime.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'ink')
})
