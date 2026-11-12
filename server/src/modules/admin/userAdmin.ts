import { assertPermission } from '../adminAuthorization/service.js'
import { createBan, releaseBan } from '../accountGovernance/service.js'
import { legacyStatus, accountStatus } from '../accountGovernance/status.js'
import { resolvePagination } from '../../lib/pagination.js'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound, HttpError } from '../../lib/httpError.js'
import { invalidate as invalidateUserStatusCache } from '../../lib/userStatusCache.js'
import { revokeAllUserRefreshTokens } from '../auth/service.js'
import { lockUserRefreshSessionMutations } from '../auth/sessionService.js'
import { accountSources, creditInTx, spendInTx, type WalletContext, type WalletResult } from '../wallet/index.js'
import type { ListUsersQuery } from './schema.js'

export async function listUsers(query: ListUsersQuery = {}) {
  const { page, pageSize } = await resolvePagination(query.page, query.pageSize)
  const where: Prisma.UserWhereInput = {}
  if (query.q) {
    where.OR = [
      { email: { contains: query.q, mode: 'insensitive' } },
      { merchant: { name: { contains: query.q, mode: 'insensitive' } } },
    ]
  }

  const [total, items] = await prisma.$transaction([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
        pointAccount: { select: { balance: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  return { items, total, page, pageSize }
}

/** Current balance by origin; points are not cash and legacy_unknown stays unknown. */
export async function getUserPointSources(userId: number) {
  const account = await prisma.pointAccount.findUnique({ where: { userId }, select: { balance: true, frozenBalance: true } })
  if (!account) throw notFound('积分账户不存在')
  return { ...account, sources: await accountSources(prisma, userId) }
}

export async function adjustUserPoints(
  adminUserId: number,
  targetUserId: number,
  type: 'add' | 'deduct',
  amount: number,
  reason: string,
  idempotencyKey: string,
) {
  // An operator must not mint or move points for their own account.
  if (adminUserId === targetUserId) throw badRequest('不能调整自己的积分')
  return prisma.$transaction(async tx => {
    const account = await tx.pointAccount.findUnique({ where: { userId: targetUserId } })
    if (!account) throw notFound('目标用户积分账户不存在')

    const ctx: WalletContext = {
      // Scoped per operator+target so a timed-out retry replays instead of granting twice.
      operationKey: `admin-adjust:${adminUserId}:${targetUserId}:${idempotencyKey}`,
      userId: targetUserId,
      source: { kind: 'admin_adjustment', id: adminUserId },
      reasonCode: type === 'add' ? 'admin_credit' : 'admin_debit',
      actorUserId: adminUserId,
      // Admin grants keep counting toward growth as before; they are not recharge.
      log: { reason: `后台调整: ${reason}`, growthEligible: type === 'add' },
    }
    let result: WalletResult
    if (type === 'add') {
      result = await creditInTx(tx, ctx, { amount, origin: 'admin_adjustment' })
    } else {
      try {
        result = (await spendInTx(tx, ctx, { amount }))!
      } catch (error) {
        if (error instanceof HttpError && error.code === 'POINT_INSUFFICIENT') {
          throw badRequest('扣除数量不能大于用户当前余额', 'POINT_INSUFFICIENT')
        }
        throw error
      }
    }

    if (result.replayed) return { newBalance: result.balance }

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: `${type === 'add' ? '增加' : '扣除'}积分`,
        targetType: 'user',
        targetId: targetUserId,
        detail: `${type === 'add' ? '+' : '-'}${amount}, 原因: ${reason}`,
      },
    })

    return { newBalance: result.balance }
  })
}

async function legacyUserResult(id: number) {
  const u = await prisma.user.findUniqueOrThrow({where:{id},select:{id:true,email:true,role:true}})
  return {...u,status:legacyStatus(await accountStatus(id))}
}
export async function banUser(actor: number, userId: number, reason: string) {
  const previous = await prisma.accountBan.findFirst({where:{userId},orderBy:{createdAt:'desc'}})
  await createBan(actor,userId,`legacy-ban:${userId}:${previous?.id??'first'}`,{reasonCode:'admin_banned',reason,expiresAt:null})
  return legacyUserResult(userId)
}
export async function unbanUser(actor: number, userId: number) {
  await assertPermission(actor,'users.ban')
  // The compatibility endpoint supplies an explicit adapter reason; new clients must supply their own.
  let ban = await prisma.accountBan.findFirst({where:{userId,releasedAt:null}})
  if(!ban) {
    const user = await prisma.user.findUnique({where:{id:userId},select:{status:true}})
    if(!user)throw notFound('用户不存在')
    if(['banned','已封禁'].includes(user.status)) {
      await prisma.$transaction(async tx=>{
        await lockUserRefreshSessionMutations(tx,userId)
        if(!await tx.accountBan.findFirst({where:{userId,releasedAt:null}}))await tx.accountBan.create({data:{userId,reasonCode:'legacy_unknown',source:'legacy'}})
      })
      ban = await prisma.accountBan.findFirst({where:{userId,releasedAt:null}})
    }
  }
  if(ban)await releaseBan(actor,userId,ban.id,`legacy-unban:${ban.id}`,{expectedVersion:ban.version,reason:'管理员通过旧版兼容接口解封'})
  return legacyUserResult(userId)
}
