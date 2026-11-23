import { config } from '../config/index.js'
import { acquireCronLeaseWithHeartbeat, type CronLeaseHandle } from './cronLease.js'
import { logger } from './logger.js'
import { cronIntervalSeconds, cronLastSuccessTimestamp, cronRunsTotal } from './metrics.js'

/**
 * Periodic batch behind the fleet-wide cron lease (lib/cronLease), with the
 * metrics every background job must expose (AGENTS.md §3, PR template).
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
      if (!lease) {
        cronRunsTotal.inc({ job: name, outcome: 'skipped' })
        return
      }
      await run()
      cronRunsTotal.inc({ job: name, outcome: 'success' })
      cronLastSuccessTimestamp.set({ job: name }, Date.now() / 1000)
    } catch (err) {
      cronRunsTotal.inc({ job: name, outcome: 'failure' })
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
      cronIntervalSeconds.set({ job: name }, intervalMs / 1000)
      // Never succeeded yet counts from process start, so a cron that always fails still alerts.
      cronLastSuccessTimestamp.set({ job: name }, Date.now() / 1000)
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
