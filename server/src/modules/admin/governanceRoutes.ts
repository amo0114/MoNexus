import '../governance/metrics.js'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { HttpError, notFound } from '../../lib/httpError.js'
import {
  authorization,
  assertPermission,
  setAuthorization,
  PERMISSIONS,
} from '../adminAuthorization/service.js'
import { getRefundReview, reviewRefund, reviewInput } from '../recharge/refundReview.js'
import { merchantApplication, decideMerchant } from '../merchantGovernance/lifecycle.js'
import { createBan, releaseBan } from '../accountGovernance/service.js'
import { userDetail, userSection } from './userQueries.js'
import { auditDetail } from './auditDetail.js'
import { mountTraceRoutes } from '../catalog/traceRoutes.js'
import {
  createExport,
  listExports,
  getExport,
  downloadExport,
  exportInput,
  EXPORT_LIMITS,
} from '../adminExports/service.js'
import {
  listIntegrityRuns,
  listIntegrityIssues,
  recheckIntegrityIssue,
} from '../wallet/integrity.js'
import { cursorQuery, parseRequestKey, reasonInput } from '../governance/common.js'

const id = z.coerce.number().int().positive().max(2147483647)
const uuid = z.string().uuid()
export const decisionInput = reasonInput
  .extend({
    expectedLifecycleVersion: z.number().int().nonnegative(),
    applicationVersion: z.number().int().positive(),
    evidenceRef: z.string().max(500).nullable().optional(),
  })
  .strict()
const key = (r: Request) => parseRequestKey(r.header('Idempotency-Key'))
const handler =
  (f: (r: Request) => Promise<unknown>, status = 200) =>
  (r: Request, s: Response, n: NextFunction) => {
    f(r)
      .then((value) => s.status(status).json(value))
      .catch(n)
  }
export const governanceAdminRoutes = Router()
const router = governanceAdminRoutes
// This router is mounted only after the common admin + MFA + route-permission guards.
router.get(
  '/capabilities',
  handler(async (r) => {
    const auth = (await authorization(r.user!.userId))!
    return {
      contractVersion: 'governance-v1',
      permissions: auth.permissions,
      features: {
        refundReview: true,
        merchantLifecycle: true,
        accountBans: true,
        userDetails: true,
        inventoryTraceability: true,
        exports: true,
        walletIntegrity: true,
      },
      limits: {
        pageSize: 100,
        exportRows: EXPORT_LIMITS.rows,
        exportBytes: EXPORT_LIMITS.bytes,
        exportRetentionSeconds: EXPORT_LIMITS.retentionSeconds,
      },
    }
  }),
)
router.get(
  '/recharge/refunds/:id',
  handler((r) => getRefundReview(r.user!.userId, uuid.parse(r.params.id))),
)
router.post(
  '/recharge/refunds/:id/review',
  handler((r) =>
    reviewRefund(r.user!.userId, uuid.parse(r.params.id), key(r), reviewInput.parse(r.body)),
  ),
)
router.get(
  '/merchants/:id/history',
  handler(async (r) => {
    const auth = await assertPermission(r.user!.userId, 'merchants.read')
    const m = await prisma.merchant.findUnique({
      where: { id: id.parse(r.params.id) },
      select: { userId: true },
    })
    if (!m) throw notFound('商家不存在')
    const dto = await merchantApplication(m.userId, prisma, true)
    dto.allowedActions = dto.allowedActions.filter((a) =>
      auth.permissions.includes(
        a === 'suspend' || a === 'restore' ? 'merchants.suspend' : 'merchants.review',
      ),
    )
    return dto
  }),
)
for (const action of ['approve', 'reject', 'suspend', 'restore'] as const) {
  const method = action === 'restore' ? 'post' : 'put'
  router[method](`/merchants/:id/${action}`, async (r, s, n) => {
    // Keep legacy handlers and response shape for old clients; new requests are versioned.
    if (action !== 'restore' && r.body?.expectedLifecycleVersion === undefined) return n()
    try {
      s.json(
        await decideMerchant(
          r.user!.userId,
          id.parse(r.params.id),
          action,
          decisionInput.parse(r.body),
          key(r),
        ),
      )
    } catch (e) {
      n(e)
    }
  })
}
router.get(
  '/users/:id',
  handler((r) => userDetail(r.user!.userId, id.parse(r.params.id))),
)
for (const section of [
  'orders',
  'point-logs',
  'sessions',
  'referrals',
  'security-events',
  'audit',
  'bans',
])
  router.get(
    `/users/:id/${section}`,
    handler((r) =>
      userSection(r.user!.userId, id.parse(r.params.id), section, cursorQuery.parse(r.query)),
    ),
  )
