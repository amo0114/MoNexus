import { expect, test, type Page } from '@playwright/test'
import { createMockAccessToken } from './auth-fixtures'

// All API requests are intercepted; this suite never writes to a local account.
const applicant = {
  id: 9901, email: 'island-final@example.test', nickname: '移动端验收', role: 'user' as const,
  status: 'active', points: 100, emailVerified: '2026-01-01', merchant: null,
}
const application = {
  id: 7, userId: applicant.id, name: '三国小铺', status: 'pending', commissionRate: '0.1',
  description: null, contactEmail: null, contactPhone: null,
  createdAt: '2026-10-06', updatedAt: '2026-10-06', approvedAt: null, approvedBy: null,
}
const merchant = { ...applicant, role: 'merchant' as const, merchant: { ...application, status: 'active' } }
const product = {
  id: 42, merchantId: 7, name: '下架验收商品', description: '', richDescription: null,
  type: 'default', icon: '', imageUrl: null, price: 100, stock: 0, sales: 0,
  status: 'active', createdAt: '2026-01-01', deliveryMode: 'instant_fixed', stockMode: 'unlimited',
}
const registry = { productTypes: [], productCategories: [], deliveryModes: [], orderStatuses: [], settlementStatuses: [], capabilities: {}, memberTiers: [] }

async function authenticate(page: Page, user: typeof applicant | typeof merchant) {
  await page.addInitScript(({ user, accessToken }) => {
    localStorage.setItem('monexus-auth', JSON.stringify({ state: { user, accessToken, isLoggedIn: true }, version: 0 }))
  }, { user, accessToken: createMockAccessToken(user) })
}

async function checkLayout(page: Page, mobile: boolean) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  if (mobile) expect((await page.getByTestId('app-navbar').boundingBox())!.height).toBe(65)
}

