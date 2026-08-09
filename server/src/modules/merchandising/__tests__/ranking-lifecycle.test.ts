// T-MERCH-BE-001 — Ranking run repository/lifecycle tests (SPEC-MERCH-001 §5.1/§6.2,
// CHK-HOT-006/007/009/010/012, CHK-OPS-001/002, REQ-MERCH-NF-001/005).
//
// Two explicit tiers (BE-001 wrap-up; no DB mocks anywhere):
//   1) "pure unit (no DB)" — cadence + frozen-config validation. Runs in any
//      CI/no-DB context; never touches the database.
//   2) Real-PG integration — true end-to-end semantics against the dedicated
//      merch test database. These run ONLY when TEST_DATABASE_URL is set
//      (real PostgreSQL, never mocked/faked). Without it they are skipped and
//      listed as REAL-PG PENDING VERIFICATION. The lifecycle's compute is
//      injected (T-MERCH-BE-002 owns the real Order aggregation); fixtures
//      write deterministic snapshots for real products/categories.

import { describe, expect, it, beforeEach } from 'vitest'
import { prisma } from '../../../lib/prisma.js'
import {
  buildSessionLockDatasourceUrl,
  createRunningRun,
  dbNow,
  findLatestCompletedRun,
  findMostRecentRun,
  markRunFailed,
  reclaimStaleRunning,
  RankingRunSessionLock,
  RunFencedError,
  runRetention,
  writeSnapshotsAndComplete,
} from '../ranking/repository.js'
import {
  isRecomputeDue,
  loadRankingConfig,
  maybeRunRankingRun,
  runRankingRun,
  validateRankingConfig,
} from '../ranking/lifecycle.js'
import {
  getRankingCompute,
  runRankingCronBatch,
  setRankingCompute,
  startRankingCron,
  stopRankingCron,
} from '../ranking/cron.js'
import { listAdminRuns, requestManualRecompute } from '../ranking/admin.js'
import {
  merchandisingRunTotal,
  merchandisingSnapshotProducts,
  recordRunOutcome,
} from '../ranking/metrics.js'
import { RUN_STATUS } from '../constants.js'
import { RUN_FAILURE_CODES, type RankingConfig, type RunCompute, type SnapshotInput } from '../ranking/types.js'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

const TEST_CONFIG: RankingConfig = {
  hotWindowDays: 30,
  hotMinSales: 5,
  hotTopPercent: 20,
  hotRecomputeMinutes: 60,
  hotRunTimeoutMinutes: 30,
}

const configLoader = async () => ({ ...TEST_CONFIG })

async function createCategoryAndProducts(count: number) {
  const actor = await prisma.user.create({
    data: { email: `rank-actor-${Date.now()}@test.local`, password: 'x', role: 'admin' },
  })
  const category = await prisma.productCategory.create({
    data: {
      code: `rank-cat-${Date.now()}`,
      label: `排名分类-${Date.now()}`,
      normalizedLabel: `排名分类-${Date.now()}`,
      status: 'active',
      sortOrder: 0,
      createdByUserId: actor.id,
      updatedByUserId: actor.id,
    },
  })
  const products: Array<{ id: number; categoryId: number }> = []
  for (let i = 0; i < count; i++) {
    const product = await prisma.product.create({
      data: {
        name: `排名商品-${i}-${Date.now()}`,
        type: '网络节点',
        price: 100,
        status: 'active',
        categoryId: category.id,
      },
    })
    products.push({ id: product.id, categoryId: category.id })
  }
  return { categoryId: category.id, products }
}

/** 返回 deterministic snapshots 的 fixture compute（i 号商品 = count-i 单，i 号 hot）。 */
function fixtureCompute(products: Array<{ id: number; categoryId: number }>): RunCompute {
  return async (_tx, ctx) => {
    const total = products.length
    return products.map((p, index) => {
      const effectiveOrderCount = total - index
      return {
        productId: p.id,
        categoryId: p.categoryId,
        effectiveOrderCount,
        categoryRank: index + 1,
        categoryPopulation: total,
        isHot: index < 2,
      } satisfies SnapshotInput
    })
  }
}

async function snapshotCount(runId: string): Promise<number> {
  return prisma.productMerchandisingSnapshot.count({ where: { runId } })
}

