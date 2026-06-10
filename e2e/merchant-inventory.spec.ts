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

  // 清空搜索恢复列表
  await page.getByTestId('merchant-product-search').fill('')
  await expect(row).toBeVisible({ timeout: 10_000 })

  // 低库存开关：seed 商品库存 3 ≤ 阈值（默认 5），开启后仍可见且带低库存徽标
  const productId = (await row.locator('td').first().innerText()).trim()
  await page.getByTestId('merchant-product-lowstock-toggle').check()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId(`low-stock-badge-${productId}`)).toBeVisible()
  await page.getByTestId('merchant-product-lowstock-toggle').uncheck()
  await expect(row).toBeVisible({ timeout: 10_000 })

  // 读取当前库存（单元格形如 "3 / 0"）
  const stockCell = row.locator('td').nth(3)
  const stockBefore = parseInt((await stockCell.innerText()).trim(), 10)
  expect(Number.isInteger(stockBefore)).toBe(true)

  // 导入 1 条唯一库存，库存 +1
  const uniqueItem = `E2E-VOID-${Date.now()}`
  await row.getByText('导入库存').click()
  await page.locator('textarea').fill(uniqueItem)
  await page.getByRole('button', { name: '预览' }).click()
  await expect(page.getByText('预览结果')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: '确认导入' }).click()
  await expect(page.getByText('成功导入 1 条库存')).toBeVisible({ timeout: 10_000 })
  await expect(stockCell).toContainText(`${stockBefore + 1} / `, { timeout: 10_000 })

  // 打开库存流水：应已有导入记录
  await row.getByText('流水').click()
  const logModal = page.getByTestId('inventory-log-modal')
  await expect(logModal).toBeVisible({ timeout: 10_000 })
  const logTable = page.getByTestId('inventory-log-table')
  await expect(logTable.getByText('导入').first()).toBeVisible({ timeout: 10_000 })

  // 作废 1 条，断言流水新增 void 记录、库存数 -1
  const voidReason = `E2E 自动化作废 ${Date.now()}`
  await page.getByTestId('inventory-void-count').fill('1')
  await page.getByTestId('inventory-void-reason').fill(voidReason)
  await page.getByTestId('inventory-void-submit').click()

  await expect(page.getByText(/已作废 1 条库存/)).toBeVisible({ timeout: 10_000 })
  // 流水第一行应是刚产生的作废记录（-1 + 原因）
  const firstLogRow = logTable.locator('tbody tr').first()
  await expect(firstLogRow.getByText('作废', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(firstLogRow).toContainText('-1')
  await expect(firstLogRow).toContainText(voidReason)

  // 关闭弹窗，商品行库存恢复为导入前数值（净变化 0，可重复执行）
  await logModal.getByRole('button', { name: '关闭' }).click()
  await expect(logModal).toBeHidden({ timeout: 10_000 })
  await expect(stockCell).toContainText(`${stockBefore} / `, { timeout: 10_000 })
})
