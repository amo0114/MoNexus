import { expect, test } from '@playwright/test'
import { API_BASE, SEED_ACCOUNTS, loginAs } from './helpers'

/**
 * M3-S3 announcements: public banner + admin CRUD.
 * Fixtures created via admin API; assertion via UI.
 */

const STRONG_TITLE = `E2E公告-${Date.now()}`

test.describe('M3-S3 announcements', () => {
  test('admin can create, publish, see banner, then delete', async ({ page, request }) => {
    await loginAs(page, SEED_ACCOUNTS.admin)
    const adminLogin = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: SEED_ACCOUNTS.admin.email, password: SEED_ACCOUNTS.admin.password },
    })
    expect(adminLogin.ok()).toBeTruthy()
    const token = (await adminLogin.json()).accessToken as string

    // Clean any stale row with same title from prior runs
    const listBefore = await request.get(`${API_BASE}/api/admin/announcements?pageSize=100`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(listBefore.ok()).toBeTruthy()
    const beforeItems = (await listBefore.json()).items as Array<{ id: number; title: string }>
    for (const it of beforeItems) {
      if (it.title === STRONG_TITLE) {
        await request.delete(`${API_BASE}/api/admin/announcements/${it.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      }
    }

    // Create via UI
    await page.goto('/admin')
    await page.getByRole('button', { name: '公告管理' }).click()
    await expect(page.getByTestId('admin-announcement-create')).toBeVisible({ timeout: 10_000 })

    // Clear any dismissed banner state from prior runs
    await page.evaluate(() => {
      const keys = Object.keys(localStorage).filter((k) => k.startsWith('announcement-dismissed:'))
      keys.forEach((k) => localStorage.removeItem(k))
    })

    await page.getByTestId('admin-announcement-create').click()
    await expect(page.getByTestId('admin-announcement-editor-dialog')).toBeVisible()

    await page.getByTestId('admin-announcement-title').fill(STRONG_TITLE)
    await page.getByTestId('admin-announcement-content').fill('E2E 公告正文，用于验证横幅与 CRUD 闭环。')
    await page.getByTestId('admin-announcement-priority').fill('500')
    // Starts at defaults to now; status defaults draft → switch to published
    await page.getByTestId('admin-announcement-status').selectOption('published')
    // Ensure no end-time checkbox is checked (长期 banner ring-fences the assertion that the banner appears)
    const endsCheckbox = page.locator('input[type="checkbox"]').first()
    if (await endsCheckbox.isChecked()) {
      await endsCheckbox.uncheck()
    }
    await page.getByTestId('admin-announcement-submit').click()
    await expect(page.getByText('已创建公告')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('admin-announcement-editor-dialog')).toBeHidden({ timeout: 10_000 })

    // Row should appear in admin table
    const row = page.locator('tr', { hasText: STRONG_TITLE }).first()
    await expect(row).toBeVisible({ timeout: 10_000 })

    // Navigate to home — banner should appear because priority 500 beats other drafted fixtures
    await page.goto('/')
    await expect(page.getByText(STRONG_TITLE, { exact: false })).toBeVisible({ timeout: 10_000 })

    // Cleanup via admin API (faster than UI delete, avoids flake on confirm dialog)
    const listAfter = await request.get(`${API_BASE}/api/admin/announcements?pageSize=100`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(listAfter.ok()).toBeTruthy()
    const afterItems = (await listAfter.json()).items as Array<{ id: number; title: string }>
    const target = afterItems.find((it) => it.title === STRONG_TITLE)
    expect(target, 'announcement row should exist after UI create').toBeTruthy()
    if (target) {
      const del = await request.delete(`${API_BASE}/api/admin/announcements/${target.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(del.ok()).toBeTruthy()
    }
  })
})
