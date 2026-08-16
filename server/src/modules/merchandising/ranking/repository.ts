// T-MERCH-BE-001 — Ranking run repository/lifecycle DB primitives
// (SPEC-MERCH-001 §5.1/§5.2/§6.2).
//
// Owns the frozen failure semantics:
//   - session advisory lock held for the whole run on a DEDICATED connection
//     (never a pooled connection that the pool could hand to another query);
//   - 短事务 A 只创建 running run 并提交；
//   - 事务 B 内 compute → 写全部 snapshots → `WHERE id=? AND status='running'`
//     CAS completed；任一步失败整体回滚，不留 partial snapshot；
//   - 旧进程 fencing：CAS 影响 0 行（run 已被 reclaim 成 failed）时抛
//     RunFencedError 使整个事务回滚，旧进程不能 completed 也不能留 partial；
//   - 独立短事务 C 把 running CAS 成 failed（失败只能由调用方告警）；
//   - stale running 按 DB 时间 + hotRunTimeoutMinutes 回收为 RUN_TIMEOUT；
//   - public 侧只读 latest completed（running/failed 永不公开）；
//   - retention：48h 前被替换的 completed run 清理（保留当前 run）、
//     失败 run 诊断保留 7 天（snapshots 48h 后可删）。

import { Prisma, PrismaClient } from '@prisma/client'
import { config } from '../../../config/index.js'
import { prisma } from '../../../lib/prisma.js'
import { RUN_STATUS } from '../constants.js'
import {
  RANKING_RUN_LOCK_CLASS,
  RUN_FAILURE_CODES,
  type RetentionStats,
  type RunCompute,
  type RunComputeContext,
  type SnapshotInput,
} from './types.js'

/** Any DB handle that exposes the ranking model delegates + raw SQL. */
export type AnyDb = PrismaClient | Prisma.TransactionClient

/** Completed run retention horizon（保留当前 cursor run，旧的被替换 run 48h 后清理）。 */
export const COMPLETED_RUN_RETENTION_HOURS = 48
/** Failed run 诊断保留天数（spec §6.2 step 7）。 */
export const FAILED_RUN_RETENTION_DAYS = 7

/** Prisma unique-violation error code（`MerchandisingRun_single_running` 兜底）。 */
const PRISMA_UNIQUE_VIOLATION = 'P2002'

export class RunFencedError extends Error {
  constructor(readonly runId: string) {
    super(`ranking run ${runId} was reclaimed before completion`)
    this.name = 'RunFencedError'
  }
}

/** 注入的 compute 抛错时由事务 B 包装，供失败分类为 COMPUTE_FAILED。 */
export class ComputeFailedError extends Error {
  constructor(
    readonly runId: string,
    readonly causeErr: unknown,
  ) {
    super(`ranking compute failed for run ${runId}`)
    this.name = 'ComputeFailedError'
  }
}

/** 判断 create running 失败是否来自全局 single-running partial unique（兜底跳过）。 */
export function isSingleRunningConflict(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError
    && err.code === PRISMA_UNIQUE_VIOLATION
    && /MerchandisingRun_single_running/.test(String(err.meta?.target ?? ''))
  )
}

/** 数据库时钟。所有 run 时间语义（window/started/completed/failed、reclaim、retention）
 * 都锚定 DB now()，实例时钟漂移不参与任何判定。 */
export async function dbNow(client: AnyDb = prisma): Promise<Date> {
  const rows = await client.$queryRaw<{ now: Date }[]>`SELECT now() AS now`
  return rows[0].now
}

/** 短事务 A：创建 running run 并提交（单条 create 即独立隐式事务）。 */
export async function createRunningRun(
  input: {
    windowStart: Date
    windowEnd: Date
    windowDays: number
    minSales: number
    topPercent: number
    startedAt: Date
  },
  client: AnyDb = prisma,
) {
  return client.merchandisingRun.create({
    data: {
      status: RUN_STATUS.RUNNING,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      windowDays: input.windowDays,
      minSales: input.minSales,
      topPercent: input.topPercent,
      startedAt: input.startedAt,
    },
  })
}

/**
 * 事务 B：在单个事务内 ①运行注入的 compute ②写该 run 的全部 snapshots
 * ③CAS running→completed。任一步失败整体回滚，不留 partial snapshot。
 *
 * CAS 影响 0 行（run 已被其他 scheduler 按 timeout 回收为 failed）时抛
 * RunFencedError 强制回滚已写 snapshots——旧进程 fencing 后既不能 completed
 * 也不能留下 partial。返回写入的 snapshot 行数。
 */