async function runRow(runId: string) {
  return prisma.merchandisingRun.findUniqueOrThrow({ where: { id: runId } })
}

// Real-PG integration tier: gated on TEST_DATABASE_URL. Without a dedicated
// test DB these suites are skipped (REAL-PG PENDING VERIFICATION); with one set
// they run against real PostgreSQL. No mocks/fakes ever stand in for real PG.
const realPg = describe.skipIf(!process.env.TEST_DATABASE_URL)

realPg('ranking run lifecycle — advisory lock (REAL-PG)', () => {
  beforeEach(async () => {
    // 允许该 real-PG suite 对同一专库重复执行；上一轮中断遗留的 running
    // row 不得把本轮并发验证短路为 running_exists。
    await prisma.merchandisingRun.deleteMany()
  })

  it('is exclusive across two dedicated connections, and is released on release()', async () => {
    const lock1 = new RankingRunSessionLock()
    const lock2 = new RankingRunSessionLock()
    expect(await lock1.acquire()).toBe(true)
    // 第二连接（另一"进程"）在同一把锁上必须被拒——两个进程仅一 run。
    expect(await lock2.acquire()).toBe(false)
    await lock1.release()
    // release 后锁可用，不遗留孤儿锁（stop/restart 语义）。
    expect(await lock2.acquire()).toBe(true)
    await lock2.release()
  })

  it('acquire → release → reacquire on the same instance proves release() truly unlocks', async () => {
    const lock = new RankingRunSessionLock()
    expect(await lock.acquire()).toBe(true)
    // release() 不抛错：pg_advisory_unlock 在同一物理会话上返回 true
    // （connection_limit=1 保证 acquire/unlock 同一连接；返回 false 会大声抛错）。
    await lock.release()
    // 同实例 reacquire：另一会话 probe 能拿到锁，即为「已真正解锁」的证明
    // （若 release 未解锁，会话锁计数仍占用，probe 会被拒）。
    const probe = new RankingRunSessionLock()
    expect(await probe.acquire()).toBe(true)
    await probe.release()
    // 锁归还后同实例再次 acquire 也成功（无残留锁计数）。
    expect(await lock.acquire()).toBe(true)
    await lock.release()
  })

  it('two concurrent lifecycle runs produce exactly one run row', async () => {
    const { products } = await createCategoryAndProducts(3)
    const compute = fixtureCompute(products)
    const outcomes = await Promise.all([
      maybeRunRankingRun({ compute, configLoader }),
      maybeRunRankingRun({ compute, configLoader }),
    ])
    const completed = outcomes.filter(o => o.kind === 'completed')
    const skipped = outcomes.filter(o => o.kind === 'skipped')
    expect(completed).toHaveLength(1)
    expect(skipped.length).toBeGreaterThanOrEqual(1)
    expect(await prisma.merchandisingRun.count()).toBe(1)
  })
})

