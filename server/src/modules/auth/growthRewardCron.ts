import { config } from '../../config/index.js'
import { acquireCronLeaseWithHeartbeat, type CronLeaseHandle } from '../../lib/cronLease.js'
import { logger } from '../../lib/logger.js'
import { cleanupAbuseEvents } from './abuseEvents.js'
import { releaseMatureGrowthRewards } from './growthRewards.js'

export const GROWTH_REWARD_CRON_INTERVAL_MS = 60_000
export const ABUSE_EVENT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1_000

let timer: NodeJS.Timeout | null = null
let releaseRunning = false
let retentionRunning = false

/**
 * One leased minute tick. The release service itself uses `FOR UPDATE SKIP
 * LOCKED`; the lease avoids routine duplicate scans while the row claim keeps
 * the accounting correct across crashes, retries, and a lost heartbeat.
 */
export async function runGrowthRewardReleaseCronBatch() {
  if (releaseRunning) return []
  releaseRunning = true
  let lease: CronLeaseHandle | null = null
  try {
    lease = await acquireCronLeaseWithHeartbeat('growthRewards', GROWTH_REWARD_CRON_INTERVAL_MS)
    if (!lease) return []

    const outcomes = await releaseMatureGrowthRewards()
    const granted = outcomes.filter(outcome => outcome.outcome === 'granted').length
    const voided = outcomes.filter(outcome => outcome.outcome === 'voided').length
    if (granted > 0 || voided > 0) {
      logger.info({ granted, voided }, 'growth reward cron completed batch')
    }
    return outcomes
  } catch (err) {
    // The release service keeps the whole selected batch in one transaction;
    // catching here happens only after that transaction has rolled back.
    logger.error({ err }, 'growth reward cron batch failed')
    return []
  } finally {
    lease?.release()
    releaseRunning = false
  }
}

/** A separate daily lease keeps retention work out of the minute hot path. */
export async function runAbuseEventRetentionCronBatch() {
  if (retentionRunning) return 0
  retentionRunning = true
  let lease: CronLeaseHandle | null = null
  try {
    lease = await acquireCronLeaseWithHeartbeat('abuseEventRetention', ABUSE_EVENT_RETENTION_INTERVAL_MS)
    if (!lease) return 0

    const deleted = await cleanupAbuseEvents()
    if (deleted > 0) logger.info({ deleted }, 'expired abuse events cleaned')
    return deleted
  } catch (err) {
    logger.error({ err }, 'abuse event retention cleanup failed')
    return 0
  } finally {
    lease?.release()
    retentionRunning = false
  }
}

export async function runGrowthRewardCronTick() {
  await runGrowthRewardReleaseCronBatch()
  await runAbuseEventRetentionCronBatch()
}

export function startGrowthRewardCron() {
  if (config.nodeEnv === 'test') return
  if (timer) return

  runGrowthRewardCronTick().catch(err => {
    logger.error({ err }, 'growth reward cron initial tick failed')
  })
  timer = setInterval(() => {
    runGrowthRewardCronTick().catch(err => {
      logger.error({ err }, 'growth reward cron tick failed')
    })
  }, GROWTH_REWARD_CRON_INTERVAL_MS)
  timer.unref?.()
  logger.info({ intervalMs: GROWTH_REWARD_CRON_INTERVAL_MS }, 'growth reward cron started')
}

export function stopGrowthRewardCron() {
  if (!timer) return
  clearInterval(timer)
  timer = null
  logger.info('growth reward cron stopped')
}

export async function __runGrowthRewardCronTickForTests() {
  await runGrowthRewardCronTick()
}
