import { expect, test, type Page, type Route } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { createMockAccessToken } from './auth-fixtures'

const profile = {
  id: 4242,
  email: 'gallery-ui@test.local',
  nickname: '画廊测试用户',
  role: 'user',
  status: '正常',
  points: 9_999,
  emailVerified: '2026-08-01T00:00:00.000Z',
  merchant: null,
}

const images = [
  'https://gallery.test/one.svg',
  'https://gallery.test/two.svg',
  'https://gallery.test/three.svg',
]

const registry = {
  productTypes: [],
  deliveryModes: [],
  orderStatuses: [],
  settlementStatuses: [],
  pagination: { defaultPageSize: 10, maxPageSize: 100 },
  inventory: { lowStockThreshold: 5 },
  memberTiers: [],
  memberTierThresholds: { silver: 1_000, gold: 5_000, platinum: 10_000 },
  memberTierBonusBps: { bronze: 0, silver: 0, gold: 0, platinum: 0 },
}

const product = {
  id: 4242,
  name: '完整展示的多图商品',
  description: '用于验证商品图集的完整显示与左右切换。',
  type: '网络节点',
  icon: 'image',
  imageUrl: images[0],
  images,
  price: 100,
  stock: 10,
  stockMode: 'unlimited',
  sales: 0,
  ratingAvg: 0,
  ratingCount: 0,
  merchant: { id: 1, name: '图集商家' },
  offers: [],
}

function apiPath(path: string) {
  return `/api${path}`
}