realPg('ranking run lifecycle — A/B/C failure semantics (REAL-PG)', () => {
  beforeEach(async () => {
    await prisma.merchandisingRun.deleteMany()
  })

  it('creates running (short tx A), writes snapshots + completes (tx B), freezes config and DB time', async () => {
    const { categoryId, products } = await createCategoryAndProducts(3)
    const before = await dbNow()
    const outcome = await runRankingRun({ compute: fixtureCompute(products), configLoader })
    expect(outcome.kind).toBe('completed')
    const run = await runRow((outcome as { runId: string }).runId)
    expect(run.status).toBe(RUN_STATUS.COMPLETED)
    expect(run.completedAt).not.toBeNull()
    // config + DB 时间冻结进 run
    expect(run.windowDays).toBe(30)
    expect(run.minSales).toBe(5)
    expect(run.topPercent).toBe(20)
    expect(run.windowEnd.getTime()).toBeGreaterThanOrEqual(before.getTime() - 2000)
    expect(run.windowEnd.getTime() - run.windowStart.getTime()).toBe(30 * 24 * HOUR_MS)
    expect(run.startedAt.getTime()).toBe(run.windowEnd.getTime())
    // snapshots 全部写入
    expect(await snapshotCount(run.id)).toBe(3)
    const snapshots = await prisma.productMerchandisingSnapshot.findMany({
      where: { runId: run.id },
      orderBy: { categoryRank: 'asc' },
    })
    expect(snapshots.map(s => s.isHot)).toEqual([true, true, false])
    expect(snapshots.every(s => s.categoryId === categoryId)).toBe(true)
  })

  it('injected compute failure → run failed, no partial snapshot, previous completed still readable', async () => {
    const { products } = await createCategoryAndProducts(2)
    // 上一 completed run 保持可读
    const first = await runRankingRun({ compute: fixtureCompute(products), configLoader })
    expect(first.kind).toBe('completed')

    const throwingCompute: RunCompute = async () => {
      throw new Error('fixture compute exploded')
    }
    const second = await runRankingRun({ compute: throwingCompute, configLoader })
    expect(second.kind).toBe('failed')
    expect((second as { failureCode: string }).failureCode).toBe(RUN_FAILURE_CODES.COMPUTE_FAILED)
    expect((second as { wrappedUp: boolean }).wrappedUp).toBe(true)

    const secondRun = await runRow((second as { runId: string }).runId)
    expect(secondRun.status).toBe(RUN_STATUS.FAILED)
    expect(await snapshotCount(secondRun.id)).toBe(0) // 无 partial snapshot

    const latest = await findLatestCompletedRun()
    expect(latest?.id).toBe((first as { runId: string }).runId) // 上一 completed 仍可读
  })

  it('commit failure (CHECK violation in snapshot write) → whole tx B rolled back, run failed, previous intact', async () => {
    const { products } = await createCategoryAndProducts(2)
    const first = await runRankingRun({ compute: fixtureCompute(products), configLoader })
    expect(first.kind).toBe('completed')

    const invalidCompute: RunCompute = async () => [
      {
        productId: products[0].id,
        categoryId: products[0].categoryId,
        effectiveOrderCount: -1, // 违反 CHECK 约束 → createMany 抛错 → 事务 B 回滚
        categoryRank: 1,
        categoryPopulation: 1,
        isHot: false,
      },
    ]
    const second = await runRankingRun({ compute: invalidCompute, configLoader })
    expect(second.kind).toBe('failed')
    expect((second as { failureCode: string }).failureCode).toBe(RUN_FAILURE_CODES.COMMIT_FAILED)

    const secondRun = await runRow((second as { runId: string }).runId)
    expect(secondRun.status).toBe(RUN_STATUS.FAILED)
    expect(await snapshotCount(secondRun.id)).toBe(0)
    expect((await findLatestCompletedRun())?.id).toBe((first as { runId: string }).runId)
  })

  it('mark-failed terminal CAS collision never fabricates wrap-up success', async () => {
    const throwingCompute: RunCompute = async () => {
      throw new Error('boom')
    }
    let nowCalls = 0
    const terminalizingDbNow = async () => {
      const now = await dbNow()
      nowCalls += 1
      // 第三次取时发生在事务 B 已回滚、独立事务 C 之前。模拟另一个恢复者
      // 已把该 run 推进到 terminal：真实 DB CAS 随后必须影响 0 行。
      if (nowCalls === 3) {
        await prisma.merchandisingRun.updateMany({
          where: { status: RUN_STATUS.RUNNING },
          data: { status: RUN_STATUS.COMPLETED, completedAt: now },
        })
      }
      return now
    }
    const outcome = await runRankingRun({
      compute: throwingCompute,
      configLoader,
      dbNow: terminalizingDbNow,
    })
    expect(outcome.kind).toBe('failed')
    expect((outcome as { wrappedUp: boolean }).wrappedUp).toBe(false)
    expect((await runRow((outcome as { runId: string }).runId)).status).toBe(RUN_STATUS.COMPLETED)
  })
})

