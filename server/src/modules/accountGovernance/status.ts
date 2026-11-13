import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'

export type AccountStatus = 'active' | 'banned'
export function effectiveBanWhere(now = new Date()): Prisma.AccountBanWhereInput {
  return { releasedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }
}
export function activeUserWhere(now = new Date()): Prisma.UserWhereInput {
  return {
    AND: [
      { NOT: { accountBans: { some: effectiveBanWhere(now) } } },
      // Legacy bans remain effective until a structured record has been observed.
      {
        OR: [
          { status: { in: ['active', '正常'] } },
          { status: { in: ['banned', '已封禁'] }, accountBans: { some: {} } },
        ],
      },
    ],
  }
}
export async function accountStatus(
  userId: number,
  db: Pick<Prisma.TransactionClient, 'user' | 'accountBan'> = prisma,
): Promise<AccountStatus> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      status: true,
      accountBans: { where: { releasedAt: null }, select: { expiresAt: true } },
    },
  })
  if (!user) return 'banned'
  if (user.accountBans.some((b) => b.expiresAt === null || b.expiresAt.getTime() > Date.now()))
    return 'banned'
  if (user.status === 'active' || user.status === '正常') return 'active'
  if (!['banned', '已封禁'].includes(user.status)) return 'banned'
  // An expired, unreleased ban must stop blocking even if the projection is stale.
  if (user.accountBans.length > 0) return 'active'
  const historical = await db.accountBan.count({ where: { userId } })
  return historical > 0 ? 'active' : 'banned'
}
export async function isAccountBanned(
  userId: number,
  db: Pick<Prisma.TransactionClient, 'user' | 'accountBan'> = prisma,
) {
  return (await accountStatus(userId, db)) === 'banned'
}
export function legacyStatus(status: AccountStatus) {
  return status === 'banned' ? '已封禁' : '正常'
}
