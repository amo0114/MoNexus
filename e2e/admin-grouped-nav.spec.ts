import { expect, test } from '@playwright/test'

test.describe('Admin Grouped Navigation Mobile Verification @375px', () => {
  test.use({ viewport: { width: 375, height: 667 }, hasTouch: true })

  test('375px mobile viewport: verifies breakpoint, mobile trigger, drawer visibility, scroll lock, and touch targets', async ({
    page,
  }) => {
    // Intercept auth and admin endpoints to ensure deterministic execution
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          user: { id: 1, email: 'admin@moyuan.net', role: 'admin', nickname: '系统管理员' },
        },
      }),
    )
    await page.route('**/api/admin/stats', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: { users: 10, orders: 20, totalPoints: 100 },
      }),
    )
    await page.route('**/api/admin/reports/offers', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: { items: [] },
      }),
    )
    await page.route('**/api/admin/merchants**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: { items: [], total: 0, page: 1, pageSize: 20 },
      }),
    )

    // Seed admin auth state in browser storage using the app's zustand persist key
    await page.addInitScript(() => {
      localStorage.setItem(
        'monexus-auth',
        JSON.stringify({
          state: {
            user: { id: 1, email: 'admin@moyuan.net', role: 'admin', nickname: '系统管理员' },
            isLoggedIn: true,
            accessToken: 'fake-admin-token',
          },
          version: 0,
        }),
      )
    })

    await page.goto('/admin')

    // 1. Breakpoint verification: desktop nav is hidden, mobile trigger is visible
    const desktopNav = page.locator('nav[aria-label="管理后台导航"]')
    await expect(desktopNav).toBeHidden()

    const trigger = page.getByTestId('admin-mobile-nav-trigger')
    await expect(trigger).toBeVisible()
    await expect(trigger).toContainText('业务概览')
    await expect(trigger).toContainText('数据仪表盘')

    // 2. Open drawer and verify drawer visibility
    await trigger.click()
    const drawer = page.getByTestId('admin-mobile-nav-drawer')
    await expect(drawer).toBeVisible()

    // 3. Body scroll lock verification: Radix Dialog applies data-scroll-locked attribute
    const body = page.locator('body')
    await expect(body).toHaveAttribute('data-scroll-locked', '1')

    // 4. Verify all 5 groups exist in mobile drawer
    await expect(drawer.getByText('业务概览')).toBeVisible()
    await expect(drawer.getByText('商家与结算')).toBeVisible()
    await expect(drawer.getByText('商品与交付')).toBeVisible()
    await expect(drawer.getByText('用户与风控')).toBeVisible()
    await expect(drawer.getByText('系统与运维')).toBeVisible()

    // 5. Verify touch targets meet minimum 44px
    const merchantBtn = page.getByTestId('admin-mobile-nav-item-merchants')
    await expect(merchantBtn).toBeVisible()
    const box = await merchantBtn.boundingBox()
    expect(box!.height).toBeGreaterThanOrEqual(44)

    // 6. Select an item in the drawer: drawer closes, scroll lock released, trigger updates
    await merchantBtn.click()
    await expect(drawer).toBeHidden()
    await expect.poll(() => body.getAttribute('data-scroll-locked')).toBeNull()
    await expect(trigger).toContainText('商家与结算')
    await expect(trigger).toContainText('商家管理')
  })
})