export async function writeSnapshotsAndComplete(
  input: {
    runId: string
    completedAt: Date
    context: RunComputeContext
    compute: RunCompute
  },
  client: PrismaClient = prisma,
): Promise<number> {
  return client.$transaction(async tx => {
    let snapshots: SnapshotInput[]
    try {
      snapshots = await input.compute(tx, input.context)
    } catch (err) {
      throw new ComputeFailedError(input.runId, err)
    }
    // 先写该 run 的全部 snapshots，再做 completed CAS（spec/plan 冻结顺序：
    // “写全部 snapshots 并 CAS 为 completed”）。两者仍在同一事务 B 内，
    // 后续 CAS 影响 0 行抛 RunFencedError 时，snapshots 一并回滚。
    if (snapshots.length > 0) {
      await tx.productMerchandisingSnapshot.createMany({
        data: snapshots.map(s => ({ ...s, runId: input.runId, computedAt: input.completedAt })),
      })
    }
    const updated = await tx.merchandisingRun.updateMany({
      where: { id: input.runId, status: RUN_STATUS.RUNNING },
      data: { status: RUN_STATUS.COMPLETED, completedAt: input.completedAt },
    })
    if (updated.count !== 1) {
      throw new RunFencedError(input.runId)
    }
    return snapshots.length
  })
}

/** 独立短事务 C：把 running run CAS 成 failed（写 failedAt/failureCode）。
 * 单条 updateMany 即独立隐式事务。返回是否真的发生了 running→failed。 */
export async function markRunFailed(
  runId: string,
  failureCode: string,
  failedAt: Date,
  client: AnyDb = prisma,
): Promise<boolean> {
  const updated = await client.merchandisingRun.updateMany({
    where: { id: runId, status: RUN_STATUS.RUNNING },
    data: { status: RUN_STATUS.FAILED, failedAt, failureCode },
  })
  return updated.count === 1
}

/**
 * 按 DB 时间回收 kill -9 遗留的 stale running：
 * `startedAt < now() - hotRunTimeoutMinutes` 的 running CAS 成 failed
 * （failureCode=RUN_TIMEOUT）。失败/stale run 均不覆盖上一 completed run。
 * 返回回收的 run 数。
 *
 * 时间比较坑（与 leaderboard 同形）：`startedAt` 是裸 UTC `timestamp(3)` 列，
 * 而 `now()` 是 `timestamptz`，两者直接比较会按**会话时区**重解释裸列
 * （本机 +0800 偏移 8h）。`now() AT TIME ZONE 'UTC'` 把右侧也换算成裸 UTC
 * 时间戳，比较与实例/会话时区无关。
 */
export async function reclaimStaleRunning(
  timeoutMinutes: number,
  client: AnyDb = prisma,
): Promise<number> {
  const result = await client.$executeRaw`
    UPDATE "MerchandisingRun"
    SET "status" = ${RUN_STATUS.FAILED},
        "failedAt" = now(),
        "failureCode" = ${RUN_FAILURE_CODES.RUN_TIMEOUT}
    WHERE "status" = ${RUN_STATUS.RUNNING}
      AND "startedAt" < (now() AT TIME ZONE 'UTC') - make_interval(secs => ${timeoutMinutes * 60})
  `
  return result
}

/** reclaim 后仍然存活（未超时）的 running run。存在即表示另一个 scheduler
 * 正在跑或刚崩溃未超时——按 spec "已有running未超时则退出" 跳过。 */
export async function findActiveRunningRun(
  client: AnyDb = prisma,
): Promise<{ id: string; startedAt: Date } | null> {
  return client.merchandisingRun.findFirst({
    where: { status: RUN_STATUS.RUNNING },
    select: { id: true, startedAt: true },
    orderBy: { startedAt: 'desc' },
  })
}

/** 最近一次 run（任意状态）。用于 cadence / admin 查询排序锚点。 */
export async function findMostRecentRun(
  client: AnyDb = prisma,
): Promise<{ id: string; status: string; startedAt: Date } | null> {
  return client.merchandisingRun.findFirst({
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, status: true, startedAt: true },
  })
}

/**
 * public 侧唯一允许读取的 run：最新 completed（`ORDER BY completedAt DESC,
 * id DESC LIMIT 1`）。running/failed 永不公开（MERCH-004 / CHK-HOT-006）。
 * 按 CHECK 约束 completed run 的 completedAt 必非 null；防御性收窄类型。
 */
export async function findLatestCompletedRun(
  client: AnyDb = prisma,
): Promise<{ id: string; completedAt: Date; windowDays: number } | null> {
  const run = await client.merchandisingRun.findFirst({
    where: { status: RUN_STATUS.COMPLETED },
    orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, completedAt: true, windowDays: true },
  })
  if (run === null) return null
  if (run.completedAt === null) {
    // CHECK(status='completed' → completedAt NOT NULL) 保证不可达；防御性兜底。
    throw new Error(`completed ranking run ${run.id} has null completedAt`)
  }
  return { id: run.id, completedAt: run.completedAt, windowDays: run.windowDays }
}

/**
 * Retention（spec §6.2 step 7 / plan §4.1）：
 *  1) 48h 前被替换的 completed run 及其 snapshots 删除，保留当前（最新）completed run；
 *  2) failed run 的 snapshots 48h 后可删（run 行保留诊断）；
 *  3) failed run 行 7 天后删除（连带残留 snapshots）。
 *
 * 全部判定用 DB now()（`AT TIME ZONE 'UTC'` 与裸 UTC 列同形，会话时区无关）；
 * 测试通过回拨行内时间戳验证，不注入宿主时钟。
 */
