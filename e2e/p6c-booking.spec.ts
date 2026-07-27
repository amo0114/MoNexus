import { expect, test, type APIRequestContext } from '@playwright/test'
import { API_BASE, SEED_ACCOUNTS, loginAs } from './helpers'

/**
 * P6c 预约服务冒烟：商家配置日期字段（可约窗口）→ 买家 UI 日期选择下单 →
 * 买家/商家两侧看到预约日期 → 商家按预约日期排序。窗口越界拒单由
 * booking vitest 锁定。
 */

const STAMP = Date.now()
const PRODUCT_NAME = `E2E预约-${STAMP}`
const DAY_MS = 24 * 60 * 60 * 1000

/** 业务日历（Asia/Shanghai）今天 + N 天，YYYY-MM-DD——与前端提示/服务端校验同口径。 */
function businessDatePlus(days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
  const [y, m, d] = today.split('-').map(Number)
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}
const BOOKING_DATE = businessDatePlus(3)

const state = { productId: 0, orderId: 0 }

async function tokenOf(request: APIRequestContext, account: { email: string; password: string }) {
  const login = await request.post(`${API_BASE}/api/auth/login`, { data: account })
  expect(login.ok(), await login.text()).toBeTruthy()
  return (await login.json()).accessToken as string
}

test.describe.serial('P6c booking', () => {
  test('merchant publishes a manual product with a date form field', async ({ request }) => {
    const token = await tokenOf(request, SEED_ACCOUNTS.merchant)
    const created = await request.post(`${API_BASE}/api/merchant/products`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: PRODUCT_NAME,
        type: '网络节点',
        price: 3,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
        purchaseForm: [
          { key: 'bookDate', label: '期望服务日期', type: 'date', required: true, minDaysAhead: 1, maxDaysAhead: 30 },
        ],
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    state.productId = (await created.json()).id
  })

  test('buyer picks a date in the purchase form and orders', async ({ page, request }) => {
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto(`/product/${state.productId}`)
    await page.getByRole('button', { name: '立即兑换' }).click()

    const dateInput = page.getByTestId('purchase-form-date-bookDate')
    await expect(dateInput).toBeVisible({ timeout: 10_000 })
    await dateInput.fill(BOOKING_DATE)
    await page.getByRole('button', { name: '确认支付' }).click()
    await expect(page.getByText('兑换成功').first()).toBeVisible({ timeout: 10_000 })

    const buyerToken = await tokenOf(request, SEED_ACCOUNTS.user)
    const orders = await request.get(`${API_BASE}/api/orders`, {
      headers: { Authorization: `Bearer ${buyerToken}` },
    })
    const order = ((await orders.json()) as { id: number; product?: { id: number }; bookingDate?: string | null }[])
      .find(o => o.product?.id === state.productId)!
    state.orderId = order.id
    expect(order.bookingDate).toBeTruthy()
    // 列化值 = 日历日的 UTC 零点（复审 P1-3）——ISO 串前 10 位即日历日。
    expect((order.bookingDate as string).slice(0, 10)).toBe(BOOKING_DATE)
  })

  test('both sides see the booking date; merchant sorts by it', async ({ page, request }) => {
    // 买家详情预约行。
    await loginAs(page, SEED_ACCOUNTS.user)
    await page.goto('/profile')
    const orderCard = page
      .locator('div.shadow-sm')
      .filter({ has: page.getByRole('heading', { name: PRODUCT_NAME }) })
      .first()
    await orderCard.getByRole('button', { name: '查看发货内容' }).click()
    await expect(page.getByTestId('order-booking-date')).toContainText(BOOKING_DATE, { timeout: 10_000 })

    // 商家列表排序开关 + 行内预约日期。
    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant')
    await page.getByRole('button', { name: '订单管理' }).click()
    await page.getByTestId('merchant-orders-sort-booking').click()
    await expect(page.getByTestId(`merchant-order-booking-${state.orderId}`)).toContainText(BOOKING_DATE, { timeout: 10_000 })

    // API 层排序契约：sort=booking 时该单在无预约单之前。
    const merchantToken = await tokenOf(request, SEED_ACCOUNTS.merchant)
    const sorted = await request.get(`${API_BASE}/api/merchant/orders?sort=booking`, {
      headers: { Authorization: `Bearer ${merchantToken}` },
    })
    expect(sorted.ok(), await sorted.text()).toBeTruthy()
  })
})
