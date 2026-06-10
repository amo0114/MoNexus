import { expect, test } from '@playwright/test'
import { API_BASE, loginAs, SEED_ACCOUNTS } from './helpers'

const PAGE_SIZE = 20

/**
 * M9-A5：商城“加载更多”追加分页 + 商品详情移除评价区。
 * 前置：商城需要 ≥ 21 个上架商品才会出现第 2 页。dev 库不足时通过管理员 API
 * 一次性补齐占位商品（价格 99999、无库存，不影响既有业务数据），重复执行不再新建。
 */
test.beforeAll(async ({ request }) => {
  const listRes = await request.get(`${API_BASE}/api/products?page=1&pageSize=100`)
  expect(listRes.ok()).toBe(true)
  const products: unknown[] = await listRes.json()
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

test('store appends next page via load-more; detail page has gallery and no review section', async ({ page }) => {
  await loginAs(page, SEED_ACCOUNTS.user)

  // 商城首页第一页恰好渲染 PAGE_SIZE 个商品卡片（每张卡片含“已售 N”）
  const cards = page.getByText(/^已售 \d+$/)
  await expect(cards).toHaveCount(PAGE_SIZE, { timeout: 15_000 })

  // 触发“加载更多”：追加渲染（不替换）
  const loadMore = page.getByTestId('store-load-more')
  await expect(loadMore).toBeVisible()
  await loadMore.click()
  await expect
    .poll(async () => cards.count(), { timeout: 15_000 })
    .toBeGreaterThan(PAGE_SIZE)

  // 打开第一个商品详情
  await cards.first().click()
  await expect(page).toHaveURL(/\/product\/\d+/, { timeout: 10_000 })

  // 详情页有图集，无评价区（M9 已移除假评价）
  await expect(page.getByTestId('product-gallery')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByText('图文介绍')).toBeVisible()
  await expect(page.getByText('买家评价')).toHaveCount(0)
  await expect(page.getByText(/共 \d+ 条评价/)).toHaveCount(0)
})