router.post(
  '/users/:id/bans',
  handler(
    (r) =>
      createBan(
        r.user!.userId,
        id.parse(r.params.id),
        key(r),
        z
          .object({
            reasonCode: z.string().trim().min(1).max(80),
            reason: z.string().trim().min(1).max(1000),
            expiresAt: z.string().datetime({ offset: true }).nullable(),
          })
          .strict()
          .parse(r.body),
      ),
    201,
  ),
)
router.post(
  '/users/:id/bans/:banId/release',
  handler((r) =>
    releaseBan(
      r.user!.userId,
      id.parse(r.params.id),
      uuid.parse(r.params.banId),
      key(r),
      z
        .object({
          expectedVersion: z.number().int().nonnegative(),
          reason: z.string().trim().min(1).max(1000),
        })
        .strict()
        .parse(r.body),
    ),
  ),
)
router.get(
  '/audit/:id',
  handler((r) => auditDetail(r.user!.userId, id.parse(r.params.id))),
)
router.get(
  '/authorizations/:userId',
  handler(async (r) => {
    const actor = await assertPermission(r.user!.userId, 'admin.permissions.manage')
    if (actor.tier !== 'super')
      throw new HttpError(403, 'PERMISSION_DENIED', '仅超级管理员可以查看授权')
    const target = id.parse(r.params.userId)
    const u = await prisma.user.findUnique({ where: { id: target }, select: { role: true } })
    if (u?.role !== 'admin') throw notFound('管理员不存在')
    const current = await authorization(target)
    if (!current) throw notFound('管理员尚未配置授权')
    return current
  }),
)
router.put(
  '/authorizations/:userId',
  handler((r) =>
    setAuthorization(
      r.user!.userId,
      id.parse(r.params.userId),
      key(r),
      z
        .object({
          tier: z.enum(['super', 'operator']),
          expectedVersion: z.number().int().nonnegative(),
          permissions: z.array(z.enum(PERMISSIONS)),
          reason: z.string().trim().min(1).max(1000),
        })
        .strict()
        .parse(r.body),
    ),
  ),
)
mountTraceRoutes(router, true)
router.post(
  '/exports',
  handler((r) => createExport(r.user!, key(r), exportInput.parse(r.body)), 202),
)
router.get(
  '/exports',
  handler((r) => listExports(r.user!.userId, cursorQuery.parse(r.query))),
)
router.get(
  '/exports/:id',
  handler((r) => getExport(r.user!.userId, uuid.parse(r.params.id))),
)
router.post(
  '/exports/:id/download',
  handler((r) => downloadExport(r.user!.userId, uuid.parse(r.params.id))),
)
router.get(
  '/wallet-integrity/runs',
  handler((r) => listIntegrityRuns(r.user!.userId, cursorQuery.parse(r.query))),
)
router.get(
  '/wallet-integrity/issues',
  handler((r) =>
    listIntegrityIssues(
      r.user!.userId,
      cursorQuery.extend({ status: z.enum(['open', 'resolved']).optional() }).parse(r.query),
    ),
  ),
)
router.post(
  '/wallet-integrity/issues/:id/recheck',
  handler((r) =>
    recheckIntegrityIssue(
      r.user!.userId,
      uuid.parse(r.params.id),
      key(r),
      z
        .object({ note: z.string().trim().max(1000).optional() })
        .strict()
        .parse(r.body).note,
    ),
  ),
)
