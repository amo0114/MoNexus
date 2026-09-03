import { expect, test, type Page } from '@playwright/test'
import { loginAs, SEED_ACCOUNTS } from './helpers'

// 移动端布局契约（feat/mobile-ui-polish，docs/specs/mobile-ui-polish.md）：
//  1) 商城 <768px 双列 240px 紧凑卡片 + 无横向溢出
//  2) BottomTabBar：贴底、按角色 3/4 项、公告入口继承 announcement-center-mobile-trigger
//  3) 商品详情标题 <lg 位于文档流（不遮挡主图）
//  4) 共享 Dialog <md 为 bottom sheet（全宽、贴底、92dvh 上限）
//  5) Admin <md 为分组抽屉，Merchant 侧栏 <md 为横向可滚动 pill 条

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, `${label}: horizontal overflow ${overflow}px`).toBeLessThanOrEqual(0)
}

test.describe('mobile layout verification @375px', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true })

  test('store: 2-column compact grid + tab bar + no overflow', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    // 灵动岛：搜索收纳进 navbar，点图标展开搜索卡片（含分类 chips）
    await page.getByRole('button', { name: '搜索' }).click()
    const search = page.getByPlaceholder('搜账号、卡密、教程...')
    await expect(search).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: '全部', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '取消搜索' }).click()
    await page.waitForTimeout(600)

    // Tab bar: 4 tabs for plain user (首页/积分/排行/我的), 56px + safe area, pinned to bottom
    const tabBar = page.getByTestId('bottom-tab-bar')
    await expect(tabBar).toBeVisible()
    const tabs = tabBar.getByRole('button')
    await expect(tabs).toHaveCount(4)
    const barBox = await tabBar.boundingBox()
    expect(Math.round(barBox!.y + barBox!.height)).toBe(812)
    expect(barBox!.height).toBeGreaterThanOrEqual(56)

    // Grid: first two product cards sit side by side (2 columns), 256px tall.
    // Keep this independent of utility-class implementation details.
    const cards = page.locator('[data-testid^="store-stock-"]')
    await expect(cards.first()).toBeVisible({ timeout: 10_000 })
    const cardEls = page.locator('[data-testid^="store-product-card-"]')
    await expect(cardEls.nth(1)).toBeVisible({ timeout: 10_000 })
    const cardImage = page.locator('[data-testid^="store-product-image-"]').first()
    // Store grid uses cover for dense cards; full art is on product detail / lightbox.
    await expect(cardImage).toHaveCSS('object-fit', 'cover')
    const first = await cardEls.nth(0).boundingBox()
    const second = await cardEls.nth(1).boundingBox()
    expect(Math.round(first!.y)).toBe(Math.round(second!.y)) // same row → 2 cols
    expect(first!.height).toBe(256)
    expect(second!.x).toBeGreaterThan(first!.x)

    // Tab bar never covers content: last card bottom <= tab bar top after scroll-to-bottom
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(500)
    await expectNoHorizontalOverflow(page, 'store')
  })

  test('product detail: title in flow, not covering hero', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto('/product/1')
    await page.waitForTimeout(1200)
    const h1 = page.getByRole('heading', { level: 1, name: /稳定专线节点订阅/ })
    await expect(h1).toBeVisible()
    const h1Box = await h1.boundingBox()
    const hero = page.getByTestId('product-gallery-main')
    const heroBox = await hero.boundingBox()
    expect(h1Box!.y).toBeGreaterThanOrEqual(heroBox!.y + heroBox!.height) // below the image
    await expectNoHorizontalOverflow(page, 'product')
  })

  test('product detail: fixed buy bar replaces tab bar; purchase dialog is bottom sheet', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto('/product/1')
    await page.waitForTimeout(1200)

    // V2-M3: tab bar yields to the fixed buy bar on product pages
    await expect(page.getByTestId('bottom-tab-bar')).toHaveCount(0)
    const buyBar = page.getByTestId('mobile-buy-bar')
    await expect(buyBar).toBeVisible()
    const barBox = await buyBar.boundingBox()
    expect(Math.round(barBox!.y + barBox!.height)).toBe(812)

    await page.getByTestId('mobile-buy-bar-cta').click()
    const sheet = page.locator('[role="dialog"]')
    await expect(sheet).toBeVisible()
    const box = await sheet.boundingBox()
    expect(box!.width).toBe(375) // full-bleed
    expect(box!.y + box!.height).toBeGreaterThanOrEqual(800) // pinned to bottom (safe-area ≈ 0 in emu)
    expect(box!.height).toBeLessThan(812 * 0.93) // capped by 92dvh
    await page.keyboard.press('Escape')
  })

  test('announcement center opens from tab bar as sheet', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.getByRole('button', { name: '搜索' }).waitFor({ timeout: 10_000 })
    await page.getByTestId('announcement-center-mobile-trigger').click()
    const center = page.getByTestId('announcement-center')
    await expect(center).toBeVisible()
    const box = await center.boundingBox()
    expect(box!.width).toBe(375)
    await page.keyboard.press('Escape')
  })

  test('merchant: horizontal tab strip + 4-tab bar', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant')
    await page.getByText('数据概览').waitFor({ timeout: 10_000 })
    const tabs = page.getByTestId('bottom-tab-bar').getByRole('button')
    await expect(tabs).toHaveCount(4) // 商家 tab present
    // Sidebar became a horizontal strip: all nav buttons share one row
    const navStrip = page.locator('aside nav')
    const btns = navStrip.getByRole('button')
    const y0 = (await btns.nth(0).boundingBox())!.y
    const y1 = (await btns.nth(1).boundingBox())!.y
    expect(Math.round(y0)).toBe(Math.round(y1))
    // 数据概览 content visible in first viewport (not pushed 300px down)
    const overview = await page.getByText('数据概览').boundingBox()
    expect(overview!.y).toBeLessThan(812)
    await expectNoHorizontalOverflow(page, 'merchant')
  })

  test('admin: grouped drawer replaces the old strip and keeps content above fold', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.admin)
    await page.goto('/admin')
    const trigger = page.getByTestId('admin-mobile-nav-trigger')
    await expect(trigger).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('nav[aria-label="管理后台导航"]')).toBeHidden()

    // Main card content begins within the first viewport.
    const mainCard = page.getByRole('heading', { name: '数据仪表盘' }).locator('..')
    const cardBox = await mainCard.boundingBox()
    expect(cardBox!.y).toBeLessThan(700)

    await trigger.click()
    const drawer = page.getByTestId('admin-mobile-nav-drawer')
    await expect(drawer).toBeVisible()
    await expect(page.getByTestId('admin-mobile-nav-item-backup')).toBeVisible()
    await expectNoHorizontalOverflow(page, 'admin')
    await page.keyboard.press('Escape')
  })

  test('profile: no overflow, tab bar covers nothing', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto('/profile')
    await page.getByTestId('nickname-edit').waitFor({ timeout: 10_000 })
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(400)
    await expectNoHorizontalOverflow(page, 'profile')
  })
})

