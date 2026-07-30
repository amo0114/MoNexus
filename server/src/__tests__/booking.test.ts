import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'
import { CaptureMailer } from '../lib/mailer/capture.js'
import { __setMailerForTesting } from '../lib/mailer/index.js'
import type { Mailer } from '../lib/mailer/types.js'
import { runBookingRemindBatch } from '../lib/bookingRemind.js'
import { addCalendarDays, businessDateString, calendarDayToUtc } from '../lib/businessTime.js'
import {
  api,
  authHeader,
  createTestMerchant,
  createTestProduct,
  createTestUser,
  getDefaultOfferId,
  loginAs,
} from './helpers.js'

/**
 * P6c：预约服务 v1（设计 §4 决策 ④，轻量形态——无 slot 日历）。
 * - 下单：date 字段答案列化进 Order.bookingDate（复审 P1-3：Asia/Shanghai
 *   业务日历日的 UTC 零点，与运行时区无关）+ 可约窗口校验；
 * - 展示：买家/商家列表与详情透出 bookingDate；商家列表 sort=booking 排期视图；
 * - 提醒：预约日为业务时区"明天"时 cron 双方各一封（runBookingRemindBatch）。
 */

const HOUR_MS = 60 * 60 * 1000

/** 业务日历日（今天 + N 天）的 YYYY-MM-DD 字符串（买家表单答案格式）。 */
function dayString(offsetDays: number, now = new Date()) {
  return addCalendarDays(businessDateString(now), offsetDays)
}

/** 业务日历日（今天 + N 天）的规范存储值：该日 UTC 零点。 */
function storedDay(offsetDays: number, now = new Date()) {
  return calendarDayToUtc(dayString(offsetDays, now))
}

/**
 * Reminder assertions must not derive their calendar date from wall clock.
 * Shanghai noon stays clear of the business-day rollover, while individual
 * boundary tests pass their own fixed clock explicitly.
 */
function fixedReminderNow() {
  return new Date('2026-07-30T04:00:00.000Z') // 12:00 Asia/Shanghai
}

/**
 * 距今 1~4 个月内首个不足 31 天的月份的「31 日」——真实日历不存在、
 * V8 解析会滚动到下月 1 日的日期（滚动结果仍落在宽窗口内，若不做
 * 往返校验就会以滚动后的日期建单）。
 */
function rolledDayString() {
  const [y0, m0] = businessDateString().split('-').map(Number)
  for (let i = 1; i <= 4; i++) {
    const y = y0 + Math.floor((m0 - 1 + i) / 12)
    const m = ((m0 - 1 + i) % 12) + 1
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
    if (daysInMonth < 31) {
      return `${y}-${String(m).padStart(2, '0')}-31`
    }
  }
  throw new Error('unreachable: 连续 4 个月不可能都是 31 天')
}

const DATE_FORM = [
  { key: 'serviceDate', label: '期望服务日期', type: 'date', required: true },
]

async function setPurchaseForm(productId: number, form: unknown) {
  await prisma.product.update({ where: { id: productId }, data: { purchaseForm: form as object[] } })
}

