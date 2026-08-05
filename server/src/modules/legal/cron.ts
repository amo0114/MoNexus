import { config } from '../../config/index.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { acquireCronLeaseWithHeartbeat, type CronLeaseHandle } from '../../lib/cronLease.js'

/**
 * SPEC-LEGAL-001：同意证据留存 cron。
 *
 * UserAgreementConsent / OrderAgreementAcceptance 的 ip/userAgent 是个人
 * 信息，仅作同意证据与反滥用审计；retentionUntil 到期后本任务将其置空
 * 匿名化（document/version/contentHash/时间戳保留，证据链不断）。行本身
 * 永不删除——匿名化后的记录即审计轨迹，配合每轮的计数日志构成完整审计。
 */

const RETENTION_INTERVAL_MS = 60 * 60 * 1000 // 每小时一轮

let timer: NodeJS.Timeout | null = null
let running = false

async function runRetentionBatch() {
  if (running) return
  running = true
  let lease: CronLeaseHandle | null = null
  try {
    // 舰队租约：多实例部署时同一窗口只允许一个执行者（test 环境直通）。
    lease = await acquireCronLeaseWithHeartbeat('legalEvidenceRetention', RETENTION_INTERVAL_MS)
    if (!lease) return

    const now = new Date()
    // 只碰"到期且尚未匿名化"的行：updateMany 幂等，重复执行零副作用。
    const consents = await prisma.userAgreementConsent.updateMany({
      where: {
        retentionUntil: { lte: now },
        OR: [{ ip: { not: null } }, { userAgent: { not: null } }],
      },
      data: { ip: null, userAgent: null },
    })
    const acceptances = await prisma.orderAgreementAcceptance.updateMany({
      where: {
        retentionUntil: { lte: now },
        OR: [{ ip: { not: null } }, { userAgent: { not: null } }],
      },
      data: { ip: null, userAgent: null },
    })

    if (consents.count > 0 || acceptances.count > 0) {
      // 审计日志：匿名化规模留痕（不含任何被匿名化的内容本身）。
      logger.info(
        { consentsAnonymized: consents.count, acceptancesAnonymized: acceptances.count },
        'legal evidence ip/user-agent anonymized after retention window',
      )
    }
  } catch (err) {
    logger.error({ err }, 'legal evidence retention batch failed')
  } finally {
    lease?.release()
    running = false
  }
}

export function startLegalRetentionCron() {
  if (config.nodeEnv === 'test') return
  if (timer) return

  runRetentionBatch().catch(err => {
    logger.error({ err }, 'legal retention cron initial run failed')
  })
  timer = setInterval(() => {
    runRetentionBatch().catch(err => {
      logger.error({ err }, 'legal retention cron tick failed')
    })
  }, RETENTION_INTERVAL_MS)
  timer.unref?.()
  logger.info({ intervalMs: RETENTION_INTERVAL_MS }, 'legal evidence retention cron started')
}

export function stopLegalRetentionCron() {
  if (!timer) return
  clearInterval(timer)
  timer = null
  logger.info('legal evidence retention cron stopped')
}

export async function __runLegalRetentionBatchForTests() {
  await runRetentionBatch()
}