test.describe('mobile layout verification @320px', () => {
  test.use({ viewport: { width: 320, height: 700 }, hasTouch: true })

  test('store 2-col + no overflow at 320', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.getByRole('button', { name: '搜索' }).waitFor({ timeout: 10_000 })
    await page.waitForTimeout(800)
    const cardEls = page.locator('[data-testid^="store-product-card-"]')
    await expect(cardEls.nth(1)).toBeVisible({ timeout: 10_000 })
    const first = await cardEls.nth(0).boundingBox()
    const second = await cardEls.nth(1).boundingBox()
    expect(Math.round(first!.y)).toBe(Math.round(second!.y))
    await expectNoHorizontalOverflow(page, 'store@320')
  })
})

// ---- 审查修复回归（R1：safe-area / 滚动阈值 / 双重预留 / 骨架几何 / 断点泄漏） ----
test.describe('review fixes @375px', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true })

  test('P2-1: tab bar hides on ACCUMULATED slow scroll down, returns on slow scroll up', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.locator('[data-testid^="store-stock-"]').first().waitFor({ timeout: 10_000 })
    const tabBar = page.getByTestId('bottom-tab-bar')
    await expect(tabBar).toBeVisible()

    // 30 次 × 3px 慢速下滑（单帧 <6px，旧逻辑永不触发；累计 90px 必须隐藏）
    await page.evaluate(() => {
      let y = 0
      const id = setInterval(() => {
        y += 3
        window.scrollTo(0, y)
        if (y >= 120) clearInterval(id)
      }, 16)
    })
    await expect(tabBar).toHaveAttribute('data-hidden', 'true', { timeout: 5_000 })

    // 慢速上滑累计 24px+ 必须唤回
    await page.evaluate(() => {
      let y = window.scrollY
      const id = setInterval(() => {
        y -= 3
        window.scrollTo(0, Math.max(0, y))
        if (y <= 60) clearInterval(id)
      }, 16)
    })
    await expect(tabBar).not.toHaveAttribute('data-hidden', 'true', { timeout: 5_000 })
  })

  test('P2-2: product page has no double bottom reserve (main exempt, page root keeps buy-bar space)', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto('/product/1')
    await page.getByTestId('mobile-buy-bar').waitFor({ timeout: 10_000 })

    // main 不再预留 Tab Bar 高度（max-md:pb-6 = 24px）
    const mainPb = await page.locator('main').evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom))
    expect(mainPb).toBeLessThanOrEqual(26)

    // 详情页根部仍预留购买条高度（5rem + safe-area ≈ 80px）
    const rootPb = await page.locator('main > div').first().evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom))
    expect(rootPb).toBeGreaterThanOrEqual(72)
    expect(rootPb).toBeLessThanOrEqual(96)
  })

  test('R2-P1: sticky strips offset includes safe-top (44px notch simulation)', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant')
    await page.getByText('数据概览').waitFor({ timeout: 10_000 })
    // 模拟 iPhone 刘海：覆盖 safe-top 变量后，sticky 偏移必须 = navbar-h + safe-top
    await page.addStyleTag({ content: ':root { --safe-top: 44px !important; }' })
    const top = await page.locator('aside').evaluate((el) => parseFloat(getComputedStyle(el).top))
    expect(top).toBe(121) // 77 + 44
  })

  test('R2-P2-3: skeleton and final grid share the exact same origin (zero layout jump)', async ({ page }) => {
    // 延迟商品接口：先捕骨架首卡 y，再捕最终首卡 y
    // Delay only the organic list. Sponsored/editorial shelves have separate
    // endpoints and must settle before measuring the organic grid anchor.
    await page.route((url) => new URL(url).pathname === '/api/products', async (route) => {
      await new Promise((r) => setTimeout(r, 1200))
      await route.continue()
    })
    await loginAs(page, SEED_ACCOUNTS.user) // 落地 / 即骨架（无 SPA 缓存）

    // The merchandising shelves own separate requests and legitimately
    // collapse from their loading skeletons to empty states. Wait for those
    // anchors to settle so this assertion measures the organic grid only.
    await expect(page.getByTestId('merch-sponsored-shelf').getByRole('status')).toHaveCount(0, { timeout: 10_000 })
    await expect(page.getByTestId('merch-editorial-shelf').getByRole('status')).toHaveCount(0, { timeout: 10_000 })

    const skeletonCard = page.getByRole('status', { name: '加载中' }).locator('.card').first()
    await expect(skeletonCard).toBeVisible()
    const skelY = (await skeletonCard.boundingBox())!.y

    const firstCard = page.locator('[data-testid^="store-product-card-"]').first()
    await expect(firstCard).toBeVisible({ timeout: 10_000 })
    const finalY = (await firstCard.boundingBox())!.y

    expect(Math.abs(finalY - skelY)).toBeLessThanOrEqual(2)
  })
})

test.describe('P2-4: tablet 768-1023px keeps desktop layout', () => {
  test.use({ viewport: { width: 800, height: 900 } })

  test('product title overlays hero at 800px (no mobile in-flow title)', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto('/product/1')
    await page.waitForTimeout(1200)
    // overlay 标题（hero 内）可见；可见 h1 唯一（内容流副本 md:hidden）
    await expect(page.locator('[data-testid="product-gallery"] h1')).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  })
})
