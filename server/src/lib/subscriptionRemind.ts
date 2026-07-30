import { config } from '../config/index.js'
import { logger } from './logger.js'
import { prisma } from './prisma.js'
import { getMailer } from './mailer/index.js'
import { getSystemConfigValue } from './systemConfig.js'
import { acquireCronLeaseWithHeartbeat, type CronLeaseHandle } from './cronLease.js'

/**
 * P6a T4：订阅到期提醒邮件 cron（设计 §2/§7，lowStockNotify 范式）。
 *
 * 硬规则：
 * - 候选一律按 DeliveryRecord.expiresAt（非空 = 订阅型交付）；关联订单
 *   状态排除 refunded——已退款订阅无提醒意义，但 closed/过期订单照常提醒
 *   （订阅有效期独立于订单关单，见 §2"到期不引入新订单状态"）。收件人
 *   固定为买家账号邮箱 order.user.email。
 * - 每 tick 读 SystemConfig `subscriptionRemindDays`（0 = 关闭到期前提醒，
 *   只发到期邮件）。
 * - 两段式提醒，去重状态在 SubscriptionReminder（orderId 唯一）：
 *     无行            + 窗口内（expiresAt - N 天 <= now < expiresAt）→ 发"即将到期"，成功落 pre；
 *     无行或 pre      + now >= expiresAt                            → 发"已到期"，成功落 expired；
 *     expired         → 终态，不再发。
 *   lastStage 只在邮件**发送成功后**推进；发送失败**不建行/不改行**——
 *   显式保持"待发送"语义，下轮 cron 重试（沿 P5.5 复审教训：绝不能让
 *   陈旧状态挡住重试）。
 * - 积压护栏：处理时 expiresAt 已过期超过 7 天的订阅**不发信**，只静默
 *   落 lastStage='expired'——首次上线时存量早已到期的订阅会整批进入
 *   候选，若照发会向陈年订单群发"已到期"骚扰邮件；直接标记终态跳过。
 * - 单条失败（发信/DB）只 warn 并继续，绝不中断整批。
 */

const REMIND_INTERVAL_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
// 到期超过 7 天视为历史积压，只标记不发信（见文件头"积压护栏"）。
const EXPIRED_BACKLOG_MS = 7 * DAY_MS

interface CandidateRecord {
  orderId: number
  expiresAt: Date | null
  order: {
    id: number
    productNameSnapshot: string | null
    offerNameSnapshot: string | null
    user: { email: string }
    product: { name: string }
    offer: { name: string } | null
    subscriptionReminder: { lastStage: string } | null
  }
}