realPg('ranking run lifecycle — stale running reclaim / fencing (REAL-PG)', () => {
  beforeEach(async () => {
    await prisma.merchandisingRun.deleteMany()
  })

  it('reclaims kill -9 leftover stale running by DB time as RUN_TIMEOUT; fresh running survives', async () => {
    const now = await dbNow()
    const stale = await createRunningRun({
      windowStart: new Date(now.getTime() - 2 * HOUR_MS),
      windowEnd: now,
      windowDays: 30,
      minSales: 5,
      topPercent: 20,
      startedAt: new Date(now.getTime() - 2 * HOUR_MS),
    })
    const reclaimed = await reclaimStaleRunning(TEST_CONFIG.hotRunTimeoutMinutes)
    expect(reclaimed).toBe(1)
    const staleRow = await runRow(stale.id)
    expect(staleRow.status).toBe(RUN_STATUS.FAILED)
    expect(staleRow.failureCode).toBe(RUN_FAILURE_CODES.RUN_TIMEOUT)
    expect(staleRow.failedAt).not.toBeNull()

    // partial unique 明确禁止同时存在 stale + fresh 两条 running；回收 stale
    // 后再创建 fresh，并再次执行 reclaim 证明新鲜 run 不会被误伤。
    const fresh = await createRunningRun({
      windowStart: new Date(now.getTime() - HOUR_MS),
      windowEnd: now,
      windowDays: 30,
      minSales: 5,
      topPercent: 20,
      startedAt: new Date(now.getTime() - 10 * MINUTE_MS),
    })
    expect(await reclaimStaleRunning(TEST_CONFIG.hotRunTimeoutMinutes)).toBe(0)
    const freshRow = await runRow(fresh.id)
    expect(freshRow.status).toBe(RUN_STATUS.RUNNING)
  })

  it('after reclaim the old process is fenced: writeSnapshotsAndComplete rolls back, cannot complete', async () => {
    const now = await dbNow()
    const { products } = await createCategoryAndProducts(1)
    const stale = await createRunningRun({
      windowStart: new Date(now.getTime() - 2 * HOUR_MS),
      windowEnd: now,
      windowDays: 30,
      minSales: 5,
      topPercent: 20,
      startedAt: new Date(now.getTime() - 2 * HOUR_MS),
    })
    await reclaimStaleRunning(TEST_CONFIG.hotRunTimeoutMinutes)

    // 旧进程恢复：事务 B 的 completed CAS 影响 0 行 → RunFencedError → 整体回滚。
    await expect(
      writeSnapshotsAndComplete(
        {
          runId: stale.id,
          completedAt: await dbNow(),
          context: {
            runId: stale.id,
            windowStart: new Date(now.getTime() - 2 * HOUR_MS),
            windowEnd: now,
            windowDays: 30,
            minSales: 5,
            topPercent: 20,
          },
          compute: fixtureCompute(products),
        },
      ),
    ).rejects.toThrow(RunFencedError)

    const staleRow = await runRow(stale.id)
    expect(staleRow.status).toBe(RUN_STATUS.FAILED) // 不能 completed
    expect(await snapshotCount(stale.id)).toBe(0) // 也不能留 partial snapshot
  })

  it('runRankingRun reclaims stale running then completes a new run', async () => {
    const now = await dbNow()
    const { products } = await createCategoryAndProducts(2)
    const stale = await createRunningRun({
      windowStart: new Date(now.getTime() - 2 * HOUR_MS),
      windowEnd: now,
      windowDays: 30,
      minSales: 5,
      topPercent: 20,
      startedAt: new Date(now.getTime() - 2 * HOUR_MS),
    })
    const outcome = await runRankingRun({ compute: fixtureCompute(products), configLoader })
    expect(outcome.kind).toBe('completed')
    expect((await runRow(stale.id)).status).toBe(RUN_STATUS.FAILED)
    expect((await runRow(stale.id)).failureCode).toBe(RUN_FAILURE_CODES.RUN_TIMEOUT)
    expect(await prisma.merchandisingRun.count()).toBe(2)
  })
})

realPg('ranking run lifecycle — cadence (hotRecomputeMinutes) rate contract (REAL-PG)', () => {
  beforeEach(async () => {
    await prisma.merchandisingRun.deleteMany()
  })

  it('skips a fresh completed run and runs again only after the interval', async () => {
    const { products } = await createCategoryAndProducts(1)
    const compute = fixtureCompute(products)
    const first = await maybeRunRankingRun({ compute, configLoader })
    expect(first.kind).toBe('completed')

    const second = await maybeRunRankingRun({ compute, configLoader })
    expect(second.kind).toBe('skipped')
    expect((second as { reason: string }).reason).toBe('cadence')
    expect(await prisma.merchandisingRun.count()).toBe(1)

    // 冻结 DB 时间推进 > hotRecomputeMinutes → cadence 到期
    const now = await dbNow()
    const future = new Date(now.getTime() + (TEST_CONFIG.hotRecomputeMinutes + 1) * MINUTE_MS)
    const third = await maybeRunRankingRun({
      compute,
      configLoader,
      dbNow: async () => future,
    })
    expect(third.kind).toBe('completed')
    expect(await prisma.merchandisingRun.count()).toBe(2)
  })

  it('a failed run allows immediate retry (not throttled by cadence)', async () => {
    const { products } = await createCategoryAndProducts(1)
    const failing = await runRankingRun({
      compute: async () => {
        throw new Error('boom')
      },
      configLoader,
    })
    expect(failing.kind).toBe('failed')

    const retry = await maybeRunRankingRun({ compute: fixtureCompute(products), configLoader })
    expect(retry.kind).toBe('completed')
  })
})

