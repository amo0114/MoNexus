// Ranking retention scheduler (SPEC-MERCH-001 §6.2 step 7).
//
// Retention used to exist only as `runRetention()` with no production caller, so
// runs and full snapshots accumulated forever. These tests pin the scheduler
// contract:
//   - its own hourly lease name, distinct from any recompute lease;
//   - it runs regardless of whether a compute is registered or the last run
//     failed — a broken compute is exactly when old runs pile up;
//   - a failed sweep rolls the throttle window back so the next tick retries,
//     while a successful sweep keeps the hour;
//   - start/stop are idempotent and leave no orphan timer;
//   - a held lease (another instance inside the hour) skips the sweep.
//
// The sweep and the lease are injected: under NODE_ENV=test the real
// acquireCronLeaseWithHeartbeat passes through without touching the table, so
// lease semantics are exercised through a stub handle backed by the real
// cronLease primitives where that matters.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../../lib/prisma.js'
import { config } from '../../../config/index.js'
import * as cronLease from '../../../lib/cronLease.js'
import type { CronLeaseHandle } from '../../../lib/cronLease.js'
import {
  RANKING_RETENTION_LEASE,
  RANKING_RETENTION_PERIOD_MS,
  RANKING_RETENTION_TICK_MS,
  runRankingRetentionBatch,
  startRankingCron,
  startRankingRetentionCron,
  stopRankingCron,
  stopRankingRetentionCron,
  __runRankingRetentionForTests,
  type RankingRetentionDeps,
} from '../ranking/cron.js'
import { COMPLETED_RUN_RETENTION_HOURS, runRetention } from '../ranking/repository.js'
import { RUN_STATUS } from '../constants.js'

const EMPTY_STATS = {
  deletedSupersededCompletedRuns: 0,
  deletedFailedRunSnapshots: 0,
  deletedFailedRuns: 0,
}

/** Lease handle stub that records which teardown the sweep chose. */
function stubHandle() {
  const calls = { release: 0, releaseForRetry: 0 }
  const handle: CronLeaseHandle = {
    release() {
      calls.release += 1
    },
    async releaseForRetry() {
      calls.releaseForRetry += 1
    },
  }
  return { handle, calls }
}

function deps(overrides: Partial<RankingRetentionDeps> = {}): RankingRetentionDeps {
  const { handle } = stubHandle()
  return {
    acquireLease: async () => handle,
    sweep: async () => EMPTY_STATS,
    ...overrides,
  }
}

async function seedCompletedRun(ageHours: number) {
  const completedAt = new Date(Date.now() - ageHours * 60 * 60 * 1000)
  return prisma.merchandisingRun.create({
    data: {
      status: RUN_STATUS.COMPLETED,
      windowStart: new Date(completedAt.getTime() - 24 * 60 * 60 * 1000),
      windowEnd: completedAt,
      windowDays: 1,
      minSales: 5,
      topPercent: 20,
      startedAt: completedAt,
      completedAt,
    },
  })
}