describe('booking date columnization at purchase', () => {
  it('stores the date answer as the calendar day\'s UTC midnight in Order.bookingDate and exposes it to the buyer', async () => {
    await createTestUser('bk-buyer@test.local', 'pass123', 'user', 1000)
    const product = await createTestProduct('预约商品', 100, 3, ['bk-1', 'bk-2', 'bk-3'])
    await setPurchaseForm(product.id, DATE_FORM)
    const { accessToken } = await loginAs('bk-buyer@test.local', 'pass123')

    const answer = dayString(3)
    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: product.id, formAnswers: { serviceDate: answer } })
      .expect(201)

    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } })
    expect(order.bookingDate).not.toBeNull()
    // 列化值 = 答案日历日的 UTC 零点（与运行时区无关）
    expect(order.bookingDate!.getTime()).toBe(storedDay(3).getTime())

    // 买家详情与列表行均透出 bookingDate
    const detail = await api
      .get(`/api/orders/${res.body.orderId}`)
      .set(authHeader(accessToken))
      .expect(200)
    expect(detail.body.bookingDate).toBe(order.bookingDate!.toISOString())

    const list = await api.get('/api/orders').set(authHeader(accessToken)).expect(200)
    const row = list.body.find((o: { id: number }) => o.id === res.body.orderId)
    expect(row.bookingDate).toBe(order.bookingDate!.toISOString())
  })

  it('orders without a date field keep bookingDate = null', async () => {
    await createTestUser('bk-nodate@test.local', 'pass123', 'user', 1000)
    const product = await createTestProduct('普通商品', 100, 1, ['nd-1'])
    const { accessToken } = await loginAs('bk-nodate@test.local', 'pass123')

    const res = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: product.id })
      .expect(201)

    const order = await prisma.order.findUniqueOrThrow({ where: { id: res.body.orderId } })
    expect(order.bookingDate).toBeNull()

    const detail = await api
      .get(`/api/orders/${res.body.orderId}`)
      .set(authHeader(accessToken))
      .expect(200)
    expect(detail.body.bookingDate).toBeNull()
  })

  it('enforces the booking window [today+min, today+max] through the real endpoint', async () => {
    await createTestUser('bk-window@test.local', 'pass123', 'user', 1000)
    const product = await createTestProduct('窗口商品', 100, 3, ['w-1', 'w-2', 'w-3'])
    await setPurchaseForm(product.id, [
      { key: 'serviceDate', label: '期望服务日期', type: 'date', required: true, minDaysAhead: 2, maxDaysAhead: 5 },
    ])
    const { accessToken } = await loginAs('bk-window@test.local', 'pass123')

    // 早于最早可约日 → 400
    const tooEarly = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: product.id, formAnswers: { serviceDate: dayString(1) } })
      .expect(400)
    expect(tooEarly.body.error.message).toContain('期望服务日期')

    // 晚于最晚可约日 → 400
    await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: product.id, formAnswers: { serviceDate: dayString(6) } })
      .expect(400)

    // 拒单必须无副作用
    expect(await prisma.order.count()).toBe(0)

    // 窗口内 → 201
    const ok = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: product.id, formAnswers: { serviceDate: dayString(3) } })
      .expect(201)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: ok.body.orderId } })
    expect(order.bookingDate!.getTime()).toBe(storedDay(3).getTime())
  })

  it('rejects rolled calendar dates (02-31 style) with 400 and no side effects', async () => {
    await createTestUser('bk-rolled@test.local', 'pass123', 'user', 1000)
    const product = await createTestProduct('滚动日期商品', 100, 2, ['r-1', 'r-2'])
    // 宽窗口：滚动后的日期（下月 1 日）本身在窗口内——没有往返校验时
    // 会以滚动结果建单（bookingDate 与答案 JSON 显示不一致，复审 P3）。
    await setPurchaseForm(product.id, [
      { key: 'serviceDate', label: '期望服务日期', type: 'date', required: true, minDaysAhead: 1, maxDaysAhead: 180 },
    ])
    const { accessToken } = await loginAs('bk-rolled@test.local', 'pass123')

    // 动态构造的滚动日期（窗口内的月份 + 不存在的 31 日）→ 400。
    const rolled = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: product.id, formAnswers: { serviceDate: rolledDayString() } })
      .expect(400)
    expect(rolled.body.error.message).toContain('不是有效日期')

    // 字面用例 2026-02-31：往返校验先于窗口校验，拒因必须是"无效日期"
    // 而非窗口越界（校验顺序与日历无关，用例不随时间失效）。
    const feb31 = await api
      .post('/api/orders')
      .set(authHeader(accessToken))
      .send({ productId: product.id, formAnswers: { serviceDate: '2026-02-31' } })
      .expect(400)
    expect(feb31.body.error.message).toContain('不是有效日期')

    // 拒单必须无副作用：无订单行（bookingDate 是 Order 列，一并不存在）。
    expect(await prisma.order.count()).toBe(0)
  })
})