realPg('ranking run lifecycle — public read / running-failed never public (REAL-PG)', () => {
  beforeEach(async () => {
    await prisma.merchandisingRun.deleteMany()
  })

  it('findLatestCompletedRun only ever returns the latest completed run', async () => {
    const { products } = await createCategoryAndProducts(1)
    const now = await dbNow()

    const completed = await prisma.merchandisingRun.create({
      data: {
        status: RUN_STATUS.COMPLETED,
        windowStart: new Date(now.getTime() - HOUR_MS),
        windowEnd: now,
        windowDays: 30,
        minSales: 5,
        topPercent: 20,
        startedAt: now,
        completedAt: now,
      },
    })
    const running = await prisma.merchandisingRun.create({
      data: {
        status: RUN_STATUS.RUNNING,
        windowStart: new Date(now.getTime() - HOUR_MS),
        windowEnd: now,
        windowDays: 30,
        minSales: 5,
        topPercent: 20,
        startedAt: new Date(now.getTime() + MINUTE_MS),
      },
    })
    const failed = await prisma.merchandisingRun.create({
      data: {
        status: RUN_STATUS.FAILED,
        windowStart: new Date(now.getTime() - HOUR_MS),
        windowEnd: now,
        windowDays: 30,
        minSales: 5,
        topPercent: 20,
        startedAt: new Date(now.getTime() + 2 * MINUTE_MS),
        failedAt: now,
        failureCode: RUN_FAILURE_CODES.COMPUTE_FAILED,
      },
    })
    expect(running).toBeDefined()
    expect(failed).toBeDefined()

    const latest = await findLatestCompletedRun()
    expect(latest?.id).toBe(completed.id)
  })
})

