import { resolvePagination } from '../../lib/pagination.js'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound, HttpError } from '../../lib/httpError.js'
import { invalidate as invalidateUserStatusCache } from '../../lib/userStatusCache.js'
import { revokeAllUserRefreshTokens } from '../auth/service.js'
import { lockUserRefreshSessionMutations } from '../auth/sessionService.js'
import { creditAvailablePoints, debitAvailablePoints } from '../orders/accounting.js'
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

export async function adjustUserPoints(
  adminUserId: number,
  targetUserId: number,
  type: 'add' | 'deduct',
  amount: number,
  reason: string
) {
  return prisma.$transaction(async tx => {
    const account = await tx.pointAccount.findUnique({ where: { userId: targetUserId } })
    if (!account) throw notFound('目标用户积分账户不存在')

    let newBalance: number
    if (type === 'add') {
      newBalance = await creditAvailablePoints(tx, targetUserId, amount)
    } else {
      try {
        newBalance = await debitAvailablePoints(tx, targetUserId, amount)
      } catch (error) {
        if (error instanceof HttpError && error.code === 'POINT_INSUFFICIENT') {
          throw badRequest('扣除数量不能大于用户当前余额', 'POINT_INSUFFICIENT')
        }
        throw error
      }
    }

    await tx.pointLog.create({
      data: {
        userId: targetUserId,
        type: type === 'add' ? 'in' : 'out',
        amount,
        balanceAfter: newBalance,
        reason: `后台调整: ${reason}`,
      },
    })

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: `${type === 'add' ? '增加' : '扣除'}积分`,
        targetType: 'user',
        targetId: targetUserId,
        detail: `${type === 'add' ? '+' : '-'}${amount}, 原因: ${reason}`,
      },
    })

    return { newBalance }
  })
}

export async function banUser(adminUserId: number, targetUserId: number, reason: string) {
  const updated = await prisma.$transaction(async tx => {
    const target = await tx.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true, role: true, status: true },
    })
    if (!target) throw notFound('用户不存在')
    if (target.id === adminUserId) throw badRequest('不能封禁自己的账号')
    if (target.role === 'admin') throw badRequest('不能封禁管理员账号')

    await lockUserRefreshSessionMutations(tx, target.id)

    const updated = await tx.user.update({
      where: { id: target.id },
      data: { status: '已封禁' },
      select: { id: true, email: true, role: true, status: true },
    })

    await revokeAllUserRefreshTokens(target.id, tx)

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '封禁用户',
        targetType: 'user',
        targetId: target.id,
        detail: `用户 ${target.email} 已封禁，原因: ${reason}`,
      },
    })

    return updated
  })

  invalidateUserStatusCache(targetUserId)
  return updated
}

export async function unbanUser(adminUserId: number, targetUserId: number) {
  const updated = await prisma.$transaction(async tx => {
    const target = await tx.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true, role: true, status: true },
    })
    if (!target) throw notFound('用户不存在')

    const updated = await tx.user.update({
      where: { id: target.id },
      data: { status: '正常' },
      select: { id: true, email: true, role: true, status: true },
    })

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '解封用户',
        targetType: 'user',
        targetId: target.id,
        detail: `用户 ${target.email} 已解封`,
      },
    })

    return updated
  })

  invalidateUserStatusCache(targetUserId)
  return updated
}
