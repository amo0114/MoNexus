import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'

// Frontend-only visual/interaction audit. Every API request is intercepted;
// no order, payment, or database mutation is possible in this script.
const output = 'outputs/product-detail-redesign/two-column'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const errors = []
const orderWrites = []
const profile = {
  id: 4242,
  email: 'design@test.local',
  nickname: 'M',
  role: 'user',
  status: '正常',
  points: 5039,
  emailVerified: '2026-01-01',
  merchant: null,
}
const registry = {
  productTypes: [],
  deliveryModes: [],
  orderStatuses: [],
  settlementStatuses: [],
  pagination: { defaultPageSize: 10, maxPageSize: 100 },
  inventory: { lowStockThreshold: 5 },
  memberTiers: [],
  memberTierThresholds: { silver: 1000, gold: 5000, platinum: 10000 },
  memberTierBonusBps: { bronze: 0, silver: 0, gold: 0, platinum: 0 },
}
const product = {
  id: 42,
  name: '真实数据结构 · 数字服务套餐',
  description: '商品内容、价格和库存来自接口，单件购买继续使用原有兑换流程。',
  type: '数字服务',
  imageUrl: '/assets/presets/preset_membership_pass.webp',
  images: ['/assets/presets/preset_membership_pass.webp', '/assets/presets/preset_cloud_license.webp'],
  price: 100,
  stock: 12,
  sales: 38,
  ratingAvg: 4.8,
  ratingCount: 3,
  merchant: { id: 1, name: '数字服务商家' },
  offers: [
    {
      id: 7,
      name: '标准套餐',
      price: 100,
      originalPrice: null,
      status: 'active',
      stock: 12,
      stockMode: 'limited',
      deliveryMode: 'instant_inventory',
    },
    {
      id: 8,
      name: '高级套餐',
      price: 300,
      originalPrice: null,
      status: 'active',
      stock: 0,
      stockMode: 'limited',
      deliveryMode: 'instant_inventory',
    },
  ],
}
async function setup(viewport, theme = 'light', fixture = product) {
  const page = await browser.newPage({ viewport })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(
    ({ theme, profile }) => {
      localStorage.setItem('theme', theme)
      localStorage.setItem(
        'monexus-auth',
        JSON.stringify({
          state: { user: profile, accessToken: 'e30.eyJyb2xlIjoidXNlciJ9.signature', isLoggedIn: true },
          version: 0,
        })
      )
    },
    { theme, profile }
  )
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/orders' && route.request().method() === 'POST') orderWrites.push(path)
    if (route.request().method() !== 'GET')
      return route.fulfill({
        status: 400,
        json: { error: { code: 'PREVIEW_ONLY', message: 'Preview only' } },
      })
    const json =
      path === '/api/auth/me'
        ? profile
        : path === '/api/config/registry'
          ? registry
          : path === '/api/product-templates'
            ? { templates: [] }
            : path === '/api/products/42'
              ? fixture
              : path === '/api/checkout/preview'
                ? {
                    productId: 42,
                    productName: product.name,
                    offerId: 7,
                    offerName: '标准套餐',
                    price: 100,
                    deliveryMode: 'instant_inventory',
                    chargeType: 'debit',
                    balanceBefore: 5039,
                    balanceAfter: 4939,
                    sufficient: true,
                    purchasable: true,
                    purchaseForm: [],
                    purchaseFormVersion: 'form-v1',
                    checkoutVersion: 'checkout-v1',
                    requiresVerification: false,
                    autoProvision: false,
                    productContentVersion: 1,
                    assuranceGrantId: null,
                  }
                : path.endsWith('/reviews')
                  ? { items: [], total: 0, page: 1, pageSize: 20 }
                  : path.includes('count')
                    ? { count: 0 }
                    : path === '/api/notifications'
                      ? { notifications: [], nextCursor: null, hasMore: false }
                      : []
    if (path.endsWith('/stream')) return route.fulfill({ status: 404, json: {} })
    await route.fulfill({ json })
  })
  return page
}
async function open(page, url = '/product/preview?preview=aster-link') {
  await page.goto(`http://localhost:5173${url}`)
  await page.getByTestId('product-gallery').waitFor()
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all(
      [...document.images]
        .filter((im) => im.loading !== 'lazy' || im.complete)
        .map((im) => im.decode().catch(() => {}))
    )
  })
}
try {
  const page = await setup({ width: 1536, height: 1024 })
  await open(page)
  await page.screenshot({ path: `${output}/desktop-1536.png` })
  await page.getByRole('button', { name: '增加购买数量', exact: true }).click()
  assert.equal(await page.getByTestId('purchase-quantity').innerText(), '2')
  await page.getByRole('button', { name: '收藏', exact: true }).click()
  assert.equal(
    await page.getByRole('button', { name: '已收藏', exact: true }).getAttribute('aria-pressed'),
    'true'
  )
  await page.getByRole('button', { name: '加入购物车', exact: true }).click()
  await page.getByRole('button', { name: '购物车（2）', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  assert.match(await page.getByRole('dialog').innerText(), /月付 · 2 件/)
  await page.getByRole('dialog').getByRole('button', { name: /^关闭/ }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByTestId('desktop-buy-cta').click()
  assert.match(await page.getByRole('dialog').innerText(), /不会生成订单或扣款/)
  await page.getByRole('dialog').getByRole('button', { name: /^关闭/ }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '套餐对比', exact: true }).click()
  assert.equal(await page.getByRole('dialog').locator('tbody tr').count(), 3)
  await page.getByRole('dialog').getByRole('button', { name: /^关闭/ }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByRole('link', { name: '使用说明', exact: true }).click()
  assert.match(await page.locator('#pd-content-usage').innerText(), /将订阅导入/)
  await page.getByRole('link', { name: '常见问题', exact: true }).click()
  await page.getByText('支持哪些设备？', { exact: true }).click()
  assert.match(await page.locator('#pd-content-faq').innerText(), /Windows/)
  await page.getByRole('link', { name: '商品详情', exact: true }).click()
  await page.getByRole('button', { name: '联系客服', exact: true }).first().click()
  await page.getByTestId('merchant-support-modal').waitFor()
  await page.getByRole('dialog').getByRole('button', { name: /^关闭/ }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '进入店铺', exact: true }).click()
  assert.match(await page.getByRole('dialog').innerText(), /完整店铺功能即将开放/)
  await page.getByRole('dialog').getByRole('button', { name: /^关闭/ }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.close()

  for (const [width, height] of [
    [2560, 1229],
    [1920, 1080],
    [1440, 900],
    [1280, 900],
    [1024, 900],
    [768, 1024],
    [390, 844],
  ]) {
    const p = await setup({ width, height })
    await open(p)
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    assert.equal(overflow, false, `Horizontal overflow at ${width}px`)
    await p.screenshot({ path: `${output}/viewport-${width}.png` })
    if (width < 1024) assert.equal(await p.getByTestId('product-desktop').count(), 0)
    else {
      const assertPurchaseVisible = async () => {
        const box = await p.getByTestId('desktop-buy-cta').boundingBox()
        assert.ok(
          box && box.y >= 77 && box.y + box.height <= height,
          `Purchase CTA outside viewport at ${width}px`
        )
      }
      await assertPurchaseVisible()
      await p.emulateMedia({ reducedMotion: 'reduce' })
      await p.getByRole('link', { name: '使用说明', exact: true }).click()
      await p.waitForFunction(
        () =>
          document.querySelector('a[href="#pd-content-usage"]')?.getAttribute('aria-current') === 'location'
      )
      await assertPurchaseVisible()
      const navBox = await p.getByRole('navigation', { name: '商品详情栏目' }).boundingBox()
      assert.ok(navBox && navBox.y >= 0 && navBox.y < 120, 'Section navigation must stick below the navbar')
      if (width === 2560 || width === 1024) await p.screenshot({ path: `${output}/scrolled-${width}.png` })
      await p.getByRole('link', { name: '相关推荐', exact: true }).click()
      await p.waitForFunction(
        () =>
          document.querySelector('a[href="#pd-content-related"]')?.getAttribute('aria-current') === 'location'
      )
      await p.waitForFunction(() => {
        const purchase = document.querySelector('.pd-purchase')?.getBoundingClientRect()
        const navbar = document.querySelector('[data-testid="app-navbar"]')?.getBoundingClientRect()
        return purchase && navbar && purchase.top >= navbar.bottom
      })
      await assertPurchaseVisible()
      if (width === 2560) await p.screenshot({ path: `${output}/recommendations-${width}.png` })
    }
    await p.close()
  }
  const dark = await setup({ width: 1536, height: 1024 }, 'dark')
  await open(dark)
  await dark.screenshot({ path: `${output}/desktop-dark.png` })
  await dark.close()

  const live = await setup({ width: 1536, height: 1024 })
  await open(live, '/product/42')
  assert.equal(await live.getByTestId('sku-option-8').isDisabled(), true)
  await live.screenshot({ path: `${output}/desktop-api-data.png` })
  async function assertRealMode(p) {
    assert.equal(await p.getByTestId('purchase-quantity').count(), 0)
    assert.equal(await p.getByRole('button', { name: '加入购物车', exact: true }).count(), 0)
    assert.equal(await p.getByRole('button', { name: /进入店铺|逛逛店铺|^店铺$/ }).count(), 0)
    assert.doesNotMatch(await p.locator('main').innerText(), /Aster Link|全球加速 Pro|轻量游戏专线|¥/)
    assert.equal(await p.getByTestId('product-exchange-summary').count(), 1)
  }
  await assertRealMode(live)
  await live.getByRole('button', {name: '收藏', exact: true}).click()
  await live.reload()
  await live.getByTestId('product-gallery').waitFor()
  assert.equal(await live.getByRole('button', {name: '已收藏', exact: true}).getAttribute('aria-pressed'), 'true')
  await live.setViewportSize({width: 390, height: 844})
  await live.getByTestId('product-mobile').waitFor()
  assert.equal(await live.getByTestId('mobile-buy-bar').getByRole('button', {name: '已收藏', exact: true}).getAttribute('aria-pressed'), 'true')
  await live.setViewportSize({width: 1536, height: 1024})
  await live.getByTestId('product-desktop').waitFor()
  await live.getByTestId('desktop-buy-cta').click()
  await live.getByTestId('purchase-modal').waitFor()
  await live.close()

  const manyOffers = {
    ...product,
    offers: Array.from({ length: 18 }, (_, i) => ({
      ...product.offers[0],
      id: 100 + i,
      name: `套餐 ${i + 1}`,
      price: 100 + i,
    })),
  }
  const compact = await setup({ width: 1280, height: 720 }, 'light', manyOffers)
  await open(compact, '/product/42')
  await compact.getByTestId('sku-option-117').click()
  assert.equal(await compact.getByTestId('sku-option-117').getAttribute('aria-pressed'), 'true')
  const compactCta = await compact.getByTestId('desktop-buy-cta').boundingBox()
  assert.ok(
    compactCta && compactCta.y >= 77 && compactCta.y + compactCta.height <= 720,
    'CTA stays visible with many offers on a short screen'
  )
  await compact.screenshot({ path: `${output}/many-offers-1280.png` })
  await compact.close()

  const mobileOutput = 'outputs/product-detail-redesign/mobile'
  await mkdir(mobileOutput, { recursive: true })
  async function closeDialog(p) {
    await p.getByRole('dialog').getByRole('button', { name: /^关闭/ }).click()
    await p.getByRole('dialog').waitFor({ state: 'hidden' })
  }
  for (const width of [320, 390, 430, 767]) {
    const mobile = await setup({ width, height: 844 })
    await mobile.emulateMedia({ reducedMotion: 'reduce' })
    await open(mobile)
    assert.equal(await mobile.getByTestId('product-mobile').count(), 1)
    assert.equal(await mobile.getByTestId('mobile-buy-bar').count(), 1)
    assert.equal(
      await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `Mobile overflow at ${width}px`
    )
    const galleryBox = await mobile.getByTestId('product-gallery-main').boundingBox()
    const titleBox = await mobile
      .getByRole('heading', { name: 'Aster Link 传奇凤凰套餐', exact: true })
      .boundingBox()
    assert.ok(galleryBox && titleBox && galleryBox.y < titleBox.y, 'Mobile gallery precedes title')
    await mobile.screenshot({ path: `${mobileOutput}/first-screen-${width}.png` })
    if (width === 390) {
      await mobile.getByTestId('sku-option--12').click()
      assert.equal(await mobile.getByTestId('sku-option--12').getAttribute('aria-pressed'), 'true')
      assert.match(await mobile.getByTestId('mobile-price').innerText(), /79.00/)
      await mobile.getByRole('button', { name: '增加购买数量', exact: true }).click()
      assert.equal(await mobile.getByTestId('purchase-quantity').innerText(), '2')
      await mobile.locator('.pm-purchase').evaluate((el) => el.scrollIntoView({ block: 'start' }))
      await mobile.screenshot({ path: `${mobileOutput}/packages-390.png` })
      await mobile.getByRole('button', { name: '加入购物车', exact: true }).click()
      await mobile.getByRole('button', { name: '购物车（2）', exact: true }).click()
      assert.match(await mobile.getByRole('dialog').innerText(), /季付 · 2 件/)
      await closeDialog(mobile)
      await mobile.getByTestId('mobile-buy-bar').getByRole('button', { name: '收藏', exact: true }).click()
      assert.equal(
        await mobile.getByRole('button', { name: '取消收藏', exact: true }).getAttribute('aria-pressed'),
        'true'
      )
      await mobile.getByTestId('mobile-buy-bar-cta').click()
      assert.match(await mobile.getByRole('dialog').innerText(), /不会生成订单或扣款/)
      await closeDialog(mobile)
      await mobile.getByTestId('mobile-buy-bar').getByRole('button', { name: '店铺', exact: true }).click()
      assert.match(await mobile.getByRole('dialog').innerText(), /完整店铺功能即将开放/)
      await closeDialog(mobile)
      await mobile.getByTestId('mobile-buy-bar').getByRole('button', { name: '客服', exact: true }).click()
      await mobile.getByTestId('merchant-support-modal').waitFor()
      await closeDialog(mobile)
      await mobile.mouse.move(0, 840)
      await mobile.locator('[data-toast-card]').waitFor({ state: 'hidden' })
      for (const [name, key] of [
        ['商品详情', 'details'],
        ['使用说明', 'usage'],
        ['常见问题', 'faq'],
        ['用户评价', 'reviews'],
      ]) {
        await mobile.getByRole('link', { name, exact: true }).click()
        await mobile.waitForFunction(
          (key) =>
            document.querySelector(`a[href="#pm-${key}"]`)?.getAttribute('aria-current') === 'location',
          key
        )
        const nav = await mobile.getByTestId('product-section-nav').boundingBox()
        assert.ok(nav && nav.y >= 0 && nav.y < 120, 'Mobile section navigation sticks below navbar')
        if (key === 'faq') {
          await mobile.getByText('支持哪些设备？', { exact: true }).click()
          assert.equal(await mobile.locator('.pm-faq').first().getAttribute('open'), '')
        }
        await mobile.screenshot({ path: `${mobileOutput}/${key}-390.png` })
        const cta = await mobile.getByTestId('mobile-buy-bar-cta').boundingBox()
        assert.ok(cta && cta.y > 700 && cta.y + cta.height <= 844, 'Mobile purchase CTA stays visible')
      }
      await mobile.setViewportSize({ width: 844, height: 390 })
      assert.equal(await mobile.getByTestId('product-mobile').count(), 0, 'Rotation enters tablet layout')
      await mobile.setViewportSize({ width: 390, height: 844 })
      await mobile.getByTestId('product-mobile').waitFor()
      assert.equal(
        await mobile.getByTestId('mobile-buy-bar').count(),
        1,
        'Rotation must not duplicate purchase bar'
      )
    }
    await mobile.close()
  }
  const mobileDark = await setup({ width: 390, height: 844 }, 'dark')
  await open(mobileDark)
  await mobileDark.screenshot({ path: `${mobileOutput}/dark-390.png` })
  await mobileDark.close()
  const mobileLive = await setup({ width: 390, height: 844 })
  await open(mobileLive, '/product/42')
  assert.equal(await mobileLive.getByTestId('sku-option-8').isDisabled(), true)
  await assertRealMode(mobileLive)
  await mobileLive.screenshot({path: `${mobileOutput}/real-product-390.png`})
  await mobileLive.getByTestId('mobile-buy-bar-cta').click()
  await mobileLive.getByTestId('purchase-modal').waitFor()
  await mobileLive.close()
  const tabletLive = await setup({width: 900, height: 1024})
  await open(tabletLive, '/product/42')
  await assertRealMode(tabletLive)
  await tabletLive.getByTestId('inflow-buy-cta').click()
  await tabletLive.getByTestId('purchase-modal').waitFor()
  await tabletLive.close()
  assert.deepEqual(errors, [], 'Unexpected browser runtime errors')
  assert.deepEqual(orderWrites, [], 'Mock actions must never submit real orders')
  console.log(
    'PASS: desktop and mobile mock interactions, real single-unit checkout boundaries, responsive widths, sticky navigation and purchase bars, rotation, many offers, dark mode, no order writes, and screenshots.'
  )
} finally {
  await browser.close()
}
