import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { HttpError, notFound } from '../../lib/httpError.js'
import { isAccountBanned } from '../accountGovernance/status.js'
import { commandInTx, governanceConflict, writeGovernanceAudit } from '../governance/common.js'

export const PERMISSIONS = [
  'users.read',
  'users.ban',
  'points.read',
  'points.adjust',
  'merchants.read',
  'merchants.review',
  'merchants.suspend',
  'catalog.read',
  'catalog.write',
  'inventory.manage',
  'orders.read',
  'orders.delivery.read',
  'orders.resolve',
  'orders.after_sales.execute',
  'settlements.read',
  'settlements.execute',
  'payments.read',
  'payments.refunds.review',
  'payments.disputes.resolve',
  'audit.read',
  'audit.details.read',
  'exports.create',
  'wallet.integrity.read',
  'settings.manage',
  'admin.permissions.manage',
  'marketing.read',
  'marketing.write',
  'announcements.read',
  'announcements.write',
  'files.manage',
  'backups.manage',
  'ai.manage',
  'videos.read',
  'videos.manage',
] as const
export type AdminPermission = (typeof PERMISSIONS)[number]
export async function authorization(userId: number, db: Prisma.TransactionClient = prisma) {
  const [user, auth, grants] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { role: true } }),
    db.adminAuthorization.findUnique({ where: { userId } }),
    db.adminPermissionGrant.findMany({
      where: { userId, revokedAt: null },
      select: { permissionCode: true },
    }),
  ])
  if (!user || user.role !== 'admin' || !auth || (await isAccountBanned(userId, db))) return null
  return {
    ...auth,
    permissions:
      auth.tier === 'super'
        ? [...PERMISSIONS]
        : grants
            .map((g) => g.permissionCode)
            .filter((p): p is AdminPermission => (PERMISSIONS as readonly string[]).includes(p)),
  }
}
export async function assertPermission(
  userId: number,
  permission: AdminPermission,
  db: Prisma.TransactionClient = prisma,
) {
  const auth = await authorization(userId, db)
  if (!auth?.permissions.includes(permission))
    throw new HttpError(403, 'PERMISSION_DENIED', '没有执行此操作的权限')
  return auth
}
export async function setAuthorization(
  actor: number,
  target: number,
  key: string,
  input: {
    tier: 'super' | 'operator'
    expectedVersion: number
    permissions: AdminPermission[]
    reason: string
  },
) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('admin-authorizations', 0))`
    const actorAuth = await assertPermission(actor, 'admin.permissions.manage', tx)
    if (actorAuth.tier !== 'super')
      throw new HttpError(403, 'PERMISSION_DENIED', '仅超级管理员可以授权')
    return commandInTx(tx, actor, 'authorization', key, { target, ...input }, async () => {
      const user = await tx.user.findUnique({ where: { id: target }, select: { role: true } })
      if (!user || user.role !== 'admin') throw notFound('管理员不存在')
      const previous = await tx.adminAuthorization.findUnique({ where: { userId: target } })
      if ((previous?.version ?? 0) !== input.expectedVersion)
        throw governanceConflict('STATE_CONFLICT', '权限版本已变化')
      if (previous?.tier === 'super' && input.tier !== 'super') {
        const other = await tx.adminAuthorization.count({
          where: {
            userId: { not: target },
            tier: 'super',
            user: { role: 'admin', ...activeUserFilter() },
          },
        })
        if (!other) throw governanceConflict('STATE_CONFLICT', '不能移除最后一名有效超级管理员')
      }
      await tx.adminPermissionGrant.updateMany({
        where: { userId: target, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      if (input.tier === 'operator')
        await tx.adminPermissionGrant.createMany({
          data: [...new Set(input.permissions)].map((permissionCode) => ({
            userId: target,
            permissionCode,
            grantedBy: actor,
            reason: input.reason,
          })),
        })
      await tx.adminAuthorization.upsert({
        where: { userId: target },
        create: { userId: target, tier: input.tier, version: 1 },
        update: { tier: input.tier, version: { increment: 1 } },
      })
      await writeGovernanceAudit(tx, actor, 'admin.authorization.changed', 'user', target, {
        reason: input.reason,
        versionAfter: (previous?.version ?? 0) + 1,
      })
      return (await authorization(target, tx))!
    })
  })
}
import { activeUserWhere as activeUserFilter } from '../accountGovernance/status.js'
