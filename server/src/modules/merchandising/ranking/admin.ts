// T-MERCH-BE-001 — Ranking admin run query + manual recompute
// (SPEC-MERCH-001 §11 GET /api/admin/merchandising/runs,
// POST /api/admin/merchandising/recompute).
//
// Service-level query functions only; route mounting / express middleware
// (admin+MFA guard) is wired by the CMI Integration Owner. This module enforces
// the auth/rate contract at the service layer:
//   - auth：调用者必须是 admin（防御性角色复核；MFA 由路由中间件执行并
//     记录到本模块的 doc 契约中）；
//   - rate：manual recompute 与 scheduled cron 共用 hotRecomputeMinutes cadence
//     （isRecomputeDue）；失败 run 允许立即重试，避免把运维修复锁死；
//   - audit：真正开跑的 recompute 写 AdminLog；
//   - 不泄露订单数据：run 视图只含脱敏 config/status/failureCode。

import { forbidden } from '../../../lib/httpError.js'
import { logger } from '../../../lib/logger.js'
import { prisma } from '../../../lib/prisma.js'
import { getRankingCompute } from './cron.js'
import { maybeRunRankingRun, loadRankingConfig, type RunRankingDeps } from './lifecycle.js'
import type { RankingConfig, RunOutcome } from './types.js'

export interface AdminRunRow {
  id: string
  status: string
  windowStart: Date
  windowEnd: Date
  windowDays: number
  minSales: number
  topPercent: number
  startedAt: Date
  completedAt: Date | null
  failedAt: Date | null
  failureCode: string | null
  createdAt: Date
  snapshotCount: number
}

export interface AdminRunPage {
  runs: AdminRunRow[]
  total: number
  page: number
  pageSize: number
}

/** admin run 列表：分页、按 startedAt 倒序；不含任何订单/用户数据。 */
export async function listAdminRuns(
  input: { page?: number; pageSize?: number } = {},
  db: typeof prisma = prisma,
): Promise<AdminRunPage> {
  const page = Math.max(1, input.page ?? 1)
  const pageSize = Math.min(50, Math.max(1, input.pageSize ?? 20))
  const skip = (page - 1) * pageSize

  const [runs, total] = await Promise.all([
    db.merchandisingRun.findMany({
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      skip,
      take: pageSize,
      select: {
        id: true,
        status: true,
        windowStart: true,
        windowEnd: true,
        windowDays: true,
        minSales: true,
        topPercent: true,
        startedAt: true,
        completedAt: true,
        failedAt: true,
        failureCode: true,
        createdAt: true,
      },
    }),
    db.merchandisingRun.count(),
  ])

  // 有界批查快照数：只查本页 runId（≤50）。
  const pageRunIds = runs.map(r => r.id)
  const countRows = pageRunIds.length === 0
    ? []
    : await db.productMerchandisingSnapshot.groupBy({
        by: ['runId'],
        where: { runId: { in: pageRunIds } },
        _count: { _all: true },
      })
  const countByRun = new Map(countRows.map(r => [r.runId, r._count._all]))

  return {
    runs: runs.map(run => ({
      ...run,
      snapshotCount: countByRun.get(run.id) ?? 0,
    })),
    total,
    page,
    pageSize,
  }
}

export type ManualRecomputeResult = RunOutcome & { adminUserId: number }

/**
 * 手动 recompute（auth/rate contract）。
 *
 * - 仅 admin：非 admin 抛 403 FORBIDDEN（路由 MFA 之外的服务层复核）。
 * - 与 scheduled 共用 cadence：最近 completed run 未到 hotRecomputeMinutes 时
 *   返回 skipped(cadence)，由路由映射为 429；failed run 允许立即重试。
 * - compute 未注册（BE-002 未接入）时返回 skipped(compute_unavailable)，避免静默空 run。
 * - 真正开跑的 recompute 写 AdminLog（action + 目标 runId 放入 detail）。
 */
export async function requestManualRecompute(
  adminUserId: number,
  deps: Pick<RunRankingDeps, 'db' | 'dbNow' | 'lockFactory'> & { configLoader?: () => Promise<RankingConfig> } = {},
): Promise<ManualRecomputeResult> {
  const db = deps.db ?? prisma

  const user = await db.user.findUnique({
    where: { id: adminUserId },
    select: { id: true, role: true },
  })
  if (!user || user.role !== 'admin') {
    throw forbidden('需要管理员权限')
  }

  const compute = getRankingCompute()
  if (!compute) {
    logger.warn({ adminUserId }, 'manual recompute skipped: ranking compute not registered (T-MERCH-BE-002)')
    return { kind: 'skipped', reason: 'compute_unavailable', adminUserId }
  }

  const configLoader = deps.configLoader ?? loadRankingConfig
  const outcome = await maybeRunRankingRun({
    compute,
    configLoader,
    db: deps.db,
    dbNow: deps.dbNow,
    lockFactory: deps.lockFactory,
  })

  if (outcome.kind === 'completed' || outcome.kind === 'failed') {
    await db.adminLog.create({
      data: {
        adminUserId,
        action: '手动重算排名',
        targetType: 'merchandising_run',
        detail: `runId=${outcome.kind === 'completed' ? outcome.runId : outcome.runId ?? ''}; failureCode=${outcome.kind === 'failed' ? outcome.failureCode : 'none'}`,
      },
    }).catch(err => {
      // 审计写失败不能翻转 recompute 结论（与 admin mail limiter 同一原则）。
      logger.error({ err }, 'failed to write manual recompute admin log')
    })
  }

  return { ...outcome, adminUserId }
}
