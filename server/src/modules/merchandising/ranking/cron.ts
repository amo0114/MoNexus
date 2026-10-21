// T-MERCH-BE-001 — Ranking run cron wrapper (SPEC-MERCH-001 §6.2 / plan §4.1).
//
// Scheduling only; the actual run cadence (hotRecomputeMinutes) is enforced by
// maybeRunRankingRun. The compute function is provided by T-MERCH-BE-002 via
// setRankingCompute — until it is registered the cron logs and skips (BE-001
// must not ship a compute). main.ts wiring is owned by the CMI Integration
// Owner (task: "main/global cron 接线留给 CMI Integration").

import { config } from '../../../config/index.js'
import { logger } from '../../../lib/logger.js'
import { acquireCronLeaseWithHeartbeat, type CronLeaseHandle } from '../../../lib/cronLease.js'
import { loadRankingConfig, maybeRunRankingRun, type MaybeRunRankingDeps } from './lifecycle.js'
import { runRetention } from './repository.js'
import type { RetentionStats, RunCompute, RunOutcome } from './types.js'

export const RANKING_CRON_TICK_MS = 60_000

let timer: NodeJS.Timeout | null = null
let running = false
let compute: RunCompute | null = null

/**
 * T-MERCH-BE-002 注册真实 Order 聚合 compute。BE-001 阶段未注册时 cron 只
 * 告警跳过，不制造空 run。多次注册以最后一次为准（幂等）。
 */
export function setRankingCompute(next: RunCompute): void {
  compute = next
}

/** admin manual recompute 与 cron 共用已注册的 compute。 */
export function getRankingCompute(): RunCompute | null {
  return compute
}

/** 一次 cron 批：未注册 compute 或已并发执行中则跳过。 */
export async function runRankingCronBatch(): Promise<RunOutcome[]> {
  if (running) return []
  const current = compute
  if (!current) {
    logger.warn('ranking cron: compute not registered (T-MERCH-BE-002), skipping')
    return []
  }
  running = true
  try {
    const deps: MaybeRunRankingDeps = { compute: current, configLoader: loadRankingConfig }
    const outcome = await maybeRunRankingRun(deps)
    return [outcome]
  } catch (err) {
    logger.error({ err }, 'ranking cron batch failed')
    return []
  } finally {
    running = false
  }
}

// ---------------------------------------------------------------------------
// Run/snapshot retention (SPEC-MERCH-001 §6.2 step 7)
//
// Deliberately independent of the recompute path: retention runs on its own
// lease whether or not a compute is registered and whether or not the last
// ranking run succeeded — a permanently failing compute is exactly when old
// runs pile up. It also never touches the ranking advisory lock: retention only
// deletes superseded completed/failed runs and always keeps the newest
// completed run, so it cannot race the run it is cleaning up after.
//
// Cadence is enforced by the lease window, not by a `running` short-circuit
// alone: the loop ticks every minute but `periodMs` is one hour, so at most one
// instance performs the sweep per hour across the fleet.
// ---------------------------------------------------------------------------

/** Lease name — distinct from any recompute lease so the two never collide. */
export const RANKING_RETENTION_LEASE = 'merchandisingRankingRetention'
/** Window throttle: one sweep per hour per fleet. */
export const RANKING_RETENTION_PERIOD_MS = 60 * 60 * 1000
/** Sweep cadence: check every minute; the lease decides whether to actually run. */
export const RANKING_RETENTION_TICK_MS = 60_000

let retentionTimer: NodeJS.Timeout | null = null
let retentionRunning = false

/**
 * Injectable seams for the retention sweep. Production uses the real fleet
 * lease and the real repository; tests swap them to exercise "lease held" and
 * "sweep failed" without waiting out an hour or dropping a table.
 */
export interface RankingRetentionDeps {
  acquireLease: (name: string, periodMs: number) => Promise<CronLeaseHandle | null>
  sweep: () => Promise<RetentionStats>
}

