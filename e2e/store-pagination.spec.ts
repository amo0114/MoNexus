import { expect, test } from '@playwright/test'
import { API_BASE, loginAs, SEED_ACCOUNTS } from './helpers'

const PAGE_SIZE = 60

/**
 * M9-A5：商城“加载更多”追加分页 + 商品详情移除评价区。
 * 前置：商城需要 ≥ PAGE_SIZE + 1 个上架商品才会出现第 2 页。dev 库不足时通过管理员 API
 * 一次性补齐占位商品（价格 99999、无库存，不影响既有业务数据），重复执行不再新建。
 */
test.beforeAll(async ({ request }) => {
  const listRes = await request.get(`${API_BASE}/api/products?pageSize=100`)
  expect(listRes.ok()).toBe(true)
  const listBody = await listRes.json()
  const products: unknown[] = listBody.items
  const missing = PAGE_SIZE + 1 - products.length
  if (missing <= 0) return

  const loginRes = await request.post(`${API_BASE}/api/auth/login`, {
    data: SEED_ACCOUNTS.admin,
  })
  expect(loginRes.ok()).toBe(true)
  const { accessToken } = await loginRes.json()

  for (let i = 0; i < missing; i++) {
    const createRes = await request.post(`${API_BASE}/api/admin/products`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: {
        name: `E2E 分页占位商品 ${Date.now()}-${i + 1}`,
        description: 'E2E 分页测试自动创建的占位商品，可忽略。',
        type: '充值卡密',
        price: 99999,
      },
    })
    expect(createRes.ok()).toBe(true)
  }
})

test('store loads the next cursor page; detail page has gallery and no review section', async ({ page }) => {
  await loginAs(page, SEED_ACCOUNTS.user)

  // 虚拟网格只渲染视口附近的商品卡片，DOM 数量不再等于已加载商品总数。
  const cards = page.getByText(/^已售 \d+$/)
  await expect.poll(async () => cards.count(), { timeout: 15_000 }).toBeGreaterThan(0)

  // 滚到“加载更多”附近：IntersectionObserver 会触发 cursor 下一页请求，按钮仍作为手动兜底保留。
  const loadMore = page.getByTestId('store-load-more')
  await expect(loadMore).toBeVisible()
  const nextPageResponse = page.waitForResponse((response) =>
    response.url().includes('/api/products') &&
    response.url().includes('cursor=') &&
    response.status() === 200
  )
  await loadMore.scrollIntoViewIfNeeded()
  const response = await nextPageResponse
  const body = await response.json()
  expect(body.items.length).toBeGreaterThan(0)

  // 在当前滚动位置打开第一个可见商品详情，返回后应恢复列表状态和滚动位置。
  await expect.poll(async () => cards.count(), { timeout: 10_000 }).toBeGreaterThan(0)
  const scrollBeforeDetail = await page.evaluate(() => window.scrollY)
  expect(scrollBeforeDetail).toBeGreaterThan(0)
  await page.evaluate(() => {
    const saleNodes = [...document.querySelectorAll('span')]
      .filter(el => /^已售 \d+$/.test(el.textContent || ''))
    const visibleCard = saleNodes
      .map(el => el.closest('.cursor-pointer') as HTMLElement | null)
      .filter((card): card is HTMLElement => {
        if (!card) return false
        const rect = card.getBoundingClientRect()
        return rect.bottom > 0 && rect.top < window.innerHeight
      })[0]
    visibleCard?.click()
  })
  await expect(page).toHaveURL(/\/product\/\d+/, { timeout: 10_000 })

  // 详情页有图集，无评价区（M9 已移除假评价）
  await expect(page.getByTestId('product-gallery')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('图文介绍')).toBeVisible()
  await expect(page.getByText('买家评价')).toHaveCount(0)
  await expect(page.getByText(/共 \d+ 条评价/)).toHaveCount(0)

  await page.goBack()
  await expect(page).toHaveURL(/\/$/, { timeout: 10_000 })
  await expect
    .poll(async () => page.evaluate(() => window.scrollY), { timeout: 10_000 })
    .toBeGreaterThan(scrollBeforeDetail - 200)
})
