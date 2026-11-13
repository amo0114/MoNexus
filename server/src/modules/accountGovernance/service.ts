import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'
import { invalidate } from '../../lib/userStatusCache.js'
import {
  lockUserRefreshSessionMutations,
  revokeAllUserRefreshTokens,
} from '../auth/sessionService.js'
import { commandInTx, governanceConflict, writeGovernanceAudit } from '../governance/common.js'
import { assertPermission } from '../adminAuthorization/service.js'
import { effectiveBanWhere } from './status.js'

export function serializeBan<T extends { expiresAt: Date | null; releasedAt: Date | null }>(
  ban: T,
) {
  return {
    ...ban,
    effective: !ban.releasedAt && (!ban.expiresAt || ban.expiresAt.getTime() > Date.now()),
  }
}
export async function createBan(
  actor: number,
  userId: number,
  key: string,
  input: { reasonCode: string; reason: string; expiresAt: string | null },
) {
  const result = await prisma.$transaction(async (tx) => {
    await assertPermission(actor, 'users.ban', tx)
    await lockUserRefreshSessionMutations(tx, userId)
    return commandInTx(tx, actor, 'account.ban', key, { userId, ...input }, async () => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { role: true } })
      if (!user) throw notFound('用户不存在')
      if (userId === actor || user.role === 'admin') throw badRequest('不能封禁自己或管理员账号')
      const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null
      if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()))
        throw badRequest('封禁到期时间必须晚于现在')
      if (await tx.accountBan.findFirst({ where: { userId, ...effectiveBanWhere() } }))
        throw governanceConflict('STATE_CONFLICT', '用户已经处于封禁状态')
      await tx.accountBan.updateMany({
        where: { userId, releasedAt: null, expiresAt: { lte: new Date() } },
        data: { releasedAt: new Date(), releaseReason: 'expired', version: { increment: 1 } },
      })
      const ban = await tx.accountBan.create({
        data: {
          userId,
          reasonCode: input.reasonCode,
          reason: input.reason,
          startsAt: new Date(),
          expiresAt,
          createdByUserId: actor,
        },
      })
      await tx.user.update({ where: { id: userId }, data: { status: 'banned' } })
      await revokeAllUserRefreshTokens(userId, tx)
      await writeGovernanceAudit(tx, actor, 'account.ban.created', 'user', userId, {
        reasonCode: input.reasonCode,
        reason: input.reason,
      })
      return serializeBan(ban)
    })
  })
  invalidate(userId)
  return result
}
export async function releaseBan(
  actor: number,
  userId: number,
  banId: string,
  key: string,
  input: { expectedVersion: number; reason: string },
) {
  const result = await prisma.$transaction(async (tx) => {
    await assertPermission(actor, 'users.ban', tx)
    await lockUserRefreshSessionMutations(tx, userId)
    return commandInTx(
      tx,
      actor,
      'account.ban.release',
      key,
      { userId, banId, ...input },
      async () => {
        const ban = await tx.accountBan.findFirst({ where: { id: banId, userId } })
        if (!ban) throw notFound('封禁记录不存在')
        if (ban.version !== input.expectedVersion || ban.releasedAt)
          throw governanceConflict('STATE_CONFLICT', '封禁记录已变化')
        const updated = await tx.accountBan.update({
          where: { id: banId, version: input.expectedVersion, releasedAt: null },
          data: {
            releasedAt: new Date(),
            releasedByUserId: actor,
            releaseReason: input.reason,
            version: { increment: 1 },
          },
        })
        await tx.user.update({ where: { id: userId }, data: { status: 'active' } })
        await revokeAllUserRefreshTokens(userId, tx)
        await writeGovernanceAudit(tx, actor, 'account.ban.released', 'user', userId, {
          reason: input.reason,
        })
        return serializeBan(updated)
      },
    )
  })
  invalidate(userId)
  return result
}

/** Projection housekeeping only; accountStatus already makes expiry effective without this worker. */
export async function releaseExpiredBans() {
  const candidates = await prisma.accountBan.findMany({
    where: { releasedAt: null, expiresAt: { lte: new Date() } },
    select: { userId: true, id: true },
    take: 100,
  })
  for (const item of candidates) {
    await prisma.$transaction(async (tx) => {
      await lockUserRefreshSessionMutations(tx, item.userId)
      const closed = await tx.accountBan.updateMany({
        where: { id: item.id, releasedAt: null, expiresAt: { lte: new Date() } },
        data: { releasedAt: new Date(), releaseReason: 'expired', version: { increment: 1 } },
      })
      if (
        closed.count &&
        !(await tx.accountBan.findFirst({ where: { userId: item.userId, ...effectiveBanWhere() } }))
      )
        await tx.user.update({ where: { id: item.userId }, data: { status: 'active' } })
    })
    invalidate(item.userId)
  }
  return candidates.length
}
