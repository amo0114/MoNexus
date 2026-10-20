import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'
import { revokeAllUserRefreshTokens } from '../auth/service.js'
import { lockUserRefreshSessionMutations } from '../auth/sessionService.js'

// ---- Merchant Management ----

export async function listMerchants(status?: string, q?: string, page = 1, pageSize = 20) {
  const where: Prisma.MerchantWhereInput = {}
  if (status) where.status = status
  if (q) where.name = { contains: q, mode: 'insensitive' }

  const [total, items] = await prisma.$transaction(
    [
      prisma.merchant.count({ where }),
      prisma.merchant.findMany({
        where,
        include: { user: { select: { id: true, email: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ],
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    },
  )

  return { items, total, page, pageSize }
}

export async function getMerchantDetail(id: number) {
  const merchant = await prisma.merchant.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, email: true } },
      products: { select: { id: true, name: true, status: true } },
      _count: { select: { orders: true } },
    },
  })
  if (!merchant) throw notFound('商家不存在')
  return merchant
}

export async function approveMerchant(adminUserId: number, merchantId: number) {
  return prisma.$transaction(async tx => {
    const merchant = await tx.merchant.findUnique({ where: { id: merchantId } })
    if (!merchant) throw notFound('商家不存在')
    if (merchant.status !== 'pending') throw badRequest('只能审核待审核的商家')

    await lockUserRefreshSessionMutations(tx, merchant.userId)

    const updated = await tx.merchant.update({
      where: { id: merchantId },
      data: { status: 'active', approvedAt: new Date(), approvedBy: adminUserId },
    })

    await tx.user.update({
      where: { id: merchant.userId },
      data: { role: 'merchant' },
    })

    await revokeAllUserRefreshTokens(merchant.userId, tx)

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '审核通过商家',
        targetType: 'merchant',
        targetId: merchantId,
        detail: `商家 ${merchant.name} 审核通过`,
      },
    })

    return updated
  })
}

export async function rejectMerchant(adminUserId: number, merchantId: number, reason: string) {
  const trimmedReason = (reason ?? '').trim()
  if (!trimmedReason || trimmedReason.length < 2) {
    throw badRequest('拒绝理由至少 2 个字符')
  }
  if (trimmedReason.length > 500) {
    throw badRequest('拒绝理由最多 500 个字符')
  }

  return prisma.$transaction(async tx => {
    const merchant = await tx.merchant.findUnique({ where: { id: merchantId } })
    if (!merchant) throw notFound('商家不存在')
    if (merchant.status !== 'pending') throw badRequest('只能审核待审核的商家')

    const updated = await tx.merchant.update({
      where: { id: merchantId },
      data: { status: 'rejected' },
    })

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '拒绝商家入驻',
        targetType: 'merchant',
        targetId: merchantId,
        detail: `拒绝原因: ${trimmedReason}`,
      },
    })

    return updated
  })
}

export async function suspendMerchant(adminUserId: number, merchantId: number) {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } })
  if (!merchant) throw notFound('商家不存在')
  if (merchant.status !== 'active') throw badRequest('只能停用已激活的商家')

  return prisma.$transaction(async tx => {
    await lockUserRefreshSessionMutations(tx, merchant.userId)

    const updated = await tx.merchant.update({
      where: { id: merchantId },
      data: { status: 'suspended' },
    })

    await tx.user.update({
      where: { id: merchant.userId },
      data: { role: 'user' },
    })

    await revokeAllUserRefreshTokens(merchant.userId, tx)

    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '停用商家',
        targetType: 'merchant',
        targetId: merchantId,
        detail: `商家 ${merchant.name} 已停用`,
      },
    })

    return updated
  })
}

/** SPEC-MERCHANT-AGENT-001 pilot allowlist; only changes who may use the operations agent. */
export async function setMerchantAgentPilot(adminUserId: number, merchantId: number, enabled: boolean) {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } })
  if (!merchant) throw notFound('商家不存在')
  return prisma.$transaction(async tx => {
    const updated = await tx.merchant.update({ where: { id: merchantId }, data: { agentPilot: enabled } })
    await tx.adminLog.create({ data: {
      adminUserId, action: enabled ? '加入经营助手试点' : '移出经营助手试点', targetType: 'merchant', targetId: merchantId,
      detail: `商家 ${merchant.name}${enabled ? '加入' : '移出'}经营助手试点`,
    } })
    return updated
  })
}

export async function updateCommission(adminUserId: number, merchantId: number, commissionRate: number) {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } })
  if (!merchant) throw notFound('商家不存在')

  const updated = await prisma.merchant.update({
    where: { id: merchantId },
    data: { commissionRate },
  })

  await prisma.adminLog.create({
    data: {
      adminUserId,
      action: '调整抽成比例',
      targetType: 'merchant',
      targetId: merchantId,
      detail: `抽成比例调整为 ${commissionRate}`,
    },
  })

  return updated
}
