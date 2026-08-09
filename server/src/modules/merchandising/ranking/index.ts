// T-MERCH-BE-001/002 — Ranking run lifecycle + compute module exports.
//
// Public surface consumed by T-MERCH-BE-002 (projection), admin query and the
// CMI Integration Owner (cron wiring). T-MERCH-BE-002 registers its real compute
// here at module load: the only 'main wiring' that lives inside merchandising
// ranking (task: 不得改 global main). Tests import submodules directly and are
// unaffected by this registration.

import { registerRankingCompute } from './compute.js'

export {
  dbNow,
  findLatestCompletedRun,
  findMostRecentRun,
  markRunFailed,
  reclaimStaleRunning,
  runRetention,
  writeSnapshotsAndComplete,
  type AnyDb,
} from './repository.js'

export {
  isRecomputeDue,
  loadRankingConfig,
  maybeRunRankingRun,
  runRankingRun,
  validateRankingConfig,
  type MaybeRunRankingDeps,
  type RunRankingDeps,
} from './lifecycle.js'

export {
  getRankingCompute,
  runRankingCronBatch,
  setRankingCompute,
  startRankingCron,
  stopRankingCron,
} from './cron.js'

export {
  computeCategoryRanks,
  computeRankingSnapshots,
  registerRankingCompute,
  buildComputeAggregationSql,
  type AggregationRow,
  type RankedSnapshot,
} from './compute.js'
export {
  listAdminRuns,
  requestManualRecompute,
  type AdminRunPage,
  type AdminRunRow,
  type ManualRecomputeResult,
} from './admin.js'

export {
  RANKING_RUN_LOCK_CLASS,
  RUN_FAILURE_CODES,
  type RankingConfig,
  type RankingConfigLoader,
  type RunCompute,
  type RunComputeContext,
  type RunFailureCode,
  type RunOutcome,
  type SnapshotInput,
} from './types.js'
export { RUN_STATUS } from '../constants.js'

// T-MERCH-BE-002 最小接线：本模块作为 merchandising ranking 的入口被宿主 main 接线
// import 时，自动把真实 Order 聚合 compute 注册进 BE-001 cron。幂等；测试直接
// import 子模块（cron/lifecycle/repository），不会触发此注册。
registerRankingCompute()
