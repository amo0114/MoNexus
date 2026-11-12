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
    requestId: row.requestId,
  }
}