async function openGallery(page: Page, withVideo = false) {
  await page.addInitScript(({ authenticatedProfile, accessToken }) => {
    localStorage.setItem('monexus-auth', JSON.stringify({
      state: {
        user: authenticatedProfile,
        accessToken,
        isLoggedIn: true,
      },
      version: 0,
    }))
  }, { authenticatedProfile: profile, accessToken: createMockAccessToken(profile) })

  await page.route(url => url.pathname.startsWith('/api/'), async (route: Route) => {
    const path = new URL(route.request().url()).pathname
    if (path === apiPath('/auth/me')) {
      await route.fulfill({ json: profile })
    } else if (path === apiPath('/config/registry')) {
      await route.fulfill({ json: registry })
    } else if (path === apiPath('/product-templates')) {
      await route.fulfill({ json: { registryVersion: 1, templates: [] } })
    } else if (path === apiPath('/legal/documents')) {
      await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: '页面不存在' } } })
    } else if (path === apiPath('/announcements')) {
      await route.fulfill({ json: [] })
    } else if (path === apiPath('/notifications/unread-count')) {
      // Layout polls after login; do not send the fixture token to the real API.
      await route.fulfill({ json: { count: 0 } })
    } else if (path === apiPath('/notifications')) {
      await route.fulfill({ json: { notifications: [], nextCursor: null, hasMore: false } })
    } else if (path === apiPath('/notifications/stream')) {
      // Keep the unsigned UI-only token away from the real auth middleware;
      // 404 is the production flag-off contract and selects polling fallback.
      await route.fulfill({
        status: 404,
        json: { error: { code: 'NOT_FOUND', message: '页面不存在' } },
      })
    } else if (path === apiPath('/orders')) {
      // Layout's buyer-attention projection is unrelated to this isolated
      // gallery fixture but still mounts on the authenticated product page.
      await route.fulfill({ json: [] })
    } else if (path === apiPath('/orders/attention-count')) {
      await route.fulfill({ json: { count: 0 } })
    } else if (path === apiPath('/products/4242/video-playback')) {
      await route.fulfill({ json: { videoAssetId: 'gallery-video', playbackUrl: '/gallery-fixture.mp4', posterUrl: images[0], expiresAt: new Date(Date.now() + 180_000).toISOString() } })
    } else if (path === apiPath('/products/4242')) {
      await route.fulfill({ json: withVideo ? { ...product, promoVideo: { assetId: 'gallery-video', durationMs: 1000, width: 320, height: 240, hasAudio: true } } : product })
    } else if (path === apiPath('/products/4242/reviews')) {
      await route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 10 } })
    } else if (path === apiPath('/products/4242/recommendations')) {
      // A real API rejects this unsigned fixture token. That 401 can clear
      // the session and reload the product, resetting the image mid-gesture.
      await route.fulfill({ json: { productId: product.id, items: [] } })
    } else {
      await route.abort('blockedbyclient')
      throw new Error(`Unmocked gallery API request: ${route.request().method()} ${path}`)
    }
  })

  await page.route('https://gallery.test/**', async (route: Route) => {
    const label = new URL(route.request().url()).pathname.split('/').pop()?.replace('.svg', '') ?? 'image'
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="600"><rect width="1600" height="600" fill="#34507A"/><text x="800" y="310" text-anchor="middle" fill="white" font-size="96">${label}</text></svg>`,
    })
  })

  if (withVideo) await page.route('**/gallery-fixture.mp4', route => route.fulfill({
    path: fileURLToPath(new URL('./fixtures/product-video.mp4', import.meta.url)), contentType: 'video/mp4',
  }))
  await page.goto('/product/4242')
  await expect(withVideo ? page.getByLabel('商品展示视频') : page.getByTestId('product-gallery-main')).toBeVisible({ timeout: 10_000 })
}

test('product gallery keeps the full image in a stable frame and supports buttons, keys, and desktop drag', async ({ page }) => {
  await openGallery(page)

  const mainImage = page.getByTestId('product-gallery-main')
  const stage = page.getByTestId('product-gallery-stage')
  // Phase 1 redesigned 4:3 gallery with fit contain
  await expect(mainImage).toHaveCSS('object-fit', 'contain')
  await expect(mainImage).toHaveAttribute('src', images[0])
  await expect(page.getByTestId('product-gallery-next')).toBeVisible()
  await expect(page.getByTestId('product-gallery-prev')).toBeVisible()

  await page.getByTestId('product-gallery-next').click()
  await expect(mainImage).toHaveAttribute('src', images[1])

  await stage.focus()
  await page.keyboard.press('ArrowRight')
  await expect(mainImage).toHaveAttribute('src', images[2])

  const box = (await stage.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2)
  await page.mouse.up()
  await expect(mainImage).toHaveAttribute('src', images[0])
})

test('product gallery opens a full-image lightbox (contain) and closes with Esc', async ({ page }) => {
  await openGallery(page)

  await page.getByTestId('product-gallery-stage').click({ position: { x: 40, y: 40 } })
  const lightbox = page.getByTestId('product-image-lightbox')
  await expect(lightbox).toBeVisible()
  const fullImage = page.getByTestId('product-image-lightbox-image')
  await expect(fullImage).toBeVisible()
  await expect(fullImage).toHaveCSS('object-fit', 'contain')
  await expect(fullImage).toHaveAttribute('src', images[0])

  await page.getByTestId('product-image-lightbox-next').click()
  await expect(fullImage).toHaveAttribute('src', images[1])

  await page.keyboard.press('Escape')
  await expect(lightbox).toHaveCount(0)
  // Hero stays in sync with lightbox index
  await expect(page.getByTestId('product-gallery-main')).toHaveAttribute('src', images[1])
})

test.describe('mobile product gallery', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true })

  test('a horizontal touch swipe advances the image without cropping it', async ({ page }) => {
    await openGallery(page)

    const mainImage = page.getByTestId('product-gallery-main')
    const stage = page.getByTestId('product-gallery-stage')
    await expect(mainImage).toHaveCSS('object-fit', 'contain')

    await stage.scrollIntoViewIfNeeded()
    const box = (await stage.boundingBox())!
    // Exercise Chromium's real touch/pointer pipeline, including hit testing
    // and touch-action, rather than dispatching untrusted DOM pointer events.
    const touch = await page.context().newCDPSession(page)
    try {
      const y = box.y + box.height / 2
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ x: box.x + box.width * 0.75, y }],
      })
      for (const fraction of [0.65, 0.5, 0.35, 0.25]) {
        await touch.send('Input.dispatchTouchEvent', {
          type: 'touchMove', touchPoints: [{ x: box.x + box.width * fraction, y }],
        })
      }
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } finally {
      await touch.detach()
    }

    await expect(mainImage).toHaveAttribute('src', images[1])
  })
})

// Requires a real browser: no user gesture, real MP4 decode, and native-control
// hit area must stay separate from the mobile page's share/back/favorite tools.
test('video starts without a click and leaves native controls accessible across layouts', async ({ page }, testInfo) => {
  for (const width of [1280, 820, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await openGallery(page, true)
    const video = page.getByLabel('商品展示视频')
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0)
    expect(await video.evaluate((element: HTMLVideoElement) => element.muted)).toBe(true)
    await expect(video).toHaveCSS('object-fit', 'contain')
    const videoBox = (await video.boundingBox())!
    const frameBox = (await page.getByTestId('product-video-player').boundingBox())!
    expect(Math.abs(videoBox.height - frameBox.height)).toBeLessThan(2)
    if (width < 768) {
      const tools = page.locator('.pm-gallery-tools')
      const toolsBox = (await tools.boundingBox())!
      expect(toolsBox.y + toolsBox.height).toBeLessThanOrEqual(videoBox.y + 1)
    }
    await page.screenshot({ path: testInfo.outputPath(`video-${width}.png`), fullPage: false })
    const handle = await video.elementHandle()
    await page.getByRole('button', { name: '查看下一项商品媒体' }).click()
    await expect(video).toHaveCount(0)
    expect(await handle!.evaluate(element => element.getAttribute('src'))).toBeNull()
    await expect(page.getByTestId('product-gallery-main')).toBeVisible()
  }
})