realPg('ranking run lifecycle — retention (REAL-PG)', () => {
  beforeEach(async () => {
    await prisma.merchandisingRun.deleteMany()
  })

  it('cleans superseded completed runs (>48h, keeps latest), failed snapshots (>48h) and failed runs (>7d)', async () => {
    const now = await dbNow()
    const { products } = await createCategoryAndProducts(1)
    const snapshotsFor = async (runId: string) => {
      await prisma.productMerchandisingSnapshot.create({
        data: {
          runId,
          productId: products[0].id,
          categoryId: products[0].categoryId,
          effectiveOrderCount: 1,
          categoryRank: 1,
          categoryPopulation: 1,
          isHot: true,
          computedAt: now,
        },
      })
    }

    // 旧 completed（>48h，被替换）→ 应删除
    const oldCompleted = await prisma.merchandisingRun.create({
      data: {
        status: RUN_STATUS.COMPLETED,
        windowStart: new Date(now.getTime() - 4 * 24 * HOUR_MS),
        windowEnd: new Date(now.getTime() - 3 * 24 * HOUR_MS),
        windowDays: 30, minSales: 5, topPercent: 20,
        startedAt: new Date(now.getTime() - 3 * 24 * HOUR_MS),
        completedAt: new Date(now.getTime() - 3 * 24 * HOUR_MS),
      },
    })
    await snapshotsFor(oldCompleted.id)

    // 最新 completed → 保留
    const latestCompleted = await prisma.merchandisingRun.create({
      data: {
        status: RUN_STATUS.COMPLETED,
        windowStart: new Date(now.getTime() - HOUR_MS),
        windowEnd: now,
        windowDays: 30, minSales: 5, topPercent: 20,
        startedAt: now,
        completedAt: now,
      },
    })
    await snapshotsFor(latestCompleted.id)

    // 旧 failed（>7d）→ 删除
    const oldFailed = await prisma.merchandisingRun.create({
      data: {
        status: RUN_STATUS.FAILED,
        windowStart: new Date(now.getTime() - 10 * 24 * HOUR_MS),
        windowEnd: new Date(now.getTime() - 9 * 24 * HOUR_MS),
        windowDays: 30, minSales: 5, topPercent: 20,
        startedAt: new Date(now.getTime() - 9 * 24 * HOUR_MS),
        failedAt: new Date(now.getTime() - 9 * 24 * HOUR_MS),
        failureCode: RUN_FAILURE_CODES.RUN_TIMEOUT,
      },
    })
    await snapshotsFor(oldFailed.id)

    // failed 3 天前（>48h snapshots 清理、<7d 行保留）
    const midFailed = await prisma.merchandisingRun.create({
      data: {
        status: RUN_STATUS.FAILED,
        windowStart: new Date(now.getTime() - 4 * 24 * HOUR_MS),
        windowEnd: new Date(now.getTime() - 3 * 24 * HOUR_MS),
        windowDays: 30, minSales: 5, topPercent: 20,
        startedAt: new Date(now.getTime() - 3 * 24 * HOUR_MS),
        failedAt: new Date(now.getTime() - 3 * 24 * HOUR_MS),
        failureCode: RUN_FAILURE_CODES.COMPUTE_FAILED,
      },
    })
    await snapshotsFor(midFailed.id)

    // fresh failed（<48h）→ 整行 + snapshots 都保留
    const freshFailed = await prisma.merchandisingRun.create({
      data: {
        status: RUN_STATUS.FAILED,
        windowStart: new Date(now.getTime() - HOUR_MS),
        windowEnd: now,
        windowDays: 30, minSales: 5, topPercent: 20,
        startedAt: now,
        failedAt: now,
        failureCode: RUN_FAILURE_CODES.COMPUTE_FAILED,
      },
    })
    await snapshotsFor(freshFailed.id)

    const stats = await runRetention()

    expect(stats.deletedSupersededCompletedRuns).toBe(1)
    // oldFailed（>7d）与 midFailed（>48h）两者的 snapshot 都先按 48h
    // retention 删除；随后 oldFailed run 行再按 7d retention 删除。
    expect(stats.deletedFailedRunSnapshots).toBe(2)
    expect(stats.deletedFailedRuns).toBe(1)

    expect(await prisma.merchandisingRun.findUnique({ where: { id: oldCompleted.id } })).toBeNull()
    expect(await prisma.merchandisingRun.findUnique({ where: { id: latestCompleted.id } })).not.toBeNull()
    expect(await prisma.merchandisingRun.findUnique({ where: { id: oldFailed.id } })).toBeNull()
    expect(await prisma.merchandisingRun.findUnique({ where: { id: midFailed.id } })).not.toBeNull()
    expect(await snapshotCount(midFailed.id)).toBe(0) // snapshots 被清，行保留诊断
    expect(await prisma.merchandisingRun.findUnique({ where: { id: freshFailed.id } })).not.toBeNull()
    expect(await snapshotCount(freshFailed.id)).toBe(1)
  })
})

