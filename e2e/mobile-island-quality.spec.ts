import { test, expect, type Page } from '@playwright/test'
import axe from 'axe-core'
import { createMockAccessToken } from './auth-fixtures'

const user = { id: 9910, email: 'island-quality@example.test', role: 'user', nickname: '质量检查', status: 'active', points: 100, merchant: null, emailVerified: '2026-01-01' }
const notifications = Array.from({ length: 12 }, (_, i) => ({
  id: i + 1, relatedOrderId: i + 101, eventType: 'order.delivered_buyer', category: 'order',
  title: `订单 ${i + 101} 已交付`, body: '交付结果可在订单记录中查看', level: 'info', status: 'unread',
  readAt: null, createdAt: '2026-10-06T00:00:00Z', deeplink: `/orders?focus=${i + 101}`,
}))

async function prepare(page: Page) {
  const writes: string[] = []
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(({ user, accessToken }) => {
    localStorage.setItem('monexus-auth', JSON.stringify({ state: { user, accessToken, isLoggedIn: true }, version: 0 }))
  }, { user, accessToken: createMockAccessToken(user) })
  await page.route('**/api/**', route => {
    const p = new URL(route.request().url()).pathname
    if (!p.startsWith('/api/')) return route.fallback()
    if (route.request().method() !== 'GET') writes.push(p)
    if (p === '/api/auth/me') return route.fulfill({ json: user })
    if (p === '/api/notifications') return route.fulfill({ json: { notifications, nextCursor: null, hasMore: false } })
    if (p.endsWith('/unread-count')) return route.fulfill({ json: { count: 12 } })
    if (p.endsWith('/attention-count')) return route.fulfill({ json: { count: 0 } })
    if (p === '/api/config/registry') return route.fulfill({ json: { productTypes: [], productCategories: [], capabilities: {} } })
    if (p === '/api/announcements' || p === '/api/points/history') return route.fulfill({ json: [] })
    if (p === '/api/orders') return route.fulfill({ json: [] })
    if (p === '/api/points/checkin/status') return route.fulfill({ json: { hasCheckedIn: true } })
    if (p === '/api/points/tier') return route.fulfill({ json: { tier: 'bronze', label: '青铜', tone: 'neutral', lifetimeEarnedPoints: 0, bonusBps: 0, thresholds: { silver: 100, gold: 500, platinum: 1000 }, nextTier: 'silver', pointsToNextTier: 100 } })
    if (p === '/api/products') return route.fulfill({ json: { items: [], hasMore: false, nextCursor: null } })
    return route.fulfill({ status: 404, json: { error: { message: 'isolated UI fixture' } } })
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: '搜索', exact: true })).toBeVisible()
  return { writes, errors }
}

// Imports are served only by the isolated Vite test server; no production hook is added.
async function notify(page: Page, title: string, subtitle = '') {
  await page.evaluate(async ({ title, subtitle, modulePath }) => {
    const { useAppStore } = await import(modulePath)
    useAppStore.getState().triggerIslandActivity({
      kind: 'notification', priority: 'completion', groupKey: 'quality', title, subtitle,
      actionLabel: '查看操作记录', onAction: () => useAppStore.getState().setPointsHistoryOpen(true),
    })
  }, { title, subtitle, modulePath: '/src/stores/appStore.ts' })
}

