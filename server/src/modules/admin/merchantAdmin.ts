import { decideMerchant } from '../merchantGovernance/lifecycle.js'
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

export async function approveMerchant(actor: number, id: number) {
  await decideMerchant(actor, id, 'approve', { reasonCode: 'approved', note: '审核通过' })
  return prisma.merchant.findUniqueOrThrow({where:{id}})
}
export async function rejectMerchant(actor: number, id: number, reason: string) {
  if (!reason?.trim() || reason.trim().length < 2 || reason.length > 500) throw badRequest('拒绝理由需要 2–500 个字符')
  await decideMerchant(actor, id, 'reject', { reasonCode: 'rejected', note: reason.trim() })
  return prisma.merchant.findUniqueOrThrow({where:{id}})
}
export async function suspendMerchant(actor: number, id: number) {
  await decideMerchant(actor, id, 'suspend', { reasonCode: 'suspended', note: '管理员停用' })
  return prisma.merchant.findUniqueOrThrow({where:{id}})
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

  return prisma.$transaction(async tx => {
  const updated = await tx.merchant.update({
    where: { id: merchantId },
    data: { commissionRate },
  })

  await tx.adminLog.create({
    data: {
      adminUserId,
      action: '调整抽成比例',
      targetType: 'merchant',
      targetId: merchantId,
      detail: `抽成比例调整为 ${commissionRate}`,
    },
  })

  return updated
  })
}
