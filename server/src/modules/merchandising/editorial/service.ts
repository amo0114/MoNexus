import { Prisma } from '@prisma/client'
import { prisma } from '../../../lib/prisma.js'
import { badRequest, conflict, notFound, forbidden } from '../../../lib/httpError.js'
import { EDITORIAL_STATUS } from '../constants.js'
import { summarizeAdminAuditReason } from '../audit.js'

type TransactionHost = typeof prisma
type EditorialDb = typeof prisma | Prisma.TransactionClient

async function dbNow(db: EditorialDb): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT now() AT TIME ZONE 'UTC' AS now`
  return rows[0].now
}

async function assertAdmin(userId: number, db: EditorialDb = prisma) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true } })
  if (!user || user.role !== 'admin') throw forbidden('需要管理员权限')
}

const editorialSelect = {
  id: true, productId: true, placement: true, status: true, startsAt: true, endsAt: true,
  sortWeight: true, publicReason: true, internalReason: true, createdByUserId: true,
  revokedByUserId: true, createdAt: true, updatedAt: true,
  product: { select: { name: true } },
} as const

type EditorialRow = Prisma.EditorialFeatureGetPayload<{ select: typeof editorialSelect }>

function toEditorialDto(row: EditorialRow) {
  const { product, ...feature } = row
  return { ...feature, productName: product.name }
}

export async function createEditorialFeature(adminUserId: number, input: {
  productId: number; placement: string; startsAt: string; endsAt: string; sortWeight?: number;
  publicReason?: string | null; internalReason: string
}, db: TransactionHost = prisma) {
  const startsAt = new Date(input.startsAt)
  const endsAt = new Date(input.endsAt)
  if (!(startsAt < endsAt)) throw badRequest('精选结束时间必须晚于开始时间')
  return db.$transaction(async tx => {
    await assertAdmin(adminUserId, tx)
    const product = await tx.product.findUnique({ where: { id: input.productId }, select: { status: true } })
    if (!product) throw notFound('商品不存在')
    if (product.status !== 'active') throw conflict('只有已发布商品可以安排平台精选')
    const now = await dbNow(tx)
    if (endsAt <= now) throw badRequest('精选结束时间必须晚于当前数据库时间')
    const status = startsAt <= now ? EDITORIAL_STATUS.ACTIVE : EDITORIAL_STATUS.SCHEDULED
    const feature = await tx.editorialFeature.create({
      data: {
        productId: input.productId,
        placement: input.placement,
        status,
        startsAt,
        endsAt,
        sortWeight: input.sortWeight ?? 0,
        publicReason: input.publicReason ?? null,
        internalReason: input.internalReason,
        createdByUserId: adminUserId,
      },
      select: editorialSelect,
    })
    await tx.adminLog.create({
      data: { adminUserId, action: '安排平台精选', targetType: 'editorial_feature', targetId: feature.id, detail: `productId=${input.productId}; status=${status}` },
    })
    return toEditorialDto(feature)
  })
}

export async function updateEditorialFeature(adminUserId: number, featureId: number, input: {
  placement?: string; startsAt?: string; endsAt?: string; sortWeight?: number;
  publicReason?: string | null; internalReason?: string
}, db: TransactionHost = prisma) {
  return db.$transaction(async tx => {
    await assertAdmin(adminUserId, tx)
    const current = await tx.editorialFeature.findUnique({ where: { id: featureId }, select: editorialSelect })
    if (!current) throw notFound('平台精选不存在')
    if (current.status === EDITORIAL_STATUS.REVOKED || current.status === EDITORIAL_STATUS.EXPIRED) {
      throw conflict('已终止的平台精选不能修改')
    }
    const startsAt = input.startsAt === undefined ? current.startsAt : new Date(input.startsAt)
    const endsAt = input.endsAt === undefined ? current.endsAt : new Date(input.endsAt)
    if (!(startsAt < endsAt)) throw badRequest('精选结束时间必须晚于开始时间')
    const now = await dbNow(tx)
    if (endsAt <= now) throw badRequest('精选结束时间必须晚于当前数据库时间')
    const status = startsAt <= now ? EDITORIAL_STATUS.ACTIVE : EDITORIAL_STATUS.SCHEDULED
    const updated = await tx.editorialFeature.update({
      where: { id: featureId },
      data: {
        ...(input.placement === undefined ? {} : { placement: input.placement }),
        startsAt,
        endsAt,
        status,
        ...(input.sortWeight === undefined ? {} : { sortWeight: input.sortWeight }),
        ...(input.publicReason === undefined ? {} : { publicReason: input.publicReason }),
        ...(input.internalReason === undefined ? {} : { internalReason: input.internalReason }),
      },
      select: editorialSelect,
    })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '修改平台精选',
        targetType: 'editorial_feature',
        targetId: featureId,
        detail: `status=${status}; fields=${Object.keys(input).sort().join(',')}`,
      },
    })
    return toEditorialDto(updated)
  })
}

export async function listEditorialFeatures(query: { status?: string; placement?: string; page?: number; pageSize?: number } = {}) {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 20
  const where = { ...(query.status ? { status: query.status } : {}), ...(query.placement ? { placement: query.placement } : {}) }
  const [total, items] = await prisma.$transaction([
    prisma.editorialFeature.count({ where }),
    prisma.editorialFeature.findMany({ where, select: editorialSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
  ])
  return { items: items.map(toEditorialDto), total, page, pageSize }
}

export async function revokeEditorialFeature(adminUserId: number, featureId: number, reason: string, db: TransactionHost = prisma) {
  return db.$transaction(async tx => {
    await assertAdmin(adminUserId, tx)
    const feature = await tx.editorialFeature.findUnique({ where: { id: featureId }, select: editorialSelect })
    if (!feature) throw notFound('平台精选不存在')
    if (feature.status === EDITORIAL_STATUS.REVOKED) return toEditorialDto(feature)
    if (feature.status === EDITORIAL_STATUS.EXPIRED) throw conflict('已过期精选不能撤销')
    const updated = await tx.editorialFeature.update({
      where: { id: featureId }, data: { status: EDITORIAL_STATUS.REVOKED, revokedByUserId: adminUserId }, select: editorialSelect,
    })
    await tx.adminLog.create({ data: { adminUserId, action: '撤销平台精选', targetType: 'editorial_feature', targetId: featureId, detail: `status=revoked; ${summarizeAdminAuditReason(reason)}` } })
    return toEditorialDto(updated)
  })
}

export async function advanceEditorialLifecycle(db: TransactionHost = prisma) {
  return db.$transaction(async tx => {
    const scheduledToActive = await tx.$executeRaw`
      UPDATE "EditorialFeature" SET "status"='active', "updatedAt"=now()
      WHERE "status"='scheduled' AND "startsAt" <= (now() AT TIME ZONE 'UTC')`
    const activeToExpired = await tx.$executeRaw`
      UPDATE "EditorialFeature" SET "status"='expired', "updatedAt"=now()
      WHERE "status"='active' AND "endsAt" <= (now() AT TIME ZONE 'UTC')`
    return { scheduledToActive, activeToExpired }
  })
}
