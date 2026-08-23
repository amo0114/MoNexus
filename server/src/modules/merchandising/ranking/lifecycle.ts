// T-MERCH-BE-001 — Ranking run lifecycle orchestrator (SPEC-MERCH-001 §5.1/§6.2).
//
// Single entry points shared by cron and admin manual recompute:
//   - maybeRunRankingRun: cadence（hotRecomputeMinutes）+ lock + A/B/C 全流程；
//   - runRankingRun:      lock + A/B/C（不检查 cadence，供直接/测试调用）。
//
// 冻结语义：
//   - config 与 DB 时间在 run 开始时一次性读取并冻结进 run；
//   - session advisory lock 横跨短事务 A/B/C，锁挂在专用连接（stop/restart/kill
//     -9 都不留孤儿锁）；
//   - stale running 按 DB 时间 + hotRunTimeoutMinutes 回收；
//   - 失败（compute/commit/catch）无 partial snapshot 且上一 completed 仍可读；
//   - 独立短事务 C CAS failed；C 失败只能告警，不能伪报成功。

import { performance } from 'node:perf_hooks'
import { Prisma } from '@prisma/client'
import { getSystemConfigValue } from '../../../lib/systemConfig.js'
import { logger } from '../../../lib/logger.js'
import { prisma } from '../../../lib/prisma.js'
import { RUN_STATUS } from '../constants.js'
import {
  ComputeFailedError,
  createRunningRun,
  dbNow as defaultDbNow,
  findActiveRunningRun,
  findMostRecentRun,
  isSingleRunningConflict,
  markRunFailed,
  RankingRunSessionLock,
  reclaimStaleRunning,
  RunFencedError,
  writeSnapshotsAndComplete,
} from './repository.js'
import {
  observeRunDuration,
  recordRunOutcome,
  setSnapshotProducts,
} from './metrics.js'
import {
  RUN_FAILURE_CODES,
  type RankingConfig,
  type RankingConfigLoader,
  type RunCompute,
  type RunFailureCode,
  type RunOutcome,
} from './types.js'

const MINUTE_MS = 60_000

/** SPEC-MERCH-001 §12 冻结的整数范围（与 DB CHECK 一致）。 */
const CONFIG_RANGES: Record<keyof Pick<RankingConfig, 'hotWindowDays' | 'hotMinSales' | 'hotTopPercent'>, [number, number]> = {
  hotWindowDays: [1, 365],
  hotMinSales: [1, 100_000],
  hotTopPercent: [1, 100],
}
const INTERVAL_RANGES: Record<keyof Pick<RankingConfig, 'hotRecomputeMinutes' | 'hotRunTimeoutMinutes'>, [number, number]> = {
  hotRecomputeMinutes: [10, 1440],
  hotRunTimeoutMinutes: [10, 1440],
}

function assertInRange(key: string, value: number, [min, max]: [number, number]): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`merchandising config ${key}=${value} out of frozen range ${min}..${max}`)
  }
}

/**
 * 冻结的整数范围校验（与 DB CHECK 一致）。纯函数：不触 DB，可无数据库单元测试。
 * 越界直接失败（不清静回退）。
 */
export function validateRankingConfig(config: RankingConfig): void {
  for (const key of Object.keys(CONFIG_RANGES) as (keyof typeof CONFIG_RANGES)[]) {
    assertInRange(key, config[key], CONFIG_RANGES[key])
  }
  for (const key of Object.keys(INTERVAL_RANGES) as (keyof typeof INTERVAL_RANGES)[]) {
    assertInRange(key, config[key], INTERVAL_RANGES[key])
  }
}

