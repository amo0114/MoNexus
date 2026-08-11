import { expect, test } from '@playwright/test'
import { loginAs, SEED_ACCOUNTS } from './helpers'

const SEED_PRODUCT_NAME = '商家自营高速节点包'

/**
 * M9-A1/A3：商家端商品筛选 + 库存流水 / 作废。
 * 数据策略：先导入 1 条唯一内容的库存，再作废 1 条（按入库时间先进先出），
 * 库存净变化为 0，保证测试可重复执行。
 */
test('merchant filters products, imports then voids inventory with log entry', async ({ page }) => {
  await loginAs(page, SEED_ACCOUNTS.merchant)

  await page.goto('/merchant')
  await page.getByRole('button', { name: '商品管理' }).click()
  await expect(page.getByTestId('merchant-product-filters')).toBeVisible({ timeout: 10_000 })

  const row = page.locator('tbody tr').filter({ hasText: SEED_PRODUCT_NAME })

  // 关键词搜索（防抖）：命中 seed 商品
  await page.getByTestId('merchant-product-search').fill('自营高速')
  await expect(row).toBeVisible({ timeout: 10_000 })

  // 不存在的关键词：空列表
  await page.getByTestId('merchant-product-search').fill('绝不存在的商品xyz')
  await expect(page.getByText('暂无商品')).toBeVisible({ timeout: 10_000 })

  // 清空搜索恢复列表。累积的 e2e 商品可能把 seed 商品挤出第一页，
  // 这里只验证列表非空恢复；后续步骤重新搜索定位，保证行可见。
  await page.getByTestId('merchant-product-search').fill('')
  await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 10_000 })
  await page.getByTestId('merchant-product-search').fill('自营高速')
  await expect(row).toBeVisible({ timeout: 10_000 })

  // 低库存开关：seed 商品库存 3 ≤ 阈值（默认 5），开启后仍可见且带低库存徽标
  const productId = (await row.locator('td').first().innerText()).trim()
  await page.getByTestId('merchant-product-lowstock-toggle').check()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId(`low-stock-badge-${productId}`)).toBeVisible()
  await page.getByTestId('merchant-product-lowstock-toggle').uncheck()
  await expect(row).toBeVisible({ timeout: 10_000 })

  // 库存分为 Product 汇总和 Offer 细分；这里取 Product 交付库存汇总。
  const availability = page.getByTestId(`merchant-product-availability-${productId}`)
  const stockBeforeText = await availability.innerText()
  const stockBefore = Number(stockBeforeText.match(/商品交付库存汇总：(\d+)/)?.[1])
  expect(Number.isInteger(stockBefore)).toBe(true)

  // 导入 1 个唯一交付单元，库存 +1
  const uniqueItem = `E2E-VOID-${Date.now()}`
  await row.getByText('管理可售资源').click()
  await expect(page.getByTestId('availability-offer-select')).toBeVisible()
  await page.getByTestId('availability-open-import').click()
  await page.getByTestId('merchant-inventory-content').fill(uniqueItem)
  await page.getByRole('button', { name: '预览导入内容' }).click()
  await expect(page.getByText('预览结果')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: '确认导入 1 个' }).click()
  await expect(page.getByText('成功导入 1 个交付单元')).toBeVisible({ timeout: 10_000 })
  await expect(availability).toContainText(`商品交付库存汇总：${stockBefore + 1}`, { timeout: 10_000 })

  // 重新进入 Offer-first 工作台作废 1 个，并验证 Offer/Product 分栏结果。
  const voidReason = `E2E 自动化作废 ${Date.now()}`
  await row.getByText('管理可售资源').click()
  await page.getByTestId('inventory-void-count').fill('1')
  await page.getByTestId('inventory-void-reason').fill(voidReason)
  await page.getByTestId('inventory-void-submit').click()

  await expect(page.getByText(/已作废 1 个交付单元；当前规格剩余 .*商品汇总/)).toBeVisible({ timeout: 10_000 })
  await expect(availability).toContainText(`商品交付库存汇总：${stockBefore}`, { timeout: 10_000 })

  // 资源记录只做安全投影，显示 Offer 而不显示交付内容。
  await row.getByText('可售资源记录').click()
  const logModal = page.getByTestId('inventory-log-modal')
  await expect(logModal).toBeVisible({ timeout: 10_000 })
  const logTable = page.getByTestId('inventory-log-table')
  const firstLogRow = logTable.locator('tbody tr').first()
  await expect(firstLogRow.getByText('作废', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(firstLogRow).toContainText('-1')
  await expect(firstLogRow).toContainText(voidReason)
  await expect(firstLogRow).not.toContainText(uniqueItem)

  // 关闭弹窗，净变化为 0，测试可重复执行。
  await logModal.getByRole('button', { name: '关闭' }).click()
  await expect(logModal).toBeHidden({ timeout: 10_000 })
})
