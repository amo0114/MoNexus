import { expect, test, type Page, type Route } from '@playwright/test'

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

async function openGallery(page: Page) {
  await page.addInitScript((authenticatedProfile) => {
    localStorage.setItem('monexus-auth', JSON.stringify({
      state: {
        user: authenticatedProfile,
        // The role claim prevents ProtectedRoute's role-healing path from
        // attempting a real refresh request during this fully mocked UI test.
        accessToken: 'e30.eyJyb2xlIjoidXNlciJ9.signature',
        isLoggedIn: true,
      },
      version: 0,
    }))
  }, profile)

  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname
    if (path === apiPath('/auth/me')) {
      await route.fulfill({ json: profile })
    } else if (path === apiPath('/config/registry')) {
      await route.fulfill({ json: registry })
    } else if (path === apiPath('/announcements')) {
      await route.fulfill({ json: [] })
    } else if (path === apiPath('/products/4242')) {
      await route.fulfill({ json: product })
    } else if (path === apiPath('/products/4242/reviews')) {
      await route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 10 } })
    } else {
      await route.continue()
    }
  })

  await page.route('https://gallery.test/**', async (route: Route) => {
    const label = new URL(route.request().url()).pathname.split('/').pop()?.replace('.svg', '') ?? 'image'
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="600"><rect width="1600" height="600" fill="#34507A"/><text x="800" y="310" text-anchor="middle" fill="white" font-size="96">${label}</text></svg>`,
    })
  })

  await page.goto('/product/4242')
  await expect(page.getByTestId('product-gallery-main')).toBeVisible()
}

test('product gallery preserves the whole image and supports buttons, keys, and desktop drag', async ({ page }) => {
  await openGallery(page)

  const mainImage = page.getByTestId('product-gallery-main')
  const stage = page.getByTestId('product-gallery-stage')
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

test.describe('mobile product gallery', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true })

  test('a horizontal touch swipe advances the image without changing the complete-display mode', async ({ page }) => {
    await openGallery(page)

    const mainImage = page.getByTestId('product-gallery-main')
    const stage = page.getByTestId('product-gallery-stage')
    await expect(mainImage).toHaveCSS('object-fit', 'contain')

    await stage.evaluate((element) => {
      element.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        clientX: 300,
        clientY: 180,
        pointerType: 'touch',
      }))
      element.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        clientX: 90,
        clientY: 180,
        pointerType: 'touch',
      }))
    })

    await expect(mainImage).toHaveAttribute('src', images[1])
  })
})