for (const width of [320, 390, 1280]) {
  test.describe(`merchant completion ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: width < 768 })
    const mobile = width < 768

    test('application failure retries, successful write survives refresh failure, and status action reads the latest review', async ({ page }, testInfo) => {
      let state: typeof applicant | { merchant: typeof application; role: 'user' | 'merchant' } & Omit<typeof applicant, 'merchant' | 'role'> = applicant
      let writeCalls = 0
      let failRefresh = false
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await authenticate(page, applicant)
      await page.route('**/api/**', route => {
        const p = new URL(route.request().url()).pathname
        if (!p.startsWith('/api/')) return route.fallback()
        if (p === '/api/auth/me') {
          if (failRefresh) { failRefresh = false; return route.fulfill({ status: 503, json: { error: { message: 'read unavailable' } } }) }
          return route.fulfill({ json: state })
        }
        if (p === '/api/merchant/register') {
          writeCalls++
          if (writeCalls === 1) return route.fulfill({ status: 503, json: { error: { message: '申请暂时不可用' } } })
          state = { ...applicant, merchant: application }
          failRefresh = true
          return route.fulfill({ status: 201, json: application })
        }
        if (p === '/api/config/registry') return route.fulfill({ json: registry })
        if (p === '/api/announcements') return route.fulfill({ json: [] })
        if (p.includes('unread-count') || p.includes('attention-count')) return route.fulfill({ json: { count: 0 } })
        return route.fulfill({ status: 404, json: { error: { message: 'mock unavailable' } } })
      })
      await page.goto('/merchant/apply')
      await page.getByLabel(/商家名称/).fill('三国小铺')
      await page.getByLabel('联系邮箱').fill('private@example.test')
      await page.getByRole('button', { name: '提交入驻申请' }).click()
      await expect(page.getByRole('alert')).toContainText('申请暂时不可用')
      await expect(page.getByLabel('联系邮箱')).toHaveValue('private@example.test')
      await page.getByRole('button', { name: '提交入驻申请' }).click()
      await expect(page.getByRole('heading', { name: '商家申请审核中' })).toBeVisible()
      await expect(page.getByRole('alert')).toContainText('暂时无法刷新申请状态')
      expect(writeCalls).toBe(2)
      const notice = page.getByTestId('action-island-notice')
      if (mobile) {
        await expect(notice).toContainText('入驻申请已提交，待审核')
        await expect(notice).not.toContainText('private@example.test')
      } else {
        await expect(notice).toHaveCount(0)
        await expect(page.locator('[data-toast-card]')).toHaveCount(0)
      }
      await checkLayout(page, mobile)
      await page.screenshot({ path: testInfo.outputPath(`application-${width}.png`) })
      state = merchant
      if (mobile) {
        await notice.getByRole('button', { name: '查看申请状态' }).click()
        await expect(page).toHaveURL(/\/merchant\/apply\?view=status$/)
      } else await page.getByRole('button', { name: '刷新申请状态' }).click()
      await expect(page.getByRole('heading', { name: '您已经是商家了' })).toBeVisible()
      expect(writeCalls).toBe(2)
      expect(errors).toEqual([])
    })

    test('unpublish confirms actual state and its mobile action opens the matching merchant editor', async ({ page }, testInfo) => {
      let unpublished = false
      let writeCalls = 0
      let editorReads = 0
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await authenticate(page, merchant)
      await page.route('**/api/**', route => {
        const p = new URL(route.request().url()).pathname
        if (!p.startsWith('/api/')) return route.fallback()
        if (p === '/api/auth/me') return route.fulfill({ json: merchant })
        if (p === '/api/config/registry') return route.fulfill({ json: registry })
        if (p === '/api/announcements') return route.fulfill({ json: [] })
        if (p.includes('unread-count') || p.includes('attention-count')) return route.fulfill({ json: { count: 0 } })
        if (p === '/api/merchant/stats') return route.fulfill({ json: { productCount: 1, orderCount: 0, totalRevenue: 0, pendingSettlement: 0, todo: { pending: 0, processing: 0, slaExceeded: 0 } } })
        if (p === '/api/merchant/products') return route.fulfill({ json: { items: [{ ...product, status: unpublished ? 'inactive' : 'active' }], total: 1, page: 1, pageSize: 20 } })
        if (p === '/api/merchant/products/42/unpublish') {
          writeCalls++
          unpublished = true
          return route.fulfill({ json: { id: 42, status: 'inactive', publishedAt: '2026-10-06' } })
        }
        if (p === '/api/merchant/products/42/editor') {
          editorReads++
          return route.fulfill({ json: {
            product: { ...product, status: 'inactive', contentVersion: 1, templateKey: null, templateVersion: null,
              categoryId: null, images: [], descriptionImages: [], visibility: 'public', attributes: {},
              details: { purchaseNotes: '', afterSalesInstructions: '', usageInstructions: '', serviceGuarantee: '' }, purchaseForm: [] },
            offers: [], capabilities: { editContent: true, manageOffers: true, manageAvailability: true },
            publicationIssues: [], sourceDescription: null,
          } })
        }
        return route.fulfill({ status: 404, json: { error: { message: 'mock unavailable' } } })
      })
      await page.goto('/merchant')
      await page.getByRole('button', { name: '商品管理', exact: true }).click()
      await page.getByTestId('merchant-product-toggle-status-42').click()
      await expect(page.getByTestId('merchant-product-toggle-status-42')).toHaveText('上架')
      expect(writeCalls).toBe(1)
      const notice = page.getByTestId('action-island-notice')
      if (mobile) {
        await expect(notice).toContainText('商品已下架')
        await expect(notice).toContainText(product.name)
      } else {
        await expect(notice).toHaveCount(0)
        await expect(page.locator('[data-toast-card]')).toContainText('商品已下架')
      }
      await checkLayout(page, mobile)
      await page.screenshot({ path: testInfo.outputPath(`unpublished-${width}.png`) })
      if (mobile) {
        await notice.getByRole('button', { name: '管理商品' }).click()
        await expect(page).toHaveURL(/\/merchant\/products\/42\/edit$/)
        await expect(page.getByTestId('product-edit-name')).toHaveValue(product.name)
        await expect(page.getByTestId('product-edit-status')).toHaveText('已下架')
        // Development StrictMode may repeat the editor's read effect.
        expect(editorReads).toBeGreaterThan(0)
        await checkLayout(page, mobile)
      }
      expect(errors).toEqual([])
    })
  })
}
