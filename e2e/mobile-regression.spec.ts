import { expect, test } from '@playwright/test'
import { loginAs, SEED_ACCOUNTS } from './helpers'

/**
 * 移动端回归：320px 视口 + 触摸。
 * 覆盖 R0–R6 评审发现的三类移动端 P1：
 *  1) 导航栏汉堡在 320px 完整可见且可打开抽屉（此前被裁出屏幕）
 *  2) 图表切换更短数据范围不崩溃（此前 hoveredIndex 越界进 ErrorBoundary）
 *  3) 图表首次触摸即选中 tooltip（此前合成 mouseenter + click toggle 相互抵消）
 */
test.use({
  viewport: { width: 320, height: 700 },
  hasTouch: true,
})

test.describe('mobile 320px', () => {
  test('hamburger is fully visible and drawer exposes workbench + theme row', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.merchant)

    // 汉堡按钮完整落在 320px 视口内（此前实测位于 x=349.7 完全不可见）
    const trigger = page.getByRole('button', { name: '打开导航菜单' })
    await expect(trigger).toBeVisible()
    const box = await trigger.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(320)
    expect(box!.height).toBeGreaterThanOrEqual(40)

    // 真实触摸打开抽屉
    await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2)

    // 商家可见工作台入口
    await expect(page.getByRole('button', { name: '商家后台' })).toBeVisible()
    // 主题行：分段控件三个选项均为 ≥40px 触控目标
    const themeRow = page.getByText('主题', { exact: true })
    await expect(themeRow).toBeVisible()
    const themeButtons = page.getByRole('radio')
    await expect(themeButtons).toHaveCount(3)
    for (let i = 0; i < 3; i++) {
      const tb = await themeButtons.nth(i).boundingBox()
      expect(tb!.width).toBeGreaterThanOrEqual(40)
      expect(tb!.height).toBeGreaterThanOrEqual(40)
    }

    // 抽屉内可导航到商家后台（移动端工作台的唯一入口）
    await page.getByRole('button', { name: '商家后台' }).click()
    await expect(page).toHaveURL(/\/merchant/)
  })

  test('trend chart survives range switches and selects a point on first tap', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant/dashboard')
    await expect(page.getByRole('button', { name: '近 30 天' })).toBeVisible({ timeout: 10_000 })

    // P1 回归：切换更短数据范围不得崩溃（此前进入全局 ErrorBoundary「出错了」）
    await page.getByRole('button', { name: '近 30 天' }).click()
    await page.getByRole('button', { name: '近 7 天' }).click()
    await expect(page.getByText('出错了')).toHaveCount(0)
    await page.getByRole('button', { name: '近 90 天' }).click()
    await expect(page.getByText('出错了')).toHaveCount(0)

    const svg = page.locator('svg').first()
    // 空数据时为空态卡片，无 svg；有数据时继续触控断言
    if ((await svg.count()) > 0) {
      // P1 回归：viewBox 不再带 preserveAspectRatio="none"（圆点不再压扁）
      await expect(svg).not.toHaveAttribute('preserveAspectRatio', 'none')

      const point = svg.locator('g').first()
      if ((await point.count()) > 0) {
        const pb = await point.boundingBox()
        if (pb && pb.x >= 0) {
          // P1 回归：首次真实触摸立即出现 tooltip（不再被合成事件抵消）
          await page.touchscreen.tap(pb.x + pb.width / 2, pb.y + pb.height / 2)
          await expect(page.getByText(/积分: \d+/)).toBeVisible()
          // 点背景清除选中
          await page.touchscreen.tap(160, 600)
          await expect(page.getByText(/积分: \d+/)).toHaveCount(0)
        }
      }
    }
  })
})