for (const width of [320, 390]) {
  test.describe(`quality ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: true })

    for (const dark of [false, true]) {
      test(`200% text, long names, 44px targets and accessible controls (${dark ? 'dark' : 'light'})`, async ({ page }, testInfo) => {
        const { errors } = await prepare(page)
        await page.evaluate(dark => {
          document.documentElement.style.fontSize = '32px'
          document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
          document.documentElement.classList.toggle('dark', dark)
        }, dark)
        await notify(page, '资源调整完成，实际剩余 128 个', `长规格名称${'VeryLongProductNameWithoutSpaces'.repeat(8)}`)
        const panel = page.getByTestId('action-island-notice')
        await expect(panel).toBeVisible()
        await expect(panel).toHaveCSS('opacity', '1')
        const box = (await panel.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(width)
        expect(box.y + box.height).toBeLessThanOrEqual(844)
        expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
        for (const name of ['收起通知', '查看操作记录']) {
          const button = panel.getByRole('button', { name })
          const target = (await button.boundingBox())!
          expect(target.height).toBeGreaterThanOrEqual(44)
          expect(target.width).toBeGreaterThanOrEqual(44)
        }
        await page.addScriptTag({ content: axe.source })
        const violations = await page.evaluate(async () => {
          const result = await (window as any).axe.run('[data-testid="action-island-notice"]', {
            runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
          })
          return result.violations.map((v: { id: string; impact: string }) => ({ id: v.id, impact: v.impact }))
        })
        expect(violations).toEqual([])
        await page.screenshot({ path: testInfo.outputPath(`large-text-${width}-${dark ? 'dark' : 'light'}.png`) })
        const action = panel.getByRole('button', { name: '查看操作记录' })
        await action.focus()
        await expect(action).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(panel).toHaveCount(0)
        expect(errors).toEqual([])
      })
    }

    test('a minute behind search/modal preserves queued results; omitted notifications stay unread in the center', async ({ page }) => {
      test.setTimeout(60_000)
      const { writes, errors } = await prepare(page)
      await page.clock.install()
      await page.getByRole('button', { name: '搜索', exact: true }).click()
      await expect(page.getByTestId('mobile-search-island')).toHaveAttribute('data-open', 'true')
      await notify(page, '先完成的操作')
      await page.evaluate(async modulePath => {
        const { useAppStore } = await import(modulePath)
        useAppStore.getState().triggerIslandActivity({ kind: 'notification', priority: 'completion', title: '排队的操作', actionLabel: '查看记录', onAction: () => {} })
      }, '/src/stores/appStore.ts')
      await page.clock.runFor(60_000)
      await expect(page.getByTestId('action-island-notice')).toHaveCount(0)
      await page.getByRole('button', { name: '取消搜索' }).click()
      const panel = page.getByTestId('action-island-notice')
      await expect(panel).toContainText('先完成的操作')
      await panel.getByRole('button', { name: '收起通知' }).click()
      await expect(panel).toContainText('排队的操作')
      // A real Dialog drives modalDepth; the current and queued events both wait.
      await page.getByTestId('tab-bar-points').click()
      const sheet = page.getByTestId('points-history-sheet')
      await expect(sheet).toBeVisible()
      await page.evaluate(async modulePath => {
        const { useAppStore } = await import(modulePath)
        useAppStore.getState().triggerIslandActivity({ kind: 'notification', priority: 'completion', title: '弹窗期间完成' })
      }, '/src/stores/appStore.ts')
      await page.clock.runFor(60_000)
      await expect(panel).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(sheet).toHaveCount(0)
      await expect(panel).toContainText('排队的操作')
      await panel.getByRole('button', { name: '收起通知' }).click()
      await expect(panel).toContainText('弹窗期间完成')
      await panel.getByRole('button', { name: '收起通知' }).click()

      await page.evaluate(async ({ notifications, modulePath }) => {
        const { showOrderNotificationIsland } = await import(modulePath)
        for (const n of notifications) showOrderNotificationIsland(n, 'info', () => {})
      }, { notifications, modulePath: '/src/realtime/notificationIsland.ts' })
      // Focus/hover deliberately pause the active notice. Move both away to test expiry.
      await page.getByTestId('tab-bar-profile').focus()
      await page.mouse.move(2, 800)
      await page.clock.runFor(40_000)
      await expect(panel).toHaveCount(0)
      expect(writes).toEqual([])
      await page.goto('/notifications')
      await expect(page.getByTestId('notifications-list').locator('li')).toHaveCount(12)
      for (const id of [1, 2, 12]) await expect(page.getByTestId(`notification-item-${id}`)).toContainText('未读')
      expect(writes).toEqual([])
      expect(errors).toEqual([])
    })
  })
}
