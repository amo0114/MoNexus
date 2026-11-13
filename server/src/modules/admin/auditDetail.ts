import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { notFound } from '../../lib/httpError.js'
import { assertPermission } from '../adminAuthorization/service.js'
const safe = z
  .object({
    reasonCode: z.string().max(80).optional(),
    reason: z.string().max(1000).optional(),
    note: z.string().max(1000).optional(),
    fromStatus: z.string().max(80).optional(),
    toStatus: z.string().max(80).optional(),
    versionAfter: z.number().int().nonnegative().optional(),
    count: z.number().int().nonnegative().optional(),
  })
  .strip()
// Explicit action registry: unknown producers cannot expose arbitrary JSON via audit details.
const actions = new Set([
  'account.ban.created',
  'account.ban.released',
  'merchant.approve',
  'merchant.reject',
  'merchant.suspend',
  'merchant.restore',
  'admin.authorization.changed',
  'recharge.refund.resume',
  'recharge.refund.reject',
  'inventory.batch.void',
  'export.queued',
  'export.succeeded',
  'wallet.integrity.rechecked',
])
const paymentAttempts = new Set([
  'payment.event.retry',
  'payment.order.reconcile',
  'payment.order.resolve_reconcile',
  'payment.recon_item.review',
  'payment.order.refund',
  'payment.recon.rerun',
])
const attempt = z.object({ operationState: z.literal('attempt') }).strict()
const mailAudit = z
  .object({
    phase: z.enum(['attempt', 'sent', 'failed', 'rejected', 'rate_limited']),
    recipient: z.string().max(320),
    correlationId: z.string().uuid(),
    failure: z.enum(['EAUTH', 'ETIMEDOUT', 'ENOTFOUND', 'UNKNOWN']).optional(),
  })
  .strict()

function operationState(
  row: {
    action: string
    actionCode: string | null
    targetType: string | null
    detailSchemaVersion: number | null
    detailSafe: unknown
    detail: string | null
  },
  committed: boolean,
) {
  // A committed decision is not proof of downstream cash settlement or delivery.
  if (committed) return 'committed' as const
  if (
    row.actionCode &&
    paymentAttempts.has(row.actionCode) &&
    row.detailSchemaVersion === 1 &&
    attempt.safeParse(row.detailSafe).success
  )
    return 'attempt' as const
  // This legacy producer already wrote an explicit, closed phase vocabulary.
  // Parse only its exact envelope; never expose arbitrary legacy detail JSON.
  if (
    row.action === '测试邮件投递' &&
    row.targetType === 'mailDelivery' &&
    row.detail &&
    row.detail.length <= 4096
  ) {
    try {
      const parsed = mailAudit.safeParse(JSON.parse(row.detail))
      if (parsed.success) return parsed.data.phase
    } catch {
      /* Unknown or malformed history stays unknown. */
    }
  }
  return 'unknown' as const
}
export async function auditDetail(actor: number, id: number) {
  await assertPermission(actor, 'audit.details.read')
  const row = await prisma.adminLog.findUnique({ where: { id } })
  if (!row) throw notFound('审计记录不存在')
  const parsed =
    row.actionCode && actions.has(row.actionCode) && row.detailSchemaVersion === 1
      ? safe.safeParse(row.detailSafe)
      : null
  return {
    id: row.id,
    adminId: row.adminUserId,
    action: row.action,
    actionCode: row.actionCode,
    targetType: row.targetType,
    targetId: row.targetId,
    createdAt: row.createdAt,
    detailSchemaVersion: row.detailSchemaVersion,
    detailSafe: parsed?.success ? parsed.data : null,
    detailAvailability: parsed?.success ? 'available' : 'legacy_detail_unavailable',
    operationState: operationState(row, parsed?.success === true),
    requestId: row.requestId,
  }
}