describe('ranking retention scheduler', () => {
  beforeEach(async () => {
    await prisma.productMerchandisingSnapshot.deleteMany()
    await prisma.merchandisingRun.deleteMany()
  })

  afterEach(async () => {
    stopRankingCron()
    stopRankingRetentionCron()
    await prisma.productMerchandisingSnapshot.deleteMany()
    await prisma.merchandisingRun.deleteMany()
  })

  it('uses a dedicated lease name and an hourly window checked every minute', () => {
    // Distinct from any recompute lease: retention must never serialize behind,
    // or contend with, the ranking run advisory lock.
    expect(RANKING_RETENTION_LEASE).toBe('merchandisingRankingRetention')
    expect(RANKING_RETENTION_PERIOD_MS).toBe(60 * 60 * 1000)
    expect(RANKING_RETENTION_TICK_MS).toBe(60 * 1000)
  })

  it('sweeps superseded runs and keeps the newest completed run', async () => {
    const stale = await seedCompletedRun(COMPLETED_RUN_RETENTION_HOURS + 1)
    const fresh = await seedCompletedRun(0)

    // Real repository, injected lease: exercises the actual retention SQL.
    const stats = await runRankingRetentionBatch(deps({ sweep: () => runRetention() }))

    expect(stats).not.toBeNull()
    expect(stats!.deletedSupersededCompletedRuns).toBeGreaterThanOrEqual(1)
    const ids = (await prisma.merchandisingRun.findMany({ select: { id: true } })).map(r => r.id)
    expect(ids).toContain(fresh.id)
    expect(ids).not.toContain(stale.id)
  })

  it('runs independently of the recompute path (no compute registration needed)', async () => {
    // The ranking cron batch skips when no compute is registered. Retention is
    // a separate task and must still sweep — a permanently broken compute is
    // precisely when superseded runs pile up.
    await seedCompletedRun(COMPLETED_RUN_RETENTION_HOURS + 1)
    await seedCompletedRun(0)

    const stats = await runRankingRetentionBatch(deps({ sweep: () => runRetention() }))
    expect(stats).not.toBeNull()
    expect(stats!.deletedSupersededCompletedRuns).toBeGreaterThanOrEqual(1)
  })

  it('skips the sweep entirely when the lease is not acquired', async () => {
    const sweep = vi.fn(async () => EMPTY_STATS)
    const stats = await runRankingRetentionBatch(deps({
      acquireLease: async () => null,
      sweep,
    }))
    expect(stats).toBeNull()
    expect(sweep).not.toHaveBeenCalled()
  })

  it('releases the lease on success and rolls it back on failure', async () => {
    const ok = stubHandle()
    await runRankingRetentionBatch(deps({ acquireLease: async () => ok.handle }))
    expect(ok.calls).toEqual({ release: 1, releaseForRetry: 0 })

    const bad = stubHandle()
    const stats = await runRankingRetentionBatch(deps({
      acquireLease: async () => bad.handle,
      sweep: async () => {
        throw new Error('boom')
      },
    }))
    // A failed sweep is swallowed (returns null) and the window is rolled back
    // so the next minute retries instead of waiting out the hour.
    expect(stats).toBeNull()
    expect(bad.calls).toEqual({ release: 0, releaseForRetry: 1 })
  })

  it('a failed sweep does not throw into the caller', async () => {
    await expect(runRankingRetentionBatch(deps({
      sweep: async () => {
        throw new Error('sweep exploded')
      },
    }))).resolves.toBeNull()
  })

  describe('scheduler timers', () => {
    const originalNodeEnv = config.nodeEnv

    beforeEach(() => {
      vi.useFakeTimers()
      config.nodeEnv = 'development'
      // Exercise the real scheduler while keeping its initial sweep out of DB.
      vi.spyOn(cronLease, 'acquireCronLeaseWithHeartbeat').mockResolvedValue(null)
    })

    afterEach(async () => {
      stopRankingCron()
      stopRankingRetentionCron()
      await Promise.resolve()
      config.nodeEnv = originalNodeEnv
      vi.restoreAllMocks()
      vi.useRealTimers()
    })

    it('starts each timer once, stops both, and can restart', () => {
      startRankingCron()
      startRankingCron()
      startRankingRetentionCron()
      expect(vi.getTimerCount()).toBe(2)

      stopRankingCron()
      stopRankingCron()
      expect(vi.getTimerCount()).toBe(0)

      startRankingCron()
      expect(vi.getTimerCount()).toBe(2)
      stopRankingCron()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('stops independently started retention through the shared stop entry', async () => {
      startRankingRetentionCron()
      startRankingRetentionCron()
      expect(vi.getTimerCount()).toBe(1)

      stopRankingCron()
      expect(vi.getTimerCount()).toBe(0)

      // Stopping timers does not disable subsequent direct batch execution.
      await Promise.resolve()
      const stats = await __runRankingRetentionForTests(deps())
      expect(stats).not.toBeNull()
    })
  })
})
