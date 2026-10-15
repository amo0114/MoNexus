import { config } from '../../config/index.js'
import { acquireCronLeaseWithHeartbeat, type CronLeaseHandle } from '../../lib/cronLease.js'
import { logger } from '../../lib/logger.js'
import { cleanupRecommendationEvents } from './service.js'

const INTERVAL_MS = 60_000
let timer: NodeJS.Timeout | null = null
let running = false

async function tick() {
  if (running) return
  running = true
  let lease: CronLeaseHandle | null = null
  try {
    lease = await acquireCronLeaseWithHeartbeat('recommendation-event-retention', INTERVAL_MS)
    if (lease) {
      await cleanupRecommendationEvents()
      logger.debug('recommendation event retention completed')
    }
  } catch (err) {
    logger.error({ err }, 'recommendation event retention failed')
    if (lease) { await lease.releaseForRetry(); lease = null }
  } finally {
    lease?.release()
    running = false
  }
}

export function startRecommendationEventsCron() {
  if (config.nodeEnv === 'test' || timer) return
  void tick()
  timer = setInterval(() => void tick(), INTERVAL_MS)
  timer.unref()
}

export function stopRecommendationEventsCron() {
  if (timer) clearInterval(timer)
  timer = null
}
