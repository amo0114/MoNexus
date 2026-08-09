// T-MERCH-BE-001 — Ranking run lifecycle module exports.
//
// Public surface consumed by T-MERCH-BE-002 (compute + projection), admin query
// and the CMI Integration Owner (cron wiring). BE-002 registers its compute via
// `setRankingCompute` from `./cron.js`.

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
