import { config } from '../config/index.js'
import { logger } from './logger.js'
import { prisma } from './prisma.js'
import { getMailer } from './mailer/index.js'
import { getSystemConfigValue } from './systemConfig.js'
import { acquireCronLeaseWithHeartbeat, type CronLeaseHandle } from './cronLease.js'

/**
 * P5.5 T3：SKU 级低库存邮件告警（设计 §3，评审修订后口径）。
 *
 * 硬规则：
 * - 粒度一律按 Offer：instant_inventory 数 available 库存项；其余
 *   stockMode='limited' 的规格看 Offer.stock；unlimited 不参与。仅对
 *   在售商品（Product.status='active'）的启用规格（Offer.status='active'）
 *   且商品归属商家（merchantId 非空——平台自营无收件人）告警。
 * - 去重状态在 LowStockNotice（offerId 唯一，随 Offer 级联删除）。
 *   `lastNotifiedAt` 只在邮件**发送成功后**写入；发送失败**显式清为
 *   null**（不能保留旧值——回升复位会留下上一轮成功的时间戳，沿用它
 *   会让重试被冷却期误挡），下轮 cron 以"null = 待发送"语义重试。
 * - 状态迁移：跨入低位（无行或 isLow=false）→ 发信；持续低位仅当
 *   上次发送失败（lastNotifiedAt 为 null）或冷却期
 *   （lowStockNotifyCooldownHours > 0）已满时重发；0 = 持续低位期间
 *   永不重发。回升到阈值之上 → isLow 复位（保留 lastNotifiedAt），
 *   再次跌破视为新一轮跨入、立即告警。
 * - 单条失败（发信/DB）只 warn 并继续，绝不中断整批。
 */

const NOTIFY_INTERVAL_MS = 60 * 60 * 1000

interface CandidateOffer {
  id: number
  name: string
  deliveryMode: string
  stock: number
  product: {
    id: number
    name: string
    merchant: {
      contactEmail: string | null
      user: { email: string }
    } | null
  }
}

/** 现存量口径与商家列表徽标一致：即时库存实时 count，容量型看 Offer.stock。 */
async function getAvailableCount(offer: CandidateOffer): Promise<number> {
  if (offer.deliveryMode === 'instant_inventory') {
    return prisma.inventoryItem.count({
      where: { offerId: offer.id, status: 'available' },
    })
  }
  return offer.stock
}

function buildMail(to: string, offer: CandidateOffer, available: number, threshold: number) {
  return {
    to,
    subject: `【低库存预警】${offer.product.name} - ${offer.name} 仅剩 ${available} 件`,
    text: [
      '您好，您的商品有规格库存已跌至预警阈值以下：',
      '',
      `商品：${offer.product.name}`,
      `规格：${offer.name}`,
      `当前可用库存：${available} 件`,
      `预警阈值：${threshold} 件`,
      '',
      '请尽快登录商家后台补充库存或调整规格容量，避免影响买家下单。',
    ].join('\n'),
  }
}

