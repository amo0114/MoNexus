// T-MERCH-BE-002 — Public merchandising projection adapter (SPEC-MERCH-001 §6.3/§9,
// D-MERCH-07/08/20, AC-MERCH-007/008, CHK-HOT-009/010/011, CHK-PERF-003, CHK-SEC-001).
//
// CMI Integration Owner consumes this adapter from the products service; this module
// never touches products service/cache or StorePage. Contract: product IDs + pinned run
// → `merchandising` projection block + run-pinned cursor rules.
//
// Frozen semantics:
//   - public organic query 固定一个 completed run；排序 `isHot DESC,
//     effectiveOrderCount DESC, productId DESC`（D-MERCH-08）；
//   - cursor 钉住 rankingRunId；run 仍保留则下一页继续同 run（即使已有更新的
//     completed run，AC-MERCH-007）；run 被 retention 清理或 filter 不匹配 →
//     409 PRODUCT_CURSOR_EXPIRED，前端清页重新从第一页取（D-MERCH-07）；
//   - 无 completed run → hot block 为 null、排序退化为 id DESC，绝不读 legacy
//     isHot（D-MERCH-01 / AC-MERCH-008 / CHK-HOT-009）；
//   - decorate 批量、有界（≤1000 商品，单条 IN 查询，无 N+1；CHK-PERF-003）；
//   - public DTO 只暴露 Spec §9 字段：hot 只含本商品 effectiveOrders/rank/windowDays/
//     computedAt；platformOwned 由 merchantId=null 派生；platformPick/merchantPartner
//     由 BE-005 增量填充（当前恒 null）。绝不泄露内部字段（MERCH-015 / CHK-SEC-001）。

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { HttpError } from '../../lib/httpError.js'
import type { ErrorCode } from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'
import { RUN_STATUS } from './constants.js'
import { findLatestCompletedRun, type AnyDb } from './ranking/repository.js'
import type { MerchandisingProjection } from './contracts.js'

/** cursor 版本。契约变更（字段/排序）必须 bump 并使旧 cursor 一律 409。 */
export const PROJECTION_CURSOR_VERSION = 1

/** 冻结的 organic cursor 字段（D-MERCH-07：v/runId/isHot/effectiveOrderCount/productId/filterHash）。 */
export interface OrganicCursorPayload {
  v: 1
  /** 钉住的 completed run；null = 无 completed run 的 no-run fallback 状态。 */
  runId: string | null
  isHot: boolean
  effectiveOrderCount: number
  productId: number
  filterHash: string
}

/** decorate 需要的 run 形状（只读三字段，不含任何订单数据）。 */
export interface ProjectionRun {
  id: string
  completedAt: Date
  windowDays: number
}

/** decorate 输入商品的最小字段（只读 id 与 merchantId，绝不读 isHot/sales）。 */
export interface ProjectionInputProduct {
  id: number
  merchantId: number | null
}

/** decorate 输出：商品 + `merchandising` projection 块（Spec §9）。 */
export interface DecoratedProjectionProduct {
  id: number
  merchandising: MerchandisingProjection
}

/** 单次 decorate 的商品数上限：保证快照 IN 查询有界（1000 products 查询有界）。 */
export const PROJECTION_BATCH_LIMIT = 1000

/**
 * 冻结的 organic 排序（D-MERCH-08）：run 内按快照 `isHot DESC,
 * effectiveOrderCount DESC, productId DESC`。no-run fallback 用 `NO_RUN_ORDER`
 * （hot=false/count=0 → 纯 `productId DESC`）。
 */
export const ORGANIC_RUN_ORDER = [
  { isHot: 'desc' },
  { effectiveOrderCount: 'desc' },
  { productId: 'desc' },
] as const
export const NO_RUN_ORDER = [{ id: 'desc' }] as const

/**
 * 冻结的 projection 错误 code。两个都是 merchandising adapter 的错误码（超集于
 * 共享 ErrorCode union，沿用 catalog/resolver 的 `code as ErrorCode` 先例）；
 * 它们仍走标准 HttpError，error middleware 可直接序列化。若未来需要把 code 并入
 * 共享 union，由共享文件 Owner 提升。
 */
export const PROJECTION_ERROR_CODES = {
  EXPIRED: 'PRODUCT_CURSOR_EXPIRED',
  INVALID: 'PRODUCT_CURSOR_INVALID',
} as const
type ProjectionErrorCode = (typeof PROJECTION_ERROR_CODES)[keyof typeof PROJECTION_ERROR_CODES]

function projectionError(status: number, code: ProjectionErrorCode, message: string): HttpError {
  return new HttpError(status, code as ErrorCode, message)
}

/** 409：cursor 钉住的 run 已清理 / 状态漂移 / filter 不匹配 → 前端清页重启分页。 */
export function cursorExpired(message = '商品列表已更新，请重新从第一页开始'): HttpError {
  return projectionError(409, PROJECTION_ERROR_CODES.EXPIRED, message)
}

