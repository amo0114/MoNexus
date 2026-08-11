import { config } from '../../../config/index.js'
import { logger } from '../../../lib/logger.js'
import { advanceEditorialLifecycle } from './service.js'

export const EDITORIAL_LIFECYCLE_CRON_TICK_MS = 60_000

let timer: NodeJS.Timeout | null = null
let running = false

export async function runEditorialLifecycleBatch() {
  if (running) return null
  running = true
  try {
    const result = await advanceEditorialLifecycle()
    if (result.scheduledToActive > 0 || result.activeToExpired > 0) {
      logger.info({ ...result }, 'editorial lifecycle advanced')
    }
    return result
  } catch (err) {
    logger.error({ err }, 'editorial lifecycle batch failed')
    return null
  } finally {
    running = false
  }
}

export function startEditorialLifecycleCron(): void {
  if (config.nodeEnv === 'test' || timer) return
  runEditorialLifecycleBatch().catch(err => logger.error({ err }, 'editorial lifecycle initial tick failed'))
  timer = setInterval(() => {
    runEditorialLifecycleBatch().catch(err => logger.error({ err }, 'editorial lifecycle tick failed'))
  }, EDITORIAL_LIFECYCLE_CRON_TICK_MS)
  timer.unref?.()
  logger.info({ tickMs: EDITORIAL_LIFECYCLE_CRON_TICK_MS }, 'editorial lifecycle cron started')
}

export function stopEditorialLifecycleCron(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
  logger.info('editorial lifecycle cron stopped')
}

