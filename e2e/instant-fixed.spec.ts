import { expect, test } from '@playwright/test'
import { loginAs, SEED_ACCOUNTS } from './helpers'

const PRODUCT_NAME = `E2E固定内容商品-${Date.now()}`
const FIXED_URL = 'https://example.com/e2e-invite'

/**
 * instant_fixed（固定内容直发）全链路：
 * 1. 商家发布外部链接型固定内容商品（不限库存）
 * 2. 用户购买后立即在成功弹窗收到可点击链接
 * 3. 用户在订单详情看到链接并发起争议
 * 4. 商家驳回争议（恢复履约），用户侧订单回到「已交付」
 * 商品名带时间戳，每次运行独立，不依赖历史数据。
 */
test.describe.serial('instant_fixed delivery flow', () => {
  test('merchant publishes an instant_fixed product with url content', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.merchant)

    await page.goto('/merchant')
    await page.getByRole('button', { name: '商品管理' }).click()
    await expect(page.getByTestId('merchant-product-filters')).toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: '新建商品' }).click()
    await expect(page.getByText('发布新商品')).toBeVisible({ timeout: 10_000 })

    await page.getByPlaceholder('输入吸引人的商品名称').fill(PRODUCT_NAME)
    await page.locator('#productForm select').first().selectOption('邀请码')
    await page.getByRole('radio', { name: '固定内容直发' }).check()
    await page.getByRole('radio', { name: '外部链接' }).check()
    await page.getByTestId('fixed-content-input').fill(FIXED_URL)
    // 库存模式保持默认「不限库存」
    await expect(page.getByTestId('stock-mode-select')).toHaveValue('unlimited')
    // 价格设为 1 积分，保证 seed 用户余额充足
    await page.locator('#productForm input[type="number"][required]').fill('1')

    await page.getByRole('button', { name: '确认保存' }).click()
    await expect(page.getByText('商品创建成功')).toBeVisible({ timeout: 10_000 })

    // 列表搜索能命中新商品
    await page.getByTestId('merchant-product-search').fill(PRODUCT_NAME)
    await expect(page.locator('tbody tr').filter({ hasText: PRODUCT_NAME })).toBeVisible({ timeout: 10_000 })
  })

  test('user purchases and immediately receives a clickable link', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)

    // 商城搜索（300ms 防抖）找到商品并进入详情页
    await page.getByPlaceholder('搜账号、卡密、教程...').fill(PRODUCT_NAME)
    const card = page.getByText(PRODUCT_NAME)
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.click()
    await expect(page).toHaveURL(/\/product\/\d+/, { timeout: 10_000 })

    // 不限库存商品详情页显示「不限」，可购买
    await expect(page.getByText('不限', { exact: true })).toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: '立即兑换' }).click()
    await expect(page.getByText('确认兑换')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: '确认支付' }).click()

    // 成功弹窗：交付内容渲染为可点击链接
    const successLink = page.getByTestId('success-delivery-link')
    await expect(successLink).toBeVisible({ timeout: 10_000 })
    await expect(successLink).toHaveAttribute('href', FIXED_URL)
  })

  test('order detail shows the link and user can raise a dispute', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)

    await page.goto('/profile')
    const orderCard = page
      .locator('div.shadow-sm')
      .filter({ has: page.getByRole('heading', { name: PRODUCT_NAME }) })
      .first()
    await expect(orderCard).toBeVisible({ timeout: 10_000 })
    await expect(orderCard.getByText('已交付')).toBeVisible()

    await orderCard.getByRole('button', { name: '查看发货内容' }).click()
    const deliveryLink = page.getByTestId('delivery-link')
    await expect(deliveryLink).toBeVisible({ timeout: 10_000 })
    await expect(deliveryLink).toHaveAttribute('href', FIXED_URL)

    // 发起争议
    await page.getByTestId('order-dispute-button').click()
    await page.getByTestId('dispute-dialog-confirm').click()
    await expect(page.getByText('操作成功')).toBeVisible({ timeout: 10_000 })

    // 列表不会自动刷新，重载后断言状态为「争议中」
    await page.reload()
    await expect(orderCard).toBeVisible({ timeout: 10_000 })
    await expect(orderCard.getByText('争议中')).toBeVisible({ timeout: 10_000 })
  })

  test('merchant resumes the dispute and user sees delivered again', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.merchant)

    await page.goto('/merchant')
    await page.getByRole('button', { name: '订单管理' }).click()
    const orderRow = page.locator('tbody tr').filter({ hasText: PRODUCT_NAME }).first()
    await expect(orderRow).toBeVisible({ timeout: 10_000 })
    await expect(orderRow.getByText('争议中')).toBeVisible()

    await orderRow.getByRole('button', { name: '处理争议' }).click()
    await expect(page.getByTestId('merchant-dispute-dialog')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('merchant-dispute-resume').click()
    await expect(page.getByText('争议处理成功')).toBeVisible({ timeout: 10_000 })
    await expect(orderRow.getByText('已交付')).toBeVisible({ timeout: 10_000 })

    // 用户侧订单状态回到「已交付」
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto('/profile')
    const orderCard = page
      .locator('div.shadow-sm')
      .filter({ has: page.getByRole('heading', { name: PRODUCT_NAME }) })
      .first()
    await expect(orderCard).toBeVisible({ timeout: 10_000 })
    await expect(orderCard.getByText('已交付')).toBeVisible({ timeout: 10_000 })
  })
})