/** 400：cursor 结构非法（不是可识别的 organic cursor）。 */
export function cursorInvalid(message = '商品分页游标无效'): HttpError {
  return projectionError(400, PROJECTION_ERROR_CODES.INVALID, message)
}

/** 递归排序 key 的规范化（数组保序，undefined 剔除），供 filterHash 使用。 */
export function canonicalizeFilter(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeFilter)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const v = source[key]
      if (v !== undefined) out[key] = canonicalizeFilter(v)
    }
    return out
  }
  return value
}

/**
 * filter 的规范 SHA-256（hex）。cursor 携带 filterHash；请求 filter 与 cursor 不符 →
 * 409 PRODUCT_CURSOR_EXPIRED（spec §6.3 "filter不匹配…返回409"）。纯函数，无 DB。
 */
export function computeFilterHash(filter: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(canonicalizeFilter(filter))).digest('hex')
}

/** cursor 的 filter 与当前请求 filter 一致性校验；不符抛 409。 */
export function assertCursorFilterMatches(
  cursor: OrganicCursorPayload,
  filter: Record<string, unknown>,
): void {
  if (cursor.filterHash !== computeFilterHash(filter)) throw cursorExpired()
}

export function encodeOrganicCursor(payload: OrganicCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function isValidCursorPayload(value: unknown): value is OrganicCursorPayload {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    v.v === PROJECTION_CURSOR_VERSION
    && (v.runId === null || typeof v.runId === 'string')
    && typeof v.isHot === 'boolean'
    && typeof v.effectiveOrderCount === 'number'
    && Number.isInteger(v.effectiveOrderCount)
    && v.effectiveOrderCount >= 0
    && typeof v.productId === 'number'
    && Number.isInteger(v.productId)
    && v.productId > 0
    && typeof v.filterHash === 'string'
    && /^[0-9a-f]{64}$/.test(v.filterHash)
  )
}

/** 解析 cursor。结构非法 → 400 PRODUCT_CURSOR_INVALID；可识别的旧/未知版本
 * （v 是数字但不等于当前版本）→ 409 PRODUCT_CURSOR_EXPIRED——契约已变更，
 * 前端必须清页重启分页而非混用新旧页（D-MERCH-07 / SPEC-MERCH-001 §6.3）。
 */
export function decodeOrganicCursor(raw: string): OrganicCursorPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
  } catch {
    throw cursorInvalid()
  }
  if (parsed === null || typeof parsed !== 'object') throw cursorInvalid()
  const version = (parsed as Record<string, unknown>).v
  if (version !== undefined && typeof version === 'number' && version !== PROJECTION_CURSOR_VERSION) {
    throw cursorExpired()
  }
  if (!isValidCursorPayload(parsed)) throw cursorInvalid()
  return parsed
}

/**
 * keyset 谓词：钉住的 run 内按 (isHot, effectiveOrderCount, productId) 严格排序
 * （isHot DESC, count DESC, id DESC）。与 ORGANIC_RUN_ORDER 配套，供 CMI 接线
 * 在 snapshot 查询上做 keyset 分页。调用方还需叠加 `runId: <pinned run id>`。
 */
export function buildSnapshotKeysetWhere(
  cursor: OrganicCursorPayload,
): Prisma.ProductMerchandisingSnapshotWhereInput {
  if (cursor.runId === null) {
    // no-run 状态走 Product fallback 路径（buildFallbackKeysetWhere），这里不可能到达。
    throw cursorExpired()
  }
  if (cursor.isHot) {
    return {
      OR: [
        { isHot: false },
        { isHot: true, effectiveOrderCount: { lt: cursor.effectiveOrderCount } },
        { isHot: true, effectiveOrderCount: cursor.effectiveOrderCount, productId: { lt: cursor.productId } },
      ],
    }
  }
  return {
    OR: [
      { isHot: false, effectiveOrderCount: { lt: cursor.effectiveOrderCount } },
      { isHot: false, effectiveOrderCount: cursor.effectiveOrderCount, productId: { lt: cursor.productId } },
    ],
  }
}

/**
 * no-run fallback 的 keyset 谓词：所有商品 hot=false/count=0 → 纯 `id DESC`
 * （hot=false/count=0 恒成立，无需再写 isHot/count 分支）。调用方叠加基础
 * filter（status='active' 等）。
 */
export function buildFallbackKeysetWhere(cursor: OrganicCursorPayload): Prisma.ProductWhereInput {
  return { id: { lt: cursor.productId } }
}

export type PinnedRunResolution =
  | { mode: 'run'; run: ProjectionRun }
  | { mode: 'none' }

/**
 * 解析请求要钉住的 run（AC-MERCH-007 / CHK-HOT-010）：
 * - 无 cursor（第一页）→ 用最新 completed；无 completed → no-run fallback；
 * - cursor.runId=null（no-run 状态）→ 仍无 completed 才继续，否则 409（状态漂移）；
 * - cursor 钉住 runId → 该 run 仍 completed 则继续（即便已有更新的 run），
 *   已被 retention 清理 → 409。
 * 纯函数（无 DB），DB 取值由 resolveCursorForRequest 负责。
 */
