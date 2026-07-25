import { expect, test } from '@playwright/test'
import { API_BASE, SEED_ACCOUNTS, loginAs } from './helpers'

/**
 * Announcement center: admin CRUD plus user-facing delivery states.
 * Fixtures created via admin API; assertion via UI.
 */

const STRONG_TITLE = `E2E公告-${Date.now()}`
const IMPORTANT_TITLE = `E2E重要公告-${Date.now()}`

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

    // Clear any normal-notice display state from a prior run.
    await page.evaluate(() => {
      const keys = Object.keys(localStorage).filter((k) => k.startsWith('monexus:announcement:notice:'))
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

    // A Dialog backdrop is a global visual layer, not just main-content dimming:
    // it must sit above the sticky nav/footer chrome and below dialog content.
    await page.getByTestId('announcement-banner-open').click()
    await expect(page.getByTestId('announcement-center')).toBeVisible()
    const layers = await page.evaluate(() => {
      const zIndex = (selector: string) => {
        const element = document.querySelector(selector)
        if (!element) throw new Error(`missing layer: ${selector}`)
        return Number.parseInt(getComputedStyle(element).zIndex, 10)
      }
      return {
        footer: zIndex('footer'),
        nav: zIndex('nav'),
        overlay: zIndex('.modal-overlay'),
        dialog: zIndex('[data-testid="announcement-center"]'),
      }
    })
    expect(layers.overlay).toBeGreaterThan(layers.nav)
    expect(layers.overlay).toBeGreaterThan(layers.footer)
    expect(layers.dialog).toBeGreaterThan(layers.overlay)

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

  test('mobile announcement entry has a red dot and important notices persist as read after opening details', async ({ page, request }) => {
    await page.setViewportSize({ width: 320, height: 700 })
    await loginAs(page, SEED_ACCOUNTS.user)

    const adminLogin = await request.post(`${API_BASE}/api/auth/login`, {
      data: { email: SEED_ACCOUNTS.admin.email, password: SEED_ACCOUNTS.admin.password },
    })
    expect(adminLogin.ok()).toBeTruthy()
    const adminToken = (await adminLogin.json()).accessToken as string

    const created = await request.post(`${API_BASE}/api/admin/announcements`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: {
        title: IMPORTANT_TITLE,
        content: '这是一段足够长的移动端公告正文。用户应在公告中心完整阅读，横幅只承担紧凑提醒职责。',
        audience: 'user',
        priority: 900,
        presentation: 'important',
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        status: 'published',
      },
    })
    expect(created.ok()).toBeTruthy()
    const createdAnnouncement = await created.json() as { id: number }

    try {
      await page.reload()
      await expect(page.getByTestId('announcement-banner')).toContainText(IMPORTANT_TITLE, { timeout: 10_000 })

      const mobileTrigger = page.getByTestId('announcement-center-mobile-trigger')
      await expect(mobileTrigger).toBeVisible()
      await expect(mobileTrigger).toHaveAttribute('aria-label', /1 条未读/)
      const box = await mobileTrigger.boundingBox()
      expect(box?.width).toBeGreaterThanOrEqual(40)
      expect(box?.height).toBeGreaterThanOrEqual(40)

      await page.getByTestId('announcement-banner-open').click()
      await expect(page.getByTestId('announcement-center')).toBeVisible()
      await expect(page.getByTestId(`announcement-item-${createdAnnouncement.id}`)).toContainText('移动端公告正文')
      await expect(page.getByTestId(`announcement-item-${createdAnnouncement.id}`)).toContainText('已读')

      await page.getByRole('button', { name: '关闭' }).click()
      await expect(page.getByTestId('announcement-banner')).toBeHidden()
      await mobileTrigger.click()
      await expect(page.getByTestId(`announcement-item-${createdAnnouncement.id}`)).toContainText('已读')
    } finally {
      await request.delete(`${API_BASE}/api/admin/announcements/${createdAnnouncement.id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    }
  })
})