/** 读取一次 SystemConfig 并冻结成 RankingConfig；越界直接失败（不清静回退）。 */
export async function loadRankingConfig(): Promise<RankingConfig> {
  const [hotWindowDays, hotMinSales, hotTopPercent, hotRecomputeMinutes, hotRunTimeoutMinutes] =
    await Promise.all([
      getSystemConfigValue('hotWindowDays'),
      getSystemConfigValue('hotMinSales'),
      getSystemConfigValue('hotTopPercent'),
      getSystemConfigValue('hotRecomputeMinutes'),
      getSystemConfigValue('hotRunTimeoutMinutes'),
    ])
  const config = {
    hotWindowDays,
    hotMinSales,
    hotTopPercent,
    hotRecomputeMinutes,
    hotRunTimeoutMinutes,
  }
  validateRankingConfig(config)
  return config
}

export interface RunRankingDeps {
  compute: RunCompute
  /** 默认读 SystemConfig（loadRankingConfig）。 */
  configLoader?: RankingConfigLoader
  /** 默认新建专用连接的会话级 advisory lock。 */
  lockFactory?: () => Pick<RankingRunSessionLock, 'acquire' | 'release'>
  /** 默认主 prisma。事务 B 需要 $transaction，因此这里必须是 PrismaClient。 */
  db?: typeof prisma
  /** 默认 SELECT now()。注入用于测试的时间冻结。 */
  dbNow?: () => Promise<Date>
}

export interface MaybeRunRankingDeps extends RunRankingDeps {}

/**
 * cadence 判定：仅当「最近一次 run 不存在 / 是 failed / 是 running（由后续
 * reclaim 处理）或 completed 已超过 hotRecomputeMinutes」才允许开新 run。
 * 手动 recompute 与 cron 共用同一 cadence（rate contract）。
 */
export async function isRecomputeDue(
  hotRecomputeMinutes: number,
  now: Date,
  latest: { status: string; startedAt: Date } | null,
): Promise<boolean> {
  if (latest === null) return true
  if (latest.status === RUN_STATUS.FAILED) return true // 失败可立即重试
  if (latest.status === RUN_STATUS.RUNNING) return true // 由 reclaim/active 分支处理
  // completed：距上次 run 开始至少 hotRecomputeMinutes
  return now.getTime() - latest.startedAt.getTime() >= hotRecomputeMinutes * MINUTE_MS
}

/** 把失败原因归类为脱敏枚举；绝不把异常 message/约束名写进 run 行。 */
function classifyFailure(err: unknown): RunFailureCode {
  if (err instanceof RunFencedError) return RUN_FAILURE_CODES.COMMIT_FAILED
  if (err instanceof ComputeFailedError) return RUN_FAILURE_CODES.COMPUTE_FAILED
  // 事务 B 内 snapshots 写入/CAS 的 DB 错误（含 CHECK 约束、连接失败）。
  // PostgreSQL CHECK violation 经 createMany 在当前 Prisma 版本会包装成
  // UnknownRequestError，而非 KnownRequestError；两者都属于 commit 阶段失败。
  if (
    err instanceof Prisma.PrismaClientKnownRequestError
    || err instanceof Prisma.PrismaClientUnknownRequestError
    || err instanceof Prisma.PrismaClientInitializationError
    || err instanceof Prisma.PrismaClientRustPanicError
    || err instanceof Prisma.PrismaClientValidationError
  ) {
    return RUN_FAILURE_CODES.COMMIT_FAILED
  }
  return RUN_FAILURE_CODES.INTERNAL_ERROR
}

/**
 * 全流程：advisory lock → cadence（可选）→ reclaim stale → active 检查 →
 * 短事务 A 建 running → 事务 B compute+snapshots+completed →
 * catch 用独立短事务 C CAS failed。
 */