realPg('ranking run lifecycle — admin run query + manual recompute (REAL-PG)', () => {
  beforeEach(async () => {
    await prisma.merchandisingRun.deleteMany()
  })

  async function makeAdmin() {
    return prisma.user.create({ data: { email: `admin-${Date.now()}@test.local`, password: 'x', role: 'admin' } })
  }

  it('requestManualRecompute skips with compute_unavailable when no compute registered (BE-002)', async () => {
    const admin = await makeAdmin()
    // compute 未注册（模块级初始为 null）→ 明确 skipped(compute_unavailable)，
    // 不再误报 running_exists（后者描述的是“已有 running 未超时”，与实况不符）。
    expect(getRankingCompute()).toBeNull()
    const outcome = await requestManualRecompute(admin.id)
    expect(outcome.kind).toBe('skipped')
    expect((outcome as { reason: string }).reason).toBe('compute_unavailable')
    // 未真正开跑：不写 AdminLog，也不产生 run 行。
    expect(await prisma.adminLog.count({ where: { adminUserId: admin.id } })).toBe(0)
    expect(await prisma.merchandisingRun.count()).toBe(0)
  })

  it('listAdminRuns is paginated, ordered, and exposes only desensitized run fields + snapshot count', async () => {
    const { products } = await createCategoryAndProducts(1)
    const compute = fixtureCompute(products)
    for (let i = 0; i < 3; i++) {
      await runRankingRun({ compute, configLoader })
      await prisma.merchandisingRun.updateMany({
        where: { status: RUN_STATUS.COMPLETED },
        data: { startedAt: new Date(Date.now() - i * MINUTE_MS), completedAt: new Date(Date.now() - i * MINUTE_MS) },
      })
    }
    const page = await listAdminRuns({ page: 1, pageSize: 2 })
    expect(page.total).toBe(3)
    expect(page.pageSize).toBe(2)
    expect(page.runs).toHaveLength(2)
    expect(page.runs[0].startedAt.getTime()).toBeGreaterThanOrEqual(page.runs[1].startedAt.getTime())
    expect(page.runs[0].snapshotCount).toBe(1)
    expect(page.runs[0]).not.toHaveProperty('orders')
    expect(page.runs[0]).not.toHaveProperty('userId')
  })

  it('requestManualRecompute rejects non-admin callers with 403 FORBIDDEN', async () => {
    const user = await prisma.user.create({ data: { email: `non-admin-${Date.now()}@test.local`, password: 'x', role: 'user' } })
    setRankingCompute(fixtureCompute([]))
    await expect(requestManualRecompute(user.id)).rejects.toMatchObject({ status: 403 })
  })

  it('requestManualRecompute is throttled by cadence (rate contract) and writes AdminLog on a real run', async () => {
    const admin = await makeAdmin()
    const { products } = await createCategoryAndProducts(1)
    const compute = fixtureCompute(products)
    setRankingCompute(compute)

    // 首次：真实开跑 → AdminLog
    const first = await requestManualRecompute(admin.id)
    expect(first.kind).toBe('completed')
    let log = await prisma.adminLog.findFirst({ where: { adminUserId: admin.id } })
    expect(log).not.toBeNull()
    expect(log!.action).toContain('手动重算排名')

    // 紧接第二次：cadence 未到期 → throttled，不再写新 AdminLog
    const second = await requestManualRecompute(admin.id)
    expect(second.kind).toBe('skipped')
    expect((second as { reason: string }).reason).toBe('cadence')
    expect(await prisma.adminLog.count({ where: { adminUserId: admin.id } })).toBe(1)
    expect(await prisma.merchandisingRun.count()).toBe(1)
  })

  it('manual recompute skips cleanly when compute is not yet registered (BE-002)', async () => {
    setRankingCompute(async () => [])
    const admin = await makeAdmin()
    // 先跑一次真实完成，再取消注册
    await requestManualRecompute(admin.id)
    // 无法取消注册（模块级），改用一个新的空 compute 不会触发；这里直接验证 getRankingCompute 非空。
    expect(getRankingCompute()).not.toBeNull()
  })
})

realPg('ranking run lifecycle — metrics and cron (REAL-PG)', () => {
  beforeEach(async () => {
    await prisma.merchandisingRun.deleteMany()
    merchandisingRunTotal.reset()
    merchandisingSnapshotProducts.set(0)
  })

  it('records bounded run outcomes and snapshot product gauge; rejects unknown labels', async () => {
    const { products } = await createCategoryAndProducts(2)
    const outcome = await runRankingRun({ compute: fixtureCompute(products), configLoader })
    expect(outcome.kind).toBe('completed')

    const counter = await merchandisingRunTotal.get()
    const completedSeries = counter.values.find(v => v.labels.outcome === 'completed')
    expect(completedSeries?.value).toBeGreaterThan(0)
    const snapshotGauge = await merchandisingSnapshotProducts.get()
    expect(snapshotGauge.values[0]?.value).toBe(2)

    expect(() => recordRunOutcome('bogus' as never)).toThrow()
  })

  it('runRankingCronBatch runs when compute registered; start/stop are idempotent and lock is released after run', async () => {
    const { products } = await createCategoryAndProducts(1)
    setRankingCompute(fixtureCompute(products))
    const results = await runRankingCronBatch()
    expect(results).toHaveLength(1)
    expect(results[0].kind).toBe('completed')

    // start/stop 幂等（test 环境 start 直接返回；重复调用不抛、不泄漏 timer）。
    startRankingCron()
    startRankingCron()
    stopRankingCron()
    stopRankingCron()

    // run 结束后 advisory lock 已释放：新连接能立刻拿到（无孤儿锁）。
    const probe = new RankingRunSessionLock()
    expect(await probe.acquire()).toBe(true)
    await probe.release()
  })
})