function formatExpiry(d: Date) {
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** 展示名沿快照惯例：优先下单快照，null 回退当前商品/规格名。 */
function displayNames(order: CandidateRecord['order']) {
  const productName = order.productNameSnapshot ?? order.product.name
  const offerName = order.offerNameSnapshot ?? order.offer?.name ?? null
  return { productName, label: offerName ? `${productName} - ${offerName}` : productName }
}

function buildPreMail(to: string, order: CandidateRecord['order'], expiresAt: Date) {
  const { label } = displayNames(order)
  return {
    to,
    subject: `【订阅即将到期】${label}`,
    text: [
      '您好，您购买的订阅即将到期：',
      '',
      `商品：${label}`,
      `订单号：#${order.id}`,
      `到期时间：${formatExpiry(expiresAt)}`,
      '',
      '如需继续使用，请到订单详情点击「续费」，避免服务中断。',
    ].join('\n'),
  }
}

function buildExpiredMail(to: string, order: CandidateRecord['order'], expiresAt: Date) {
  const { label } = displayNames(order)
  return {
    to,
    subject: `【订阅已到期】${label}`,
    text: [
      '您好，您购买的订阅已经到期：',
      '',
      `商品：${label}`,
      `订单号：#${order.id}`,
      `到期时间：${formatExpiry(expiresAt)}`,
      '',
      '如需恢复使用，请到订单详情点击「续费」重新开通。',
    ].join('\n'),
  }
}

async function upsertReminder(orderId: number, stage: 'pre' | 'expired', now: Date) {
  await prisma.subscriptionReminder.upsert({
    where: { orderId },
    create: { orderId, lastStage: stage, lastSentAt: now },
    update: { lastStage: stage, lastSentAt: now },
  })
}

async function processRecord(record: CandidateRecord, remindDays: number, now: Date) {
  // 查询已过滤 expiresAt 非空；此处断言仅为类型收窄。
  const expiresAt = record.expiresAt!
  const reminder = record.order.subscriptionReminder
  // expired 是终态（查询已排除，这里是防御性冗余）。
  if (reminder?.lastStage === 'expired') return

  const recipient = record.order.user.email

  if (now.getTime() >= expiresAt.getTime()) {
    // —— 已到期阶段：无行或 pre 都要发（remindDays=0 / 错过窗口时直发已到期）——
    if (now.getTime() - expiresAt.getTime() > EXPIRED_BACKLOG_MS) {
      // 积压护栏：首次上线时存量订阅可能早已到期数月，若照发会整批群发
      // 陈年"已到期"邮件骚扰买家。超过 7 天的直接静默落终态、不发信——
      // lastSentAt 记处理时刻仅作审计，不代表真的发过。
      await upsertReminder(record.orderId, 'expired', now)
      return
    }
    let sent = false
    try {
      const mailer = await getMailer()
      await mailer.send(buildExpiredMail(recipient, record.order, expiresAt))
      sent = true
    } catch (err) {
      logger.warn({ err, orderId: record.orderId, recipient }, 'subscription expired mail send failed')
    }
    // 发送失败不落/不改状态行——无行或 pre 原样保留即"待发送"，下轮重试。
    // 绝不能先写 expired 再发信，否则失败后被终态挡住永不重试。
    if (!sent) return
    await upsertReminder(record.orderId, 'expired', now)
    return
  }

  // —— 到期前阶段：仅 remindDays > 0 且窗口内（查询上界已保证 <= now + N 天）——
  if (remindDays <= 0) return
  // 已有行（pre）= 本轮到期前提醒已发过，等到期阶段再发第二封。
  if (reminder) return
  let sent = false
  try {
    const mailer = await getMailer()
    await mailer.send(buildPreMail(recipient, record.order, expiresAt))
    sent = true
  } catch (err) {
    logger.warn({ err, orderId: record.orderId, recipient }, 'subscription pre-expiry mail send failed')
  }
  // 发送失败不建行——"无行 = 待发送"，下轮 cron 重试（同上，失败必须保持可重试）。
  if (!sent) return
  await upsertReminder(record.orderId, 'pre', now)
}

let timer: NodeJS.Timeout | null = null
let running = false

export async function runSubscriptionRemindBatch(now = new Date()) {
  if (running) return
  running = true
  let lease: CronLeaseHandle | null = null
  try {
    // P7a：舰队租约——领不到说明本窗口已有实例执行，跳过本 tick（test 直通）。
    lease = await acquireCronLeaseWithHeartbeat('subscriptionRemind', REMIND_INTERVAL_MS)
    if (!lease) return
    const remindDays = await getSystemConfigValue('subscriptionRemindDays')

    // 候选上界 = now + N 天：remindDays=0 时只剩已到期记录。已落 expired
    // 终态的在 DB 侧排除，避免历史订阅逐轮重复扫描。
    const windowEnd = new Date(now.getTime() + Math.max(remindDays, 0) * DAY_MS)
    const records = await prisma.deliveryRecord.findMany({
      where: {
        expiresAt: { not: null, lte: windowEnd },
        order: {
          // 已退款订阅不提醒；closed 等其余状态照常（订阅生命周期独立于关单）。
          status: { notIn: ['refunded'] },
          // 已有未退款续费单的订单不再提醒——续费必须在链尾发起，对已续费
          // 的原单催续费会诱导重复付费；续费单被退款后原单恢复提醒。
          renewals: { none: { status: { not: 'refunded' } } },
          OR: [
            { subscriptionReminder: null },
            { subscriptionReminder: { lastStage: { not: 'expired' } } },
          ],
        },
      },
      select: {
        orderId: true,
        expiresAt: true,
        order: {
          select: {
            id: true,
            productNameSnapshot: true,
            offerNameSnapshot: true,
            user: { select: { email: true } },
            product: { select: { name: true } },
            offer: { select: { name: true } },
            subscriptionReminder: { select: { lastStage: true } },
          },
        },
      },
      orderBy: { orderId: 'asc' },
    })

    for (const record of records) {
      try {
        await processRecord(record, remindDays, now)
      } catch (err) {
        // 单条 DB 失败不拖垮整批，留给下一轮重试。
        logger.warn({ err, orderId: record.orderId }, 'subscription remind order processing failed')
      }
    }
  } catch (err) {
    logger.error({ err }, 'subscription remind batch failed')
  } finally {
    lease?.release()
    running = false
  }
}

export function startSubscriptionRemindCron() {
  if (config.nodeEnv === 'test') return
  if (timer) return
  runSubscriptionRemindBatch().catch(err => logger.error({ err }, 'subscription remind initial run failed'))
  timer = setInterval(() => {
    runSubscriptionRemindBatch().catch(err => logger.error({ err }, 'subscription remind tick failed'))
  }, REMIND_INTERVAL_MS)
  timer.unref?.()
  logger.info({ intervalMs: REMIND_INTERVAL_MS }, 'subscription remind cron started')
}

export function stopSubscriptionRemindCron() {
  if (!timer) return
  clearInterval(timer)
  timer = null
  logger.info('subscription remind cron stopped')
}