async function processOffer(offer: CandidateOffer, threshold: number, cooldownHours: number, now: Date) {
  const available = await getAvailableCount(offer)
  const notice = await prisma.lowStockNotice.findUnique({ where: { offerId: offer.id } })

  if (available > threshold) {
    // 回升复位：只清 isLow，保留 lastNotifiedAt——重发冷却只约束"同一轮
    // 持续低位"，新一轮跨入必须立即告警。
    if (notice?.isLow) {
      await prisma.lowStockNotice.update({
        where: { offerId: offer.id },
        data: { isLow: false, lastAvailable: available },
      })
    }
    return
  }

  const crossing = !notice || !notice.isLow
  const needSend = crossing
    // 持续低位：lastNotifiedAt 为 null 意味着上次发送失败，必须重试；
    // 否则仅冷却期开启（>0）且已满时重发。
    || notice.lastNotifiedAt == null
    || (cooldownHours > 0 && now.getTime() - notice.lastNotifiedAt.getTime() >= cooldownHours * 60 * 60 * 1000)

  if (!needSend) {
    // 不重发也要刷新观测值，保持状态行反映最近一次巡检。
    await prisma.lowStockNotice.update({
      where: { offerId: offer.id },
      data: { lastAvailable: available },
    })
    return
  }

  const recipient = offer.product.merchant!.contactEmail ?? offer.product.merchant!.user.email
  let sent = false
  try {
    const mailer = await getMailer()
    await mailer.send(buildMail(recipient, offer, available, threshold))
    sent = true
  } catch (err) {
    logger.warn({ err, offerId: offer.id, recipient }, 'low stock notify mail send failed')
  }

  // 发送失败也要落 isLow=true（避免下轮误判为"跨入"），且必须把
  // lastNotifiedAt **显式清为 null**——回升复位保留着上一轮成功的时间戳，
  // "再次跌破 + 发送失败"若沿用旧值，下轮会被冷却期挡住而不重试
  // （cooldown=0 时更是永不重试），违背"失败下轮重试"（复审阻断项）。
  await prisma.lowStockNotice.upsert({
    where: { offerId: offer.id },
    create: {
      offerId: offer.id,
      isLow: true,
      lastAvailable: available,
      lastNotifiedAt: sent ? now : null,
    },
    update: {
      isLow: true,
      lastAvailable: available,
      lastNotifiedAt: sent ? now : null,
    },
  })
}

let timer: NodeJS.Timeout | null = null
let running = false

export async function runLowStockNotifyBatch(now = new Date()) {
  if (running) return
  running = true
  let lease: CronLeaseHandle | null = null
  try {
    // P7a：舰队租约——领不到说明本窗口已有实例执行，跳过本 tick（test 直通）。
    lease = await acquireCronLeaseWithHeartbeat('lowStockNotify', NOTIFY_INTERVAL_MS)
    if (!lease) return
    const [threshold, cooldownHours] = await Promise.all([
      getSystemConfigValue('lowStockThreshold'),
      getSystemConfigValue('lowStockNotifyCooldownHours'),
    ])

    // instant_inventory 被 CHECK 约束强制 limited，OR 条件是防御性冗余，
    // 保证脏数据下即时库存规格也不会漏检。
    const offers = await prisma.offer.findMany({
      where: {
        status: 'active',
        OR: [{ deliveryMode: 'instant_inventory' }, { stockMode: 'limited' }],
        product: { status: 'active', merchantId: { not: null } },
      },
      select: {
        id: true,
        name: true,
        deliveryMode: true,
        stock: true,
        product: {
          select: {
            id: true,
            name: true,
            merchant: {
              select: {
                contactEmail: true,
                user: { select: { email: true } },
              },
            },
          },
        },
      },
      orderBy: { id: 'asc' },
    })

    for (const offer of offers) {
      if (!offer.product.merchant) continue
      try {
        await processOffer(offer, threshold, cooldownHours, now)
      } catch (err) {
        // 单条 DB 失败不拖垮整批，留给下一轮重试。
        logger.warn({ err, offerId: offer.id }, 'low stock notify offer processing failed')
      }
    }
  } catch (err) {
    logger.error({ err }, 'low stock notify batch failed')
  } finally {
    lease?.release()
    running = false
  }
}

export function startLowStockNotifyCron() {
  if (config.nodeEnv === 'test') return
  if (timer) return
  runLowStockNotifyBatch().catch(err => logger.error({ err }, 'low stock notify initial run failed'))
  timer = setInterval(() => {
    runLowStockNotifyBatch().catch(err => logger.error({ err }, 'low stock notify tick failed'))
  }, NOTIFY_INTERVAL_MS)
  timer.unref?.()
  logger.info({ intervalMs: NOTIFY_INTERVAL_MS }, 'low stock notify cron started')
}

export function stopLowStockNotifyCron() {
  if (!timer) return
  clearInterval(timer)
  timer = null
  logger.info('low stock notify cron stopped')
}
