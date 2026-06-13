import { expect, test } from '@playwright/test'
import { loginAs, SEED_ACCOUNTS } from './helpers'

const PRODUCT_NAME = `E2E评价商品-${Date.now()}`
const FIXED_URL = 'https://example.com/e2e-review'
const NICKNAME = 'E2E评价员'
const COMMENT = 'e2e 评价内容'

let productUrl = ''

/**
 * 评分评价全链路：
 * 1. 用户在个人中心设置昵称（评价展示名）
 * 2. 商家发布 instant_fixed 商品，用户购买后在订单详情提交 4 星评价
 * 3. 商品详情页展示评分摘要（4.0）与评价列表（昵称 + 内容）
 * 4. 用户修改一次评价为 5 星，editedAt 置位后不可再修改
 * 5. 商品详情页评分摘要更新为 5.0
 * 商品名带时间戳，每次运行独立，不依赖历史数据。
 */
test.describe.serial('product reviews flow', () => {
  test('user sets a nickname for review display', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)

    await page.goto('/profile')
    const card = page.getByTestId('nickname-card')
    await expect(card).toBeVisible({ timeout: 10_000 })

    await card.getByTestId('nickname-edit').click()
    await card.getByTestId('nickname-input').fill(NICKNAME)
    await card.getByTestId('nickname-save').click()

    await expect(page.getByText('昵称已更新')).toBeVisible({ timeout: 10_000 })
    await expect(card).toContainText(NICKNAME)
  })

  test('merchant publishes an instant_fixed product', async ({ page }) => {
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
  })

  test('user purchases and submits a 4-star review from order detail', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)

    // 商城搜索（300ms 防抖）找到商品并进入详情页
    await page.getByPlaceholder('搜账号、卡密、教程...').fill(PRODUCT_NAME)
    const card = page.getByText(PRODUCT_NAME)
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.click()
    await expect(page).toHaveURL(/\/product\/\d+/, { timeout: 10_000 })
    productUrl = page.url()

    await page.getByRole('button', { name: '立即兑换' }).click()
    await expect(page.getByText('确认兑换')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: '确认支付' }).click()
    await expect(page.getByTestId('success-delivery-link')).toBeVisible({ timeout: 10_000 })

    // 打开订单详情，提交 4 星评价
    await page.goto('/profile')
    const orderCard = page
      .locator('div.shadow-sm')
      .filter({ has: page.getByRole('heading', { name: PRODUCT_NAME }) })
      .first()
    await expect(orderCard).toBeVisible({ timeout: 10_000 })
    await orderCard.getByRole('button', { name: '查看发货内容' }).click()

    await page.getByTestId('review-create-button').click()
    await expect(page.getByTestId('review-dialog')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('star-input-4').click()
    await page.getByTestId('review-comment-input').fill(COMMENT)
    await page.getByTestId('review-submit').click()
    await expect(page.getByText('评价已提交')).toBeVisible({ timeout: 10_000 })

    // own-review 由本地 state 立即渲染：4 星 + 评价内容 + 可修改入口
    const ownReview = page.getByTestId('own-review')
    await expect(ownReview).toBeVisible({ timeout: 10_000 })
    await expect(ownReview.locator('[aria-label="评分 4 / 5"]')).toBeVisible()
    await expect(ownReview).toContainText(COMMENT)
    await expect(page.getByTestId('review-edit-button')).toBeVisible()
    // 评价入口按钮消失（已评过）
    await expect(page.getByTestId('review-create-button')).toHaveCount(0)
  })

  test('product detail shows rating summary 4.0 and the review', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)

    await page.goto(productUrl)
    await expect(page.getByTestId('rating-summary')).toContainText('4.0', { timeout: 10_000 })

    const reviewList = page.getByTestId('review-list')
    await expect(reviewList).toBeVisible({ timeout: 10_000 })
    await expect(reviewList).toContainText(NICKNAME)
    await expect(reviewList).toContainText(COMMENT)
  })

  test('user edits the review once to 5 stars and cannot edit again', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)

    await page.goto('/profile')
    const orderCard = page
      .locator('div.shadow-sm')
      .filter({ has: page.getByRole('heading', { name: PRODUCT_NAME }) })
      .first()
    await expect(orderCard).toBeVisible({ timeout: 10_000 })
    await orderCard.getByRole('button', { name: '查看发货内容' }).click()

    const ownReview = page.getByTestId('own-review')
    await expect(ownReview).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('review-edit-button').click()
    await expect(page.getByTestId('review-dialog')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('star-input-5').click()
    await page.getByTestId('review-submit').click()
    await expect(page.getByText('评价已修改')).toBeVisible({ timeout: 10_000 })

    // own-review 更新为 5 星，editedAt 已置 → 不再出现修改入口
    await expect(ownReview.locator('[aria-label="评分 5 / 5"]')).toBeVisible({ timeout: 10_000 })
    await expect(ownReview).toContainText(COMMENT)
    await expect(page.getByTestId('review-edit-button')).toHaveCount(0)
  })

  test('product detail rating summary updates to 5.0', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.user)

    await page.goto(productUrl)
    await expect(page.getByTestId('rating-summary')).toContainText('5.0', { timeout: 10_000 })
    await expect(page.getByTestId('review-list')).toContainText(COMMENT)
  })
})
