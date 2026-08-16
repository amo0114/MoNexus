// T-MERCH-BE-001 — Ranking run cron wrapper (SPEC-MERCH-001 §6.2 / plan §4.1).
//
// Scheduling only; the actual run cadence (hotRecomputeMinutes) is enforced by
// maybeRunRankingRun. The compute function is provided by T-MERCH-BE-002 via
// setRankingCompute — until it is registered the cron logs and skips (BE-001
// must not ship a compute). main.ts wiring is owned by the CMI Integration
// Owner (task: "main/global cron 接线留给 CMI Integration").

import { config } from '../../../config/index.js'
import { logger } from '../../../lib/logger.js'
import { loadRankingConfig, maybeRunRankingRun, type MaybeRunRankingDeps } from './lifecycle.js'
import type { RunCompute, RunOutcome } from './types.js'

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
}

/** 幂等停止：清理 timer，不留孤儿 timer（stop/restart 无泄漏）。 */
export function stopRankingCron(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
  logger.info('ranking cron stopped')
}

/** 测试直通：NODE_ENV=test 下 runRankingCronBatch 真实执行（不触表无锁）。 */
export async function __runRankingCronForTests(): Promise<RunOutcome[]> {
  return runRankingCronBatch()
}
