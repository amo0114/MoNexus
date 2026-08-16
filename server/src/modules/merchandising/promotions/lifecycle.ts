// T-MERCH-BE-004 — Campaign lifecycle cron
// (SPEC-MERCH-001 §5.4/§7.1, D-MERCH-12/13, AC-MERCH-016, CHK-PROMO-007,
// CHK-OPS-002, REQ-MERCH-NF-005).
//
// Owned by this card. Frozen semantics:
//   - scheduled → active 当 `startsAt <= now()`；
//   - active → expired 当 `endsAt <= now()`；
//   - paused 继续占位、结束时间 P0 不顺延、不自动过期（转换表 paused 无
//     'expired' 分支），只由 admin resume/cancel 离开；
//   - 全部判定用 DB now()（`AT TIME ZONE 'UTC'` 与裸 UTC timestamp(3) 列同形，
//     与 ranking 同款时区无关比较）；
//   - 一次批内先 scheduled→active 再 active→expired（同一事务），cron 延迟时
//     已过 startsAt+endsAt 的 campaign 最终收敛为 expired；
//   - 幂等启动/停止：test 环境不启动 timer、不重复 start、stop 清理 timer，
//     无孤儿 timer/job（CHK-OPS-002）；
//   - 状态变化主动失效 sponsored 缓存（CHK-PUBLIC-001）；
//   - metrics：经 promotion_campaign_transition_total{from,to}（枚举、有界）。

import { config } from '../../../config/index.js'
import { logger } from '../../../lib/logger.js'
import { prisma } from '../../../lib/prisma.js'
import { CAMPAIGN_STATUS } from '../constants.js'
import { recordCampaignTransition } from './metrics.js'
import { invalidateSponsoredCache } from './publicSponsored.js'

type Db = typeof prisma

export interface CampaignLifecycleResult {
  scheduledToActive: number
  activeToExpired: number
}

/**
 * 推进 campaign 生命周期（按 DB 时间）。单事务内先 scheduled→active、
 * 再 active→expired。返回各自转换行数；任何一步失败整体回滚。
 */
export async function advanceCampaignLifecycle(client: Db = prisma): Promise<CampaignLifecycleResult> {
  const result = await client.$transaction(async tx => {
    const scheduledToActive = await tx.$executeRaw`
      UPDATE "PromotionCampaign"
      SET "status" = ${CAMPAIGN_STATUS.ACTIVE}, "updatedAt" = now()
      WHERE "status" = ${CAMPAIGN_STATUS.SCHEDULED}
        AND "startsAt" <= (now() AT TIME ZONE 'UTC')
    `
    const activeToExpired = await tx.$executeRaw`
      UPDATE "PromotionCampaign"
      SET "status" = ${CAMPAIGN_STATUS.EXPIRED}, "updatedAt" = now()
      WHERE "status" = ${CAMPAIGN_STATUS.ACTIVE}
        AND "endsAt" <= (now() AT TIME ZONE 'UTC')
    `
    return { scheduledToActive, activeToExpired }
  })
  if (result.scheduledToActive > 0) recordCampaignTransition(CAMPAIGN_STATUS.SCHEDULED, CAMPAIGN_STATUS.ACTIVE)
  if (result.activeToExpired > 0) recordCampaignTransition(CAMPAIGN_STATUS.ACTIVE, CAMPAIGN_STATUS.EXPIRED)
  if (result.scheduledToActive > 0 || result.activeToExpired > 0) invalidateSponsoredCache()
  return result
}

export const CAMPAIGN_LIFECYCLE_CRON_TICK_MS = 60_000

let timer: NodeJS.Timeout | null = null
let running = false

/** 一次 cron 批：已并发执行中则跳过（幂等，CHK-OPS-002）。 */
export async function runCampaignLifecycleBatch(): Promise<CampaignLifecycleResult | null> {
  if (running) return null
  running = true
  try {
    const result = await advanceCampaignLifecycle()
    if (result.scheduledToActive > 0 || result.activeToExpired > 0) {
      logger.info(
        { scheduledToActive: result.scheduledToActive, activeToExpired: result.activeToExpired },
        'promotion campaign lifecycle advanced',
      )
    }
    return result
  } catch (err) {
    logger.error({ err }, 'promotion campaign lifecycle batch failed')
    return null
  } finally {
    running = false
  }
}

/** 幂等启动：test 环境或已有 timer 不重复启动。main 接线由 CMI Integration Owner 完成。 */
export function startCampaignLifecycleCron(): void {
  if (config.nodeEnv === 'test') return
  if (timer) return
  runCampaignLifecycleBatch().catch(err => {
    logger.error({ err }, 'promotion campaign lifecycle initial tick failed')
  })
  timer = setInterval(() => {
    runCampaignLifecycleBatch().catch(err => {
      logger.error({ err }, 'promotion campaign lifecycle tick failed')
    })
  }, CAMPAIGN_LIFECYCLE_CRON_TICK_MS)
  timer.unref?.()
  logger.info({ tickMs: CAMPAIGN_LIFECYCLE_CRON_TICK_MS }, 'promotion campaign lifecycle cron started')
}

/** 幂等停止：清理 timer，不留孤儿 timer（stop/restart 无泄漏）。 */
export function stopCampaignLifecycleCron(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
  logger.info('promotion campaign lifecycle cron stopped')
}