describe('merchant order list sort=booking', () => {
  /** 直接落库造商家订单：受控 bookingDate / createdAt。 */
  async function seedOrders() {
    const { merchant } = await createTestMerchant('bk-sort-m@test.local', 'pass123', { status: 'active' })
    const { user } = await createTestUser('bk-sort-u@test.local', 'pass123', 'user', 1000)
    const product = await createTestProduct('排序商品', 100, 3, [], merchant.id)
    const offerId = await getDefaultOfferId(product.id)

    const base = {
      userId: user.id,
      productId: product.id,
      offerId,
      merchantId: merchant.id,
      price: 100,
      status: 'pending',
      deliveryModeSnapshot: 'manual_service',
    }
    const now = Date.now()
    // A：预约后天，下单最早；B：预约明天，下单居中；C：无预约，下单最晚
    const orderA = await prisma.order.create({
      data: { ...base, bookingDate: storedDay(2), createdAt: new Date(now - 3 * HOUR_MS) },
    })
    const orderB = await prisma.order.create({
      data: { ...base, bookingDate: storedDay(1), createdAt: new Date(now - 2 * HOUR_MS) },
    })
    const orderC = await prisma.order.create({
      data: { ...base, bookingDate: null, createdAt: new Date(now - 1 * HOUR_MS) },
    })
    return { orderA, orderB, orderC }
  }

  it('sort=booking puts booked orders first ascending, NULLs last; rows expose bookingDate', async () => {
    const { orderA, orderB, orderC } = await seedOrders()
    const { accessToken } = await loginAs('bk-sort-m@test.local', 'pass123')

    const res = await api
      .get('/api/merchant/orders')
      .query({ sort: 'booking' })
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.items.map((o: { id: number }) => o.id)).toEqual([orderB.id, orderA.id, orderC.id])
    expect(res.body.items[0].bookingDate).toBe(storedDay(1).toISOString())
    expect(res.body.items[1].bookingDate).toBe(storedDay(2).toISOString())
    expect(res.body.items[2].bookingDate).toBeNull()

    // 商家详情同样透出
    const detail = await api
      .get(`/api/merchant/orders/${orderB.id}`)
      .set(authHeader(accessToken))
      .expect(200)
    expect(detail.body.bookingDate).toBe(storedDay(1).toISOString())
  })

  it('without sort param the default createdAt-desc ordering is unchanged', async () => {
    const { orderA, orderB, orderC } = await seedOrders()
    const { accessToken } = await loginAs('bk-sort-m@test.local', 'pass123')

    const res = await api
      .get('/api/merchant/orders')
      .set(authHeader(accessToken))
      .expect(200)

    expect(res.body.items.map((o: { id: number }) => o.id)).toEqual([orderC.id, orderB.id, orderA.id])
  })
})