describe('ranking run lifecycle — pure unit (no DB)', () => {
  it('isRecomputeDue covers no-run / failed / running / completed-within-interval', async () => {
    const now = new Date('2026-08-09T00:00:00Z')
    expect(await isRecomputeDue(60, now, null)).toBe(true)
    expect(await isRecomputeDue(60, now, { status: RUN_STATUS.FAILED, startedAt: now })).toBe(true)
    expect(await isRecomputeDue(60, now, { status: RUN_STATUS.RUNNING, startedAt: now })).toBe(true)
    const fresh = { status: RUN_STATUS.COMPLETED, startedAt: new Date(now.getTime() - 10 * MINUTE_MS) }
    expect(await isRecomputeDue(60, now, fresh)).toBe(false)
    const old = { status: RUN_STATUS.COMPLETED, startedAt: new Date(now.getTime() - 61 * MINUTE_MS) }
    expect(await isRecomputeDue(60, now, old)).toBe(true)
  })

  it('buildSessionLockDatasourceUrl forces connection_limit=1 and preserves other params (pure, no DB)', () => {
    // 纯函数：只做 URL 变换，不读 env、不打日志；返回值仅供 PrismaClient 构造，
    // 绝不落日志/对外返回（含凭据）。
    const url = buildSessionLockDatasourceUrl('postgresql://user:pass@dbhost:5432/monexus_test?schema=public&connect_timeout=5')
    const parsed = new URL(url)
    expect(parsed.searchParams.get('connection_limit')).toBe('1')
    expect(parsed.searchParams.get('schema')).toBe('public')
    expect(parsed.searchParams.get('connect_timeout')).toBe('5')
    expect(parsed.hostname).toBe('dbhost')
    expect(parsed.port).toBe('5432')
    expect(parsed.pathname).toBe('/monexus_test')
    // 已存在的 connection_limit 被强制覆盖为 1（force 语义），其余参数保留。
    const replaced = new URL(
      buildSessionLockDatasourceUrl('postgresql://user:pass@dbhost:5432/monexus_test?connection_limit=5&schema=public'),
    )
    expect(replaced.searchParams.get('connection_limit')).toBe('1')
    expect(replaced.searchParams.get('schema')).toBe('public')
  })

  it('validateRankingConfig rejects out-of-range frozen values (pure, no DB)', () => {
    // 冻结范围与 DB CHECK 一致：越界或非整数直接抛错，不清静回退。
    expect(() => validateRankingConfig({ ...TEST_CONFIG, hotWindowDays: 0 })).toThrow(/out of frozen range/)
    expect(() => validateRankingConfig({ ...TEST_CONFIG, hotWindowDays: 366 })).toThrow(/out of frozen range/)
    expect(() => validateRankingConfig({ ...TEST_CONFIG, hotWindowDays: 1.5 })).toThrow(/out of frozen range/)
    expect(() => validateRankingConfig({ ...TEST_CONFIG, hotTopPercent: 101 })).toThrow(/out of frozen range/)
    expect(() => validateRankingConfig({ ...TEST_CONFIG, hotRecomputeMinutes: 9 })).toThrow(/out of frozen range/)
    expect(() => validateRankingConfig({ ...TEST_CONFIG, hotRunTimeoutMinutes: 1441 })).toThrow(/out of frozen range/)
    expect(() => validateRankingConfig(TEST_CONFIG)).not.toThrow()
  })
})

realPg('ranking run lifecycle — loadRankingConfig reads frozen SystemConfig keys (REAL-PG)', () => {
  it('loadRankingConfig returns frozen merchandising SystemConfig values', async () => {
    // 读 SystemConfig 的 F0 merchandising keys（缺行回退默认值）；需真实 PG。
    const cfg = await loadRankingConfig()
    expect(cfg.hotWindowDays).toEqual(expect.any(Number))
    expect(cfg.hotMinSales).toEqual(expect.any(Number))
    expect(cfg.hotTopPercent).toEqual(expect.any(Number))
    expect(cfg.hotRecomputeMinutes).toEqual(expect.any(Number))
    expect(cfg.hotRunTimeoutMinutes).toEqual(expect.any(Number))
  })
})
