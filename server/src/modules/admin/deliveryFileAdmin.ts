import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'
import type { ListDeliveryFilesQuery, ListFileGrantsQuery } from './schema.js'

// ---- P5：交付文件治理 ----

/**
 * 吊销交付文件（违法/恶意内容）：买家与商家全部拒绝新签发（仅管理员可
 * 取证下载），挂载它的规格立即停售（下单事务检查 file.status）。行与对象
 * 都保留——退款与清理走各自流程，吊销本身不删任何东西。
 */
export async function revokeDeliveryFile(adminUserId: number, fileId: number, reason?: string) {
  const file = await prisma.deliveryFile.findUnique({
    where: { id: fileId },
    select: { id: true, status: true },
  })
  if (!file) throw notFound('文件不存在')
  if (file.status === 'deleted') throw badRequest('文件已清理，无法吊销')
  if (file.status === 'revoked') return { revoked: true }

  await prisma.$transaction(async tx => {
    await tx.deliveryFile.update({ where: { id: fileId }, data: { status: 'revoked' } })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '吊销交付文件',
        targetType: 'deliveryFile',
        targetId: fileId,
        detail: reason ?? '违规内容吊销',
      },
    })
  })
  return { revoked: true }
}

// ---- P5.5 T1：交付文件治理（列表 + 发放流水） ----

/**
 * 分页列出交付文件。P5 不变量：普通 API（管理端也算）永不返回对象 key/bucket，
 * 对账凭 sha256 已足够——select 白名单显式排除 key。引用计数（在售规格 /
 * 交付记录）用于评估吊销影响面。
 */
export async function listDeliveryFiles(query: ListDeliveryFilesQuery) {
  const where: Prisma.DeliveryFileWhereInput = {}
  if (query.merchantId) where.merchantId = query.merchantId
  if (query.status) where.status = query.status
  if (query.fileName) where.fileName = { contains: query.fileName, mode: 'insensitive' }

  const [items, total] = await prisma.$transaction([
    prisma.deliveryFile.findMany({
      where,
      select: {
        id: true,
        fileName: true,
        size: true,
        sha256: true,
        mimeType: true,
        status: true,
        createdAt: true,
        merchant: { select: { id: true, name: true } },
        _count: { select: { offers: true, deliveryRecords: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.deliveryFile.count({ where }),
  ])

  return {
    items: items.map(file => ({
      id: file.id,
      fileName: file.fileName,
      size: file.size,
      sha256: file.sha256,
      mimeType: file.mimeType,
      status: file.status,
      createdAt: file.createdAt,
      merchant: file.merchant,
      refCounts: { offers: file._count.offers, deliveryRecords: file._count.deliveryRecords },
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  }
}

/**
 * 某文件的签名发放流水（FileGrantLog，granted 与 denied 全记）。任意状态的
 * 文件都可查——deleted 文件的历史发放仍是审计事实。倒序走 [fileId, createdAt]
 * 索引。ipHash 是 HMAC 摘要（不可还原），可直接出给管理员做同源关联。
 */
export async function listDeliveryFileGrants(fileId: number, query: ListFileGrantsQuery) {
  const file = await prisma.deliveryFile.findUnique({ where: { id: fileId }, select: { id: true } })
  if (!file) throw notFound('文件不存在')

  const [items, total] = await prisma.$transaction([
    prisma.fileGrantLog.findMany({
      where: { fileId },
      select: {
        id: true,
        orderId: true,
        userId: true,
        role: true,
        outcome: true,
        ipHash: true,
        userAgent: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.fileGrantLog.count({ where: { fileId } }),
  ])

  return { items, total, page: query.page, pageSize: query.pageSize }
}