const defaultRetentionDeps: RankingRetentionDeps = {
  acquireLease: (name, periodMs) => acquireCronLeaseWithHeartbeat(name, periodMs),
  sweep: () => runRetention(),
}

/**
 * One retention sweep. Returns null when the in-process guard or the fleet lease
 * says this tick must be skipped. Errors are logged and swallowed here — a
 * retention failure must never surface as a ranking-run failure.
 */
export async function runRankingRetentionBatch(
  deps: RankingRetentionDeps = defaultRetentionDeps,
): Promise<RetentionStats | null> {
  if (retentionRunning) return null
  retentionRunning = true
  let lease: CronLeaseHandle | null = null
  try {
    lease = await deps.acquireLease(RANKING_RETENTION_LEASE, RANKING_RETENTION_PERIOD_MS)
    if (!lease) return null

    const stats = await deps.sweep()
    if (
      stats.deletedSupersededCompletedRuns > 0
      || stats.deletedFailedRunSnapshots > 0
      || stats.deletedFailedRuns > 0
    ) {
      logger.info(stats, 'ranking retention swept superseded runs')
    }
    lease.release()
    return stats
  } catch (err) {
    logger.error({ err }, 'ranking retention batch failed')
    // Roll the throttle window back so the next tick may retry instead of
    // waiting out the full hour on a transient failure.
    await lease?.releaseForRetry().catch(retryErr => {
      logger.error({ err: retryErr }, 'ranking retention lease rollback failed')
    })
    return null
  } finally {
    retentionRunning = false
  }
}

/** 幂等启动：已有 timer 或 test 环境不重复启动。 */
export function startRankingCron(): void {
  if (config.nodeEnv === 'test') return
  if (timer) return

  runRankingCronBatch().catch(err => {
    logger.error({ err }, 'ranking cron initial tick failed')
  })
  timer = setInterval(() => {
    runRankingCronBatch().catch(err => {
      logger.error({ err }, 'ranking cron tick failed')
    })
  }, RANKING_CRON_TICK_MS)
  timer.unref?.()
  logger.info({ tickMs: RANKING_CRON_TICK_MS }, 'ranking cron started')

  // Retention shares the start/stop lifecycle but keeps its own timer and lease.
  startRankingRetentionCron()
}

/** Idempotent retention scheduler start (own timer, own lease). */
export function startRankingRetentionCron(): void {
  if (config.nodeEnv === 'test') return
  if (retentionTimer) return

  runRankingRetentionBatch().catch(err => {
    logger.error({ err }, 'ranking retention initial run failed')
  })
  retentionTimer = setInterval(() => {
    runRankingRetentionBatch().catch(err => {
      logger.error({ err }, 'ranking retention tick failed')
    })
  }, RANKING_RETENTION_TICK_MS)
  retentionTimer.unref?.()
  logger.info(
    { tickMs: RANKING_RETENTION_TICK_MS, periodMs: RANKING_RETENTION_PERIOD_MS },
    'ranking retention cron started',
  )
}

/** Idempotent retention scheduler stop — no orphan timer on restart. */
export function stopRankingRetentionCron(): void {
  if (!retentionTimer) return
  clearInterval(retentionTimer)
  retentionTimer = null
  logger.info('ranking retention cron stopped')
}

/** 幂等停止：清理 timer，不留孤儿 timer（stop/restart 无泄漏）。 */
export function stopRankingCron(): void {
  stopRankingRetentionCron()
  if (!timer) return
  clearInterval(timer)
  timer = null
  logger.info('ranking cron stopped')
}

/** 测试直通：NODE_ENV=test 下 runRankingCronBatch 真实执行（不触表无锁）。 */
export async function __runRankingCronForTests(): Promise<RunOutcome[]> {
  return runRankingCronBatch()
}

/** 测试直通：retention 批同上（可注入 lease/sweep）。 */
export async function __runRankingRetentionForTests(
  deps?: RankingRetentionDeps,
): Promise<RetentionStats | null> {
  return runRankingRetentionBatch(deps)
}
