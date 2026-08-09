// T-MERCH-BE-001 — Ranking run lifecycle internal types (SPEC-MERCH-001 §5.1/§6.2).
//
// Module-internal to modules/merchandising/ranking/*. The public/merchant/admin
// run views (BE-002 + admin query) consume these through lifecycle/cron/admin.

import type { Prisma } from '@prisma/client'

/** Session advisory-lock class for ranking runs. Distinct from every other
 * lock class in the repo (20260726/20260727/20260801) so ranking never queues
 * on an unrelated job's lock. Date-based, mirrors the leaderboard convention. */
export const RANKING_RUN_LOCK_CLASS = 20260809

/**
 * 脱敏 failureCode 枚举（SPEC-MERCH-001 §5.1 "脱敏枚举"）。只允许这组稳定
 * 枚举值，禁止把异常 message/约束名写进 run 行或 admin 视图。
 */
export const RUN_FAILURE_CODES = {
  /** 注入的 compute 函数抛错（聚合阶段失败）。 */
  COMPUTE_FAILED: 'COMPUTE_FAILED',
  /** 事务 B 写 snapshots 或 CAS completed 抛错（含旧进程 fencing 到 0 行）。 */
  COMMIT_FAILED: 'COMMIT_FAILED',
  /** stale running 超时回收（由 reclaim 的 SQL 直接写入）。 */
  RUN_TIMEOUT: 'RUN_TIMEOUT',
  /** 创建 run / 读取 config / 其他基础设施失败。 */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const
export type RunFailureCode = (typeof RUN_FAILURE_CODES)[keyof typeof RUN_FAILURE_CODES]

/** 冻结进 run 的整数配置（SPEC-MERCH-001 §12，与 SystemConfig 的 key 一一对应）。 */
export interface RankingConfig {
  hotWindowDays: number
  hotMinSales: number
  hotTopPercent: number
  hotRecomputeMinutes: number
  hotRunTimeoutMinutes: number
}

export type RankingConfigLoader = () => Promise<RankingConfig>

/** 单条 ProductMerchandisingSnapshot 写入输入（SPEC-MERCH-001 §5.2）。 */
export interface SnapshotInput {
  productId: number
  categoryId: number
  effectiveOrderCount: number
  categoryRank: number
  categoryPopulation: number
  isHot: boolean
}

/** 传给 compute 的 run 上下文：config + DB 时间在 run 开始时一次性冻结。 */
export interface RunComputeContext {
  runId: string
  windowStart: Date
  windowEnd: Date
  windowDays: number
  minSales: number
  topPercent: number
}

/**
 * compute 在事务 B 内部执行（SPEC-MERCH-001 §6.2 "在 transaction 内聚合"）。
 * 返回本 run 的全量 snapshots；抛错会让事务 B 整体回滚（无 partial snapshot）。
 * T-MERCH-BE-002 实现真实 Order 聚合；本卡只消费该签名。
 */
export type RunCompute = (
  tx: Prisma.TransactionClient,
  ctx: RunComputeContext,
) => Promise<SnapshotInput[]>

/**
 * 一次 run 生命周期结果。
 * - completed：事务 B 成功，snapshotCount 为写入行数。
 * - failed：事务 B（或更早步骤）失败；wrappedUp 表示独立事务 C 的
 *   running→failed CAS 是否成功（false 只能告警，不能伪报成功）。
 * - skipped：未产生新 run（lock_busy / running_exists / cadence）。
 */
export type RunOutcome =
  | { kind: 'completed'; runId: string; snapshotCount: number }
  | { kind: 'failed'; runId: string | null; failureCode: RunFailureCode; wrappedUp: boolean }
  | { kind: 'skipped'; reason: 'lock_busy' | 'running_exists' | 'cadence' }

/** Retention 执行统计（仅用于日志/metrics 计数，不含任何标识）。 */
export interface RetentionStats {
  deletedSupersededCompletedRuns: number
  deletedFailedRunSnapshots: number
  deletedFailedRuns: number
}