export async function runRetention(
  client: PrismaClient = prisma,
): Promise<RetentionStats> {
  return client.$transaction(async tx => {
    const deletedSupersededCompletedRuns = await tx.$executeRaw`
      WITH latest AS (
        SELECT "id" FROM "MerchandisingRun"
        WHERE "status" = 'completed'
        ORDER BY "completedAt" DESC, "id" DESC
        LIMIT 1
      )
      DELETE FROM "MerchandisingRun" r
      WHERE r."status" = 'completed'
        AND r."completedAt" < (now() AT TIME ZONE 'UTC') - make_interval(hours => ${COMPLETED_RUN_RETENTION_HOURS}::int)
        AND NOT EXISTS (SELECT 1 FROM latest l WHERE l."id" = r."id")
    `

    const deletedFailedRunSnapshots = await tx.$executeRaw`
      DELETE FROM "ProductMerchandisingSnapshot" s
      USING "MerchandisingRun" r
      WHERE s."runId" = r."id"
        AND r."status" = 'failed'
        AND r."failedAt" < (now() AT TIME ZONE 'UTC') - make_interval(hours => ${COMPLETED_RUN_RETENTION_HOURS}::int)
    `

    const deletedFailedRuns = await tx.$executeRaw`
      DELETE FROM "MerchandisingRun"
      WHERE "status" = 'failed'
        AND "failedAt" < (now() AT TIME ZONE 'UTC') - make_interval(days => ${FAILED_RUN_RETENTION_DAYS}::int)
    `

    return {
      deletedSupersededCompletedRuns,
      deletedFailedRunSnapshots,
      deletedFailedRuns,
    }
  })
}

/**
 * 把 DATABASE_URL 变换成专用连接的 Prisma datasource URL：强制
 * `connection_limit=1`（连接池恒为一个物理连接），从而保证会话级 advisory
 * lock 的 acquire/unlock 永远落在同一条 PG 会话上。纯函数：只做 URL 变换，
 * 不读 env、不打日志；保留其余 query 参数（如 schema）。返回值仅供
 * PrismaClient 构造，绝不打日志或对外返回。
 */
export function buildSessionLockDatasourceUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl)
  url.searchParams.set('connection_limit', '1')
  return url.toString()
}

/**
 * 会话级 advisory lock，持有整个 run 生命周期（横跨短事务 A / B / C）。
 *
 * 锁必须挂在**专用连接**上：Prisma 连接池可能把一条 `$queryRaw` 用的连接
 * 复用给池内其他查询，若把 session lock 打在主 prisma 上会意外阻塞无关流量。
 * 专用 PrismaClient 在 release/进程退出时 `$disconnect()`，连接关闭即由 PG
 * 自动释放 session lock——stop/restart/kill -9 都不会遗留孤儿锁。
 *
 * 专用 datasource 由 `config.databaseUrl` 经 `buildSessionLockDatasourceUrl`
 * 构造并强制 `connection_limit=1`：没有单连接池，连接池可能把 acquire 与
 * unlock 分派到不同的物理会话，session lock 的同一会话语义就不再是形式化
 * 保证（专用默认池不是保证）。
 * 用非阻塞 `pg_try_advisory_lock`：锁被占用时直接跳过本轮（调度优化），
 * DB 的 single-running partial unique 是最终兜底。
 */
export class RankingRunSessionLock {
  private client: PrismaClient | null = null

  constructor(private readonly objectId: number = 1) {}

  async acquire(): Promise<boolean> {
    if (this.client) return true // 已持有
    const client = new PrismaClient({
      datasources: { db: { url: buildSessionLockDatasourceUrl(config.databaseUrl) } },
    })
    try {
      const rows = await client.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(${RANKING_RUN_LOCK_CLASS}::int4, ${this.objectId}::int4) AS locked`
      if (!rows[0]?.locked) {
        await client.$disconnect()
        return false
      }
      this.client = client
      return true
    } catch (err) {
      await client.$disconnect().catch(() => {})
      throw err
    }
  }

  async release(): Promise<void> {
    const client = this.client
    if (!client) return
    this.client = null
    try {
      const rows = await client.$queryRaw<{ unlocked: boolean }[]>`
        SELECT pg_advisory_unlock(${RANKING_RUN_LOCK_CLASS}::int4, ${this.objectId}::int4) AS unlocked`
      // unlock 返回 false 表示本会话不持有该锁（acquire/unlock 落到了不同
      // 物理会话）——大声失败而不是静默吞掉。connection_limit=1 下不可能
      // 分派到别的会话，此处是形式化兜底；错误信息不含 URL/凭据。
      if (!rows[0]?.unlocked) {
        throw new Error(`ranking run advisory lock ${RANKING_RUN_LOCK_CLASS}:${this.objectId} not held on this session`)
      }
    } finally {
      // 无论解锁成功与否都断开专用连接：连接关闭即由 PG 自动释放残留 session lock。
      await client.$disconnect().catch(() => {})
    }
  }
}
