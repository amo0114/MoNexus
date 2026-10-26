import { config } from '../../config/index.js'
import { logger } from '../../lib/logger.js'
import { runAccountBackfill } from './backfill.js'

const INTERVAL_MS = 60_000
let timer: NodeJS.Timeout | null = null
let running: Promise<void> | null = null

function tick() {
  if (running || !config.xboardAccounts.enabled) return
  // runAccountBackfill owns the shared cron lease and checkpoint CAS.
  running = runAccountBackfill({ apply: true, limit: 50 }).then(result => {
    if (!result.skipped) logger.info({ scanned: result.scanned, counts: result.counts }, 'xboard account recovery batch completed')
  }).catch(() => {
    // Never log upstream contents or account identifiers.
    logger.warn('xboard account recovery batch unavailable')
  }).finally(() => { running = null })
}

export function startAccountBackfillCron() {
  if (config.nodeEnv === 'test' || !config.xboardAccounts.enabled || timer) return
  tick()
  timer = setInterval(tick, INTERVAL_MS)
  timer.unref()
}

export async function stopAccountBackfillCron() {
  if (timer) clearInterval(timer)
  timer = null
  await running
}