async function executeRankingRun(
  deps: RunRankingDeps,
  enforceCadence: boolean,
): Promise<RunOutcome> {
  const started = performance.now()
  const db = deps.db ?? prisma
  const config = deps.configLoader ? await deps.configLoader() : await loadRankingConfig()
  const dbNow = deps.dbNow ?? defaultDbNow
  const lock = (deps.lockFactory ?? (() => new RankingRunSessionLock()))()

  const acquired = await lock.acquire()
  if (!acquired) {
    recordRunOutcome('skipped_lock')
    return { kind: 'skipped', reason: 'lock_busy' }
  }

  let runId: string | null = null
  try {
    const now = await dbNow()

    // cadence 必须在 advisory lock 内重新读取。若两个调用都在锁外看到
    // “尚无 run”，较快的第一个调用可能在第二个真正 acquire 前完成并释放锁；
    // 第二个随后取得锁时必须看到刚完成的 run 并跳过，不能再创建第二行。
    if (enforceCadence) {
      const latest = await findMostRecentRun(db)
      const due = await isRecomputeDue(config.hotRecomputeMinutes, now, latest)
      if (!due) {
        recordRunOutcome('skipped_lock')
        return { kind: 'skipped', reason: 'cadence' }
      }
    }

    const reclaimed = await reclaimStaleRunning(config.hotRunTimeoutMinutes, db)
    if (reclaimed > 0) {
      logger.warn({ reclaimed, timeoutMinutes: config.hotRunTimeoutMinutes }, 'reclaimed stale ranking runs')
    }

    const active = await findActiveRunningRun(db)
    if (active) {
      recordRunOutcome('skipped_lock')
      return { kind: 'skipped', reason: 'running_exists' }
    }

    const windowEnd = now
    const windowStart = new Date(now.getTime() - config.hotWindowDays * 24 * 60 * 60 * 1000)

    // 短事务 A：只创建 running run 并提交。
    const run = await createRunningRun(
      {
        windowStart,
        windowEnd,
        windowDays: config.hotWindowDays,
        minSales: config.hotMinSales,
        topPercent: config.hotTopPercent,
        startedAt: now,
      },
      db,
    )
    runId = run.id

    // 事务 B：compute → 写全部 snapshots → CAS completed。任一步失败整体回滚。
    const completedAt = await dbNow()
    const snapshotCount = await writeSnapshotsAndComplete(
      {
        runId: run.id,
        completedAt,
        context: {
          runId: run.id,
          windowStart,
          windowEnd,
          windowDays: config.hotWindowDays,
          minSales: config.hotMinSales,
          topPercent: config.hotTopPercent,
        },
        compute: deps.compute,
      },
      db,
    )

    setSnapshotProducts(snapshotCount)
    recordRunOutcome('completed')
    observeRunDuration((performance.now() - started) / 1000)
    logger.info({ runId: run.id, snapshotCount }, 'ranking run completed')
    return { kind: 'completed', runId: run.id, snapshotCount }
  } catch (err) {
    // createRunningRun 撞全局 single-running partial unique：另一进程的 run
    // 已占位（advisory lock 之外的最终兜底）——按跳过处理，不制造失败 run。
    if (isSingleRunningConflict(err)) {
      recordRunOutcome('skipped_lock')
      return { kind: 'skipped', reason: 'running_exists' }
    }

    const failureCode = classifyFailure(err)
    let wrappedUp = false
    if (runId) {
      // 独立短事务 C：running → failed。失败只能告警，不能伪报成功。
      try {
        const failedAt = await dbNow()
        wrappedUp = await markRunFailed(runId, failureCode, failedAt, db)
      } catch (markErr) {
        logger.error({ err: markErr, runId }, 'ranking run mark-failed wrap-up failed')
      }
    }
    recordRunOutcome('failed')
    observeRunDuration((performance.now() - started) / 1000)
    logger.error({ err, runId, failureCode, wrappedUp }, 'ranking run failed')
    return { kind: 'failed', runId, failureCode, wrappedUp }
  } finally {
    await lock.release().catch(err => {
      logger.error({ err }, 'ranking run lock release failed')
    })
  }
}

/** 直接/测试入口：持锁执行 A/B/C，但明确绕过 cadence。 */
export async function runRankingRun(deps: RunRankingDeps): Promise<RunOutcome> {
  return executeRankingRun(deps, false)
}

/** cron / admin manual recompute 共用的对外入口：持锁后检查 cadence，再进 A/B/C。 */
export async function maybeRunRankingRun(deps: MaybeRunRankingDeps): Promise<RunOutcome> {
  return executeRankingRun(deps, true)
}
