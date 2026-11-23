import { config } from '../config/index.js'
import { acquireCronLeaseWithHeartbeat, type CronLeaseHandle } from './cronLease.js'
import { logger } from './logger.js'

/**
 * Periodic batch behind the fleet-wide cron lease (lib/cronLease); the lease
 * handle records the monexus_cron_* metrics (AGENTS.md §3, PR template).
 * Same semantics as the hand-written crons it replaces: immediate first run,
 * in-process re-entry guard, release on success, releaseForRetry on failure,
 * errors are logged and never escape a tick.
 */
export function defineLeasedCron(options: {
  name: string
  intervalMs: number
  run: () => Promise<void>
}) {
  const { name, intervalMs, run } = options
  let timer: NodeJS.Timeout | null = null
  let running = false

  async function tick() {
    if (running) return
    running = true
    let lease: CronLeaseHandle | null = null
    try {
      lease = await acquireCronLeaseWithHeartbeat(name, intervalMs)
      if (!lease) return
      await run()
    } catch (err) {
      logger.error({ err, cron: name }, 'leased cron tick failed')
      if (lease) { await lease.releaseForRetry(); lease = null }
    } finally {
      lease?.release()
      running = false
    }
  }

  return {
    tick,
    start() {
      if (config.nodeEnv === 'test' || timer) return
      void tick()
      timer = setInterval(() => void tick(), intervalMs)
      timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