describe('runBookingRemindBatch', () => {
  let mailer: CaptureMailer

  beforeEach(() => {
    mailer = new CaptureMailer()
    __setMailerForTesting(mailer)
  })

  afterEach(() => {
    __setMailerForTesting(null)
  })

  /** 只对指定收件人失败、其余转发给 capture 的邮件器（模拟单侧故障）。 */
  function failingFor(recipient: string, inner: CaptureMailer): Mailer {
    return {
      async send(msg) {
        if (msg.to === recipient) throw new Error('smtp down')
        await inner.send(msg)
      },
    }
  }

  /** 直接落库造预约订单：受控 status / bookingDate。 */
  async function seedBookingOrder(input: {
    email: string
    status: string
    bookingDate: Date | null
  }) {
    const { user } = await createTestUser(input.email, 'pass123')
    const { merchant } = await createTestMerchant(`m-${input.email}`, 'pass123', {
      role: 'merchant',
      status: 'active',
    })
    const product = await prisma.product.create({
      data: {
        name: '预约服务',
        type: '网络节点',
        price: 300,
        status: 'active',
        merchantId: merchant.id,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
      },
    })
    const offer = await prisma.offer.create({
      data: {
        productId: product.id,
        name: '标准档',
        isDefault: true,
        price: 300,
        deliveryMode: 'manual_service',
        stockMode: 'unlimited',
        stock: 0,
      },
    })
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        productId: product.id,
        offerId: offer.id,
        merchantId: merchant.id,
        price: 300,
        status: input.status,
        deliveryModeSnapshot: 'manual_service',
        productNameSnapshot: '预约服务快照',
        offerNameSnapshot: '标准档快照',
        bookingDate: input.bookingDate,
      },
    })
    return { user, merchant, order }
  }

  async function getReminder(orderId: number) {
    return prisma.bookingReminder.findUnique({ where: { orderId } })
  }

  it('sends exactly two mails (buyer + merchant) per order due tomorrow, deduped across runs', async () => {
    const now = fixedReminderNow()
    const { order } = await seedBookingOrder({
      email: 'bk-remind@test.local',
      status: 'pending',
      bookingDate: storedDay(1, now),
    })

    await runBookingRemindBatch(now)

    expect(mailer.sent).toHaveLength(2)
    const buyerMail = mailer.lastTo('bk-remind@test.local')
    expect(buyerMail).toBeDefined()
    expect(buyerMail!.subject).toContain('预约提醒')
    expect(buyerMail!.subject).toContain(`#${order.id}`)
    expect(buyerMail!.text).toContain('预约服务快照 - 标准档快照')
    expect(buyerMail!.text).toContain(`预约日期：${dayString(1, now)}`)
    expect(buyerMail!.text).toContain('请留意履约安排')

    // 商家收件人 = contactEmail（helper 回填为登录邮箱）
    const merchantMail = mailer.lastTo('m-bk-remind@test.local')
    expect(merchantMail).toBeDefined()
    expect(merchantMail!.text).toContain('请按预约日期履约')

    expect(await getReminder(order.id)).not.toBeNull()

    // 再跑一轮不重发：BookingReminder 行去重
    await runBookingRemindBatch(new Date(now.getTime() + HOUR_MS))
    expect(mailer.sent).toHaveLength(2)
  })

  it('excludes bookings not on business-calendar tomorrow and delivered/refunded orders', async () => {
    const now = fixedReminderNow()
    // 后天的预约（业务日历"明天"才提醒）
    await seedBookingOrder({
      email: 'bk-far@test.local',
      status: 'pending',
      bookingDate: storedDay(2, now),
    })
    // 已过期的预约（提醒无意义）
    await seedBookingOrder({
      email: 'bk-past@test.local',
      status: 'processing',
      bookingDate: storedDay(-1, now),
    })
    // 终态订单不提醒
    await seedBookingOrder({
      email: 'bk-delivered@test.local',
      status: 'delivered',
      bookingDate: storedDay(1, now),
    })
    await seedBookingOrder({
      email: 'bk-refunded@test.local',
      status: 'refunded',
      bookingDate: storedDay(1, now),
    })
    // 无预约日期
    await seedBookingOrder({
      email: 'bk-null@test.local',
      status: 'pending',
      bookingDate: null,
    })

    await runBookingRemindBatch(now)

    expect(mailer.sent).toHaveLength(0)
    expect(await prisma.bookingReminder.count()).toBe(0)
  })

  it('merchant-side send failure leaves no row; the next run with a working mailer sends both again', async () => {
    const now = fixedReminderNow()
    const { order } = await seedBookingOrder({
      email: 'bk-retry@test.local',
      status: 'pending',
      bookingDate: storedDay(1, now),
    })

    // 商家侧失败、买家侧成功 → 不落行（无行 = 待发送，下轮整体重试）
    __setMailerForTesting(failingFor('m-bk-retry@test.local', mailer))
    await runBookingRemindBatch(now)
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0].to).toBe('bk-retry@test.local')
    expect(await getReminder(order.id)).toBeNull()

    // 恢复后下轮重发两封（买家会收到重复提醒——简单性换来的已知代价）
    __setMailerForTesting(mailer)
    const later = new Date(now.getTime() + HOUR_MS)
    await runBookingRemindBatch(later)
    expect(mailer.sent).toHaveLength(3)
    expect(mailer.sent.slice(1).map(m => m.to).sort()).toEqual([
      'bk-retry@test.local',
      'm-bk-retry@test.local',
    ])
    const reminder = await getReminder(order.id)
    expect(reminder).not.toBeNull()
    expect(reminder!.sentAt.getTime()).toBe(later.getTime())

    // 补发成功后不再重复
    await runBookingRemindBatch(new Date(later.getTime() + HOUR_MS))
    expect(mailer.sent).toHaveLength(3)
  })

  it('uses the supplied clock across the Shanghai near-midnight business-day boundary', async () => {
    // 23:30 +08: the next business day is already the next UTC calendar day
    // in this test's fixture.  The passed clock, not Date.now(), must define
    // both the persisted booking date and the reminder query window.
    const now = new Date('2026-07-30T15:30:00.000Z')
    const { order } = await seedBookingOrder({
      email: 'bk-boundary@test.local',
      status: 'processing',
      bookingDate: storedDay(1, now),
    })

    await runBookingRemindBatch(now)

    expect(mailer.sent).toHaveLength(2)
    expect(mailer.sent.map(m => m.to).sort()).toEqual([
      'bk-boundary@test.local',
      'm-bk-boundary@test.local',
    ])
    expect(await getReminder(order.id)).not.toBeNull()
  })
})
