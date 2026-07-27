import { config } from '../config/index.js'
import { logger } from './logger.js'
import { prisma } from './prisma.js'
import { getMailer } from './mailer/index.js'

/**
 * P6b：人工履约 SLA 超时提醒 cron（设计 §3 决策 ③，lowStockNotify 范式）。
 *
 * 硬规则：
 * - 超时**仅升级提醒**，不自动退款/不改订单状态（误伤风险；买家本就可争议）。
 * - 候选：status ∈ {pending, processing} 且 deliveryModeSnapshot='manual_service'
 *   且 fulfillmentDeadline 非空已过期；商家归属非空（平台自营无收件人）。
 * - 去重状态在 SlaReminder（orderId 唯一）：**每单一生只发一封**。行只在
 *   邮件发送成功后落——发送失败不落行（"无行 = 待发送"语义，下轮 cron
 *   重试，沿 P5.5/P6a 教训：绝不能让陈旧状态挡住重试）。
 * - 收件人：merchant.contactEmail ?? merchant.user.email（同低库存告警）。
 * - 单条失败（发信/DB）只 warn 并继续，绝不中断整批。
 * - 免配置：无 SystemConfig 项，节奏固定每小时一轮。
 */

const REMIND_INTERVAL_MS = 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

interface CandidateOrder {
  id: number
  status: string
  createdAt: Date
  fulfillmentDeadline: Date | null
  productNameSnapshot: string | null
  offerNameSnapshot: string | null
  product: { name: string }
  offer: { name: string } | null
  merchant: {
    contactEmail: string | null
    user: { email: string }
  } | null
}

function formatTime(d: Date) {
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

/** 买家等待时长的人话表述：不足 1 天按小时（至少 1 小时），否则"X 天 Y 小时"。 */
function formatWaitDuration(createdAt: Date, now: Date) {
  const elapsedMs = Math.max(now.getTime() - createdAt.getTime(), 0)
  const days = Math.floor(elapsedMs / DAY_MS)
  const hours = Math.floor((elapsedMs % DAY_MS) / HOUR_MS)
  if (days <= 0) return `${Math.max(hours, 1)} 小时`
  return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`
}

/** 展示名沿快照惯例：优先下单快照，null 回退当前商品/规格名。 */
function displayLabel(order: CandidateOrder) {
  const productName = order.productNameSnapshot ?? order.product.name
  const offerName = order.offerNameSnapshot ?? order.offer?.name ?? null
  return offerName ? `${productName} - ${offerName}` : productName
}

function buildMail(to: string, order: CandidateOrder, now: Date) {
  const label = displayLabel(order)
  // 查询已过滤 fulfillmentDeadline 非空；此处断言仅为类型收窄。
  const deadline = order.fulfillmentDeadline!
  return {
    to,
    subject: `【履约超时提醒】订单 #${order.id} 已超过履约截止时间`,
    text: [
      '您好，您有一笔人工服务订单已超过履约截止时间，买家仍在等待：',
      '',
      `订单号：#${order.id}`,
      `商品：${label}`,
      `履约截止时间：${formatTime(deadline)}`,
      `买家已等待：${formatWaitDuration(order.createdAt, now)}`,
      '',
      '请尽快登录商家后台，在「订单管理」待处理列表中接单/交付；',
      '长时间未履约可能引发买家争议，影响店铺信誉与结算。',
    ].join('\n'),
  }
}

async function processOrder(order: CandidateOrder, now: Date) {
  const recipient = order.merchant!.contactEmail ?? order.merchant!.user.email
  let sent = false
  try {
    const mailer = await getMailer()
    await mailer.send(buildMail(recipient, order, now))
    sent = true
  } catch (err) {
    logger.warn({ err, orderId: order.id, recipient }, 'sla overdue mail send failed')
  }
  // 发送失败不落行——SlaReminder 行是"已发过"的唯一凭据，下轮据此重试。
  if (!sent) return
  await prisma.slaReminder.create({
    data: { orderId: order.id, sentAt: now },
  })
}

let timer: NodeJS.Timeout | null = null
let running = false

export async function runSlaRemindBatch(now = new Date()) {
  if (running) return
  running = true
  try {
    const orders = await prisma.order.findMany({
      where: {
        status: { in: ['pending', 'processing'] },
        deliveryModeSnapshot: 'manual_service',
        fulfillmentDeadline: { not: null, lt: now },
        // 每单一封：已有提醒行的在 DB 侧排除，避免历史订单逐轮重复扫描。
        slaReminder: null,
        merchantId: { not: null },
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
        fulfillmentDeadline: true,
        productNameSnapshot: true,
        offerNameSnapshot: true,
        product: { select: { name: true } },
        offer: { select: { name: true } },
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
        logger.warn({ err, orderId: order.id }, 'sla remind order processing failed')
      }
    }
  } catch (err) {
    logger.error({ err }, 'sla remind batch failed')
  } finally {
    running = false
  }
}

export function startSlaRemindCron() {
  if (config.nodeEnv === 'test') return
  if (timer) return
  runSlaRemindBatch().catch(err => logger.error({ err }, 'sla remind initial run failed'))
  timer = setInterval(() => {
    runSlaRemindBatch().catch(err => logger.error({ err }, 'sla remind tick failed'))
  }, REMIND_INTERVAL_MS)
  timer.unref?.()
  logger.info({ intervalMs: REMIND_INTERVAL_MS }, 'sla remind cron started')
}

export function stopSlaRemindCron() {
  if (!timer) return
  clearInterval(timer)
  timer = null
  logger.info('sla remind cron stopped')
}