export function resolvePinnedRun(
  cursor: OrganicCursorPayload | null,
  pinnedRun: ProjectionRun | null,
  hasCompletedRun: boolean,
): PinnedRunResolution {
  if (cursor === null) {
    return pinnedRun !== null ? { mode: 'run', run: pinnedRun } : { mode: 'none' }
  }
  if (cursor.runId === null) {
    if (hasCompletedRun) throw cursorExpired()
    return { mode: 'none' }
  }
  if (pinnedRun === null || pinnedRun.id !== cursor.runId) throw cursorExpired()
  return { mode: 'run', run: pinnedRun }
}

/** 按 id 读取钉住的 run（仅 completed；running/failed 永不公开，MERCH-004）。 */
export async function findPinnedRun(runId: string, db: AnyDb = prisma): Promise<ProjectionRun | null> {
  const run = await db.merchandisingRun.findFirst({
    where: { id: runId, status: RUN_STATUS.COMPLETED },
    select: { id: true, completedAt: true, windowDays: true },
  })
  if (run === null) return null
  if (run.completedAt === null) return null // CHECK 保证不可达；防御性兜底
  return { id: run.id, completedAt: run.completedAt, windowDays: run.windowDays }
}

/**
 * 请求级解析（DB 版）：无 cursor → 最新 completed；有 cursor → 校验钉住 run。
 * 返回 pinned run（或 no-run fallback）；cursor 过期一律 409。
 */
export async function resolveCursorForRequest(
  cursor: OrganicCursorPayload | null,
  db: AnyDb = prisma,
): Promise<PinnedRunResolution> {
  if (cursor === null) {
    const latest = await findLatestCompletedRun(db)
    return latest !== null ? { mode: 'run', run: latest } : { mode: 'none' }
  }
  if (cursor.runId === null) {
    const latest = await findLatestCompletedRun(db)
    if (latest !== null) throw cursorExpired()
    return { mode: 'none' }
  }
  const pinnedRun = await findPinnedRun(cursor.runId, db)
  if (pinnedRun === null) throw cursorExpired()
  return { mode: 'run', run: pinnedRun }
}

/** 有界批量读快照：单条 IN 查询（≤1000），无 N+1。 */
async function loadSnapshotsBounded(
  runId: string,
  productIds: number[],
  db: AnyDb,
): Promise<Array<{ productId: number; effectiveOrderCount: number; categoryRank: number; computedAt: Date }>> {
  return db.productMerchandisingSnapshot.findMany({
    where: { runId, productId: { in: productIds } },
    select: { productId: true, effectiveOrderCount: true, categoryRank: true, computedAt: true },
  })
}

/** no-run fallback projection：hot 块整体缺省，绝不读 legacy isHot（AC-MERCH-008）。 */
function buildNoRunProjection(product: ProjectionInputProduct): MerchandisingProjection {
  return {
    rankingRunId: null,
    hot: null,
    platformOwned: product.merchantId === null,
    platformPick: null,
    merchantPartner: null,
  }
}

/** 钉住 run 的 projection：hot 只含本商品指标（Spec §9，CHK-SEC-001）。 */
function buildRunProjection(
  product: ProjectionInputProduct,
  run: ProjectionRun,
  snapshot: { effectiveOrderCount: number; categoryRank: number; computedAt: Date } | null,
): MerchandisingProjection {
  return {
    rankingRunId: run.id,
    hot: snapshot
      ? {
          effectiveOrders: snapshot.effectiveOrderCount,
          rank: snapshot.categoryRank,
          windowDays: run.windowDays,
          computedAt: snapshot.computedAt.toISOString(),
        }
      : null,
    platformOwned: product.merchantId === null,
    platformPick: null, // BE-005 editorial 增量
    merchantPartner: null, // BE-005 entitlement 增量
  }
}

/**
 * 批量 decorate（plan §4.2）：输入商品 ID → 输出 `merchandising` projection。
 * 单次调用有界（≤ PROJECTION_BATCH_LIMIT=1000），快照一次 IN 查询读完，无 N+1。
 * run=null → no-run fallback（hot=null，id DESC 由调用方排序）。
 */
export async function decorateProducts(
  products: ProjectionInputProduct[],
  run: ProjectionRun | null,
  db: AnyDb = prisma,
): Promise<DecoratedProjectionProduct[]> {
  if (products.length === 0) return []
  if (products.length > PROJECTION_BATCH_LIMIT) {
    throw new Error(
      `projection decorate batch ${products.length} exceeds bounded limit ${PROJECTION_BATCH_LIMIT}`,
    )
  }
  if (run === null) {
    return products.map(product => ({ id: product.id, merchandising: buildNoRunProjection(product) }))
  }
  const snapshots = await loadSnapshotsBounded(
    run.id,
    products.map(product => product.id),
    db,
  )
  const byProduct = new Map(snapshots.map(snapshot => [snapshot.productId, snapshot]))
  return products.map(product => ({
    id: product.id,
    merchandising: buildRunProjection(product, run, byProduct.get(product.id) ?? null),
  }))
}
