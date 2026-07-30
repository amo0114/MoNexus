import { config } from '../config/index.js'
import { logger } from './logger.js'
import { prisma } from './prisma.js'
import { getMailer } from './mailer/index.js'
import { addCalendarDays, businessDateString, calendarDayToUtc, formatCalendarDay } from './businessTime.js'
import { acquireCronLeaseWithHeartbeat, type CronLeaseHandle } from './cronLease.js'

/**
 * P6c：预约日前 1 天提醒 cron（设计 §4 决策 ④，slaRemind 范式）。
 *
 * 硬规则：
 * - 候选：bookingDate 非空、status ∈ {pending, processing}、预约日为业务
 *   时区（Asia/Shanghai）的"明天"；商家归属非空（平台自营无商家收件人）。
 * - 每单发**两封**：买家（order.user.email）+ 商家（contactEmail ??
 *   merchant.user.email）。去重状态在 BookingReminder（orderId 唯一）：
 *   **两封都发送成功**才落行——部分/全部失败只 warn 不落行（"无行 =
 *   待发送"语义，下轮 cron 对两封整体重试）。已知代价：若买家侧成功、
 *   商家侧失败，下轮会给买家重发一封重复提醒——用重复提醒换掉逐收件人
 *   去重状态机的复杂度（提醒重复无害，漏发有害），如实取简。
 * - 单条失败（发信/DB）只 warn 并继续，绝不中断整批。
 * - 免配置：无 SystemConfig 项，节奏固定每小时一轮。
 */

const REMIND_INTERVAL_MS = 60 * 60 * 1000

interface CandidateOrder {
  id: number
  bookingDate: Date | null
  productNameSnapshot: string | null
  offerNameSnapshot: string | null
  product: { name: string }
  offer: { name: string } | null
  user: { email: string }
  merchant: {
    contactEmail: string | null
    user: { email: string }
  } | null
}

/** 预约日按存储的日历日展示（UTC 零点规范存储，见 businessTime.ts）。 */
function formatBookingDay(d: Date) {
  return formatCalendarDay(d)
}

/** 展示名沿快照惯例：优先下单快照，null 回退当前商品/规格名。 */
function displayLabel(order: CandidateOrder) {
  const productName = order.productNameSnapshot ?? order.product.name
  const offerName = order.offerNameSnapshot ?? order.offer?.name ?? null
  return offerName ? `${productName} - ${offerName}` : productName
}

function buildMail(to: string, order: CandidateOrder, role: 'buyer' | 'merchant') {
  const label = displayLabel(order)
  // 查询已过滤 bookingDate 非空；此处断言仅为类型收窄。
  const bookingDay = formatBookingDay(order.bookingDate!)
  const roleLine = role === 'buyer'
    ? '您预约的服务将于明天开始，请留意履约安排。'
    : '您有一笔预约服务订单将于明天到期，请按预约日期履约。'
  return {
    to,
    subject: `【预约提醒】订单 #${order.id} 预约日期为 ${bookingDay}`,
    text: [
      roleLine,
      '',
      `订单号：#${order.id}`,
      `商品：${label}`,
      `预约日期：${bookingDay}`,
    ].join('\n'),
  }
}

async function processOrder(order: CandidateOrder, now: Date) {
  const buyerTo = order.user.email
  const merchantTo = order.merchant!.contactEmail ?? order.merchant!.user.email
  const mailer = await getMailer()

  let buyerSent = false
  try {
    await mailer.send(buildMail(buyerTo, order, 'buyer'))
    buyerSent = true
  } catch (err) {
    logger.warn({ err, orderId: order.id, recipient: buyerTo }, 'booking remind buyer mail send failed')
  }

  let merchantSent = false
  try {
    await mailer.send(buildMail(merchantTo, order, 'merchant'))
    merchantSent = true
  } catch (err) {
    logger.warn({ err, orderId: order.id, recipient: merchantTo }, 'booking remind merchant mail send failed')
  }

  // 两封都成功才落行；部分成功不落行，下轮整体重试（成功侧可能收到
  // 重复提醒——见文件头注释，简单性换来的已知代价）。
  if (!buyerSent || !merchantSent) return
  await prisma.bookingReminder.create({
    data: { orderId: order.id, sentAt: now },
  })
}

let timer: NodeJS.Timeout | null = null
let running = false

export async function runBookingRemindBatch(now = new Date()) {
  if (running) return
  running = true
  let lease: CronLeaseHandle | null = null
  try {
    // P7a：舰队租约——领不到说明本窗口已有实例执行，跳过本 tick（test 直通）。
    lease = await acquireCronLeaseWithHeartbeat('bookingRemind', REMIND_INTERVAL_MS)
    if (!lease) return
    const orders = await prisma.order.findMany({
      where: {
        status: { in: ['pending', 'processing'] },
        // 复审 P1-3：候选 = 预约日为业务时区（Asia/Shanghai）的"明天"——
        // 提醒语义是"预约日前 1 天"，按业务日历判定，与运行时区无关。
        // 存储为日历日 UTC 零点，等值窗口 [明天, 后天)。
        bookingDate: {
          gte: calendarDayToUtc(addCalendarDays(businessDateString(now), 1)),
          lt: calendarDayToUtc(addCalendarDays(businessDateString(now), 2)),
        },
        // 已提醒过的在 DB 侧排除，避免历史订单逐轮重复扫描。
        bookingReminder: null,
        merchantId: { not: null },
      },
      select: {
        id: true,
        bookingDate: true,
        productNameSnapshot: true,
        offerNameSnapshot: true,
        product: { select: { name: true } },
        offer: { select: { name: true } },
        user: { select: { email: true } },
        merchant: {
          select: {
            contactEmail: true,
            user: { select: { email: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
    })

    for (const order of orders) {
      if (!order.merchant) continue
      try {
        await processOrder(order, now)
      } catch (err) {
        // 单条 DB 失败不拖垮整批，留给下一轮重试。
        logger.warn({ err, orderId: order.id }, 'booking remind order processing failed')
      }
    }
  } catch (err) {
    logger.error({ err }, 'booking remind batch failed')
  } finally {
    lease?.release()
    running = false
  }
}

export function startBookingRemindCron() {
  if (config.nodeEnv === 'test') return
  if (timer) return
  runBookingRemindBatch().catch(err => logger.error({ err }, 'booking remind initial run failed'))
  timer = setInterval(() => {
    runBookingRemindBatch().catch(err => logger.error({ err }, 'booking remind tick failed'))
  }, REMIND_INTERVAL_MS)
  timer.unref?.()
  logger.info({ intervalMs: REMIND_INTERVAL_MS }, 'booking remind cron started')
}

export function stopBookingRemindCron() {
  if (!timer) return
  clearInterval(timer)
  timer = null
  logger.info('booking remind cron stopped')
}
