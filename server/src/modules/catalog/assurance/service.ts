import { Prisma } from '@prisma/client'
import { prisma } from '../../../lib/prisma.js'
import { badRequest, forbidden, HttpError, notFound } from '../../../lib/httpError.js'
import { ASSURANCE_POLICY_CODE, ASSURANCE_POLICY_TEXT, CATALOG_ERROR_CODES } from '../constants.js'
import { lockProductRow } from '../../admin/productLifecycle.js'
import { invalidateProductPublicCache } from '../../products/cache.js'

type Tx = Prisma.TransactionClient
const DAY_MS = 86_400_000
const MAX_GRANT_DAYS = 365

export type PublicAssuranceDto = {
  label: '平台保障'
  policyCode: typeof ASSURANCE_POLICY_CODE
  policyText: string
  validUntil: string
}

type ApplicationRow = Prisma.ProductAssuranceApplicationGetPayload<object>
type GrantRow = Prisma.ProductAssuranceGrantGetPayload<object>

function applicationDto(row: ApplicationRow, audience: 'merchant' | 'admin') {
  return {
    id: row.id,
    productId: row.productId,
    merchantId: row.merchantId,
    reason: row.reason,
    status: row.status,
    reviewReason: row.reviewReason,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    ...(audience === 'admin' ? { reviewedByUserId: row.reviewedByUserId } : {}),
  }
}

function grantDto(row: GrantRow, audience: 'merchant' | 'admin', now: Date) {
  const status = row.status === 'active' && row.validUntil <= now ? 'expired' : row.status
  return {
    id: row.id,
    productId: row.productId,
    status,
    policyCode: row.policyCode,
    policyText: ASSURANCE_POLICY_TEXT,
    validFrom: row.validFrom.toISOString(),
    validUntil: row.validUntil.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    ...(audience === 'admin'
      ? {
          applicationId: row.applicationId,
          grantedByUserId: row.grantedByUserId,
          grantReason: row.grantReason,
          revokedByUserId: row.revokedByUserId,
          revokeReason: row.revokeReason,
        }
      : {}),
  }
}

async function clockNow(tx: Tx | typeof prisma): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CLOCK_TIMESTAMP() AS now`
  return rows[0]?.now ?? new Date()
}

function assertValidUntil(validUntil: Date, now: Date) {
  if (!(validUntil.getTime() > now.getTime())) {
    throw badRequest('到期时间必须晚于当前时间')
  }
  if (validUntil.getTime() - now.getTime() > MAX_GRANT_DAYS * DAY_MS) {
    throw badRequest('授权最长 365 天')
  }
}

async function expireDueGrants(tx: Tx, productId: number, now: Date) {
  await tx.productAssuranceGrant.updateMany({
    where: { productId, status: 'active', validUntil: { lte: now } },
    data: { status: 'expired' },
  })
}

async function merchantOf(tx: Tx, merchantId: number | null) {
  if (merchantId == null) return null
  return tx.merchant.findUnique({ where: { id: merchantId }, select: { status: true } })
}

function isEligibleProduct(product: {
  status: string
  archivedAt: Date | null
  merchantId: number | null
  merchant?: { status: string } | null
}) {
  if (product.status !== 'active' || product.archivedAt) return false
  if (product.merchantId != null && product.merchant?.status !== 'active') return false
  return true
}

async function createGrantRow(
  tx: Tx,
  input: {
    productId: number
    applicationId: number | null
    adminUserId: number
    reason: string
    validUntil: Date
    now: Date
  },
) {
  await expireDueGrants(tx, input.productId, input.now)
  const active = await tx.productAssuranceGrant.findFirst({
    where: { productId: input.productId, status: 'active' },
    select: { id: true },
  })
  if (active) {
    throw new HttpError(409, CATALOG_ERROR_CODES.ASSURANCE_ALREADY_ACTIVE, '该商品已有有效保障授权')
  }
  return tx.productAssuranceGrant.create({
    data: {
      productId: input.productId,
      applicationId: input.applicationId,
      status: 'active',
      policyCode: ASSURANCE_POLICY_CODE,
      validFrom: input.now,
      validUntil: input.validUntil,
      grantedByUserId: input.adminUserId,
      grantReason: input.reason,
    },
  })
}

async function readAssurance(productId: number, audience: 'merchant' | 'admin') {
  const now = await clockNow(prisma)
  const [application, grant] = await Promise.all([
    prisma.productAssuranceApplication.findFirst({
      where: { productId },
      orderBy: { id: 'desc' },
    }),
    prisma.productAssuranceGrant.findFirst({
      where: { productId },
      orderBy: { id: 'desc' },
    }),
  ])
  return {
    application: application ? applicationDto(application, audience) : null,
    grant: grant ? grantDto(grant, audience, now) : null,
  }
}

export async function getMerchantAssurance(merchantId: number, productId: number) {
  const product = await prisma.product.findFirst({
    where: { id: productId, merchantId },
    select: { id: true },
  })
  if (!product) throw notFound('商品不存在')
  return readAssurance(productId, 'merchant')
}

export async function getAdminProductAssurance(productId: number) {
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } })
  if (!product) throw notFound('商品不存在')
  return readAssurance(productId, 'admin')
}

export async function applyForAssurance(merchantId: number, productId: number, reason: string) {
  try {
    return await prisma.$transaction(async tx => {
      const product = await lockProductRow(tx, productId)
      if (product.merchantId !== merchantId) throw notFound('商品不存在')
      const merchant = await merchantOf(tx, merchantId)
      if (!merchant || merchant.status !== 'active') throw forbidden('商家状态不可用')
      if (product.status !== 'active' || product.archivedAt) throw badRequest('仅已上架商品可以申请保障')
      const now = await clockNow(tx)
      await expireDueGrants(tx, productId, now)
      const pending = await tx.productAssuranceApplication.findFirst({
        where: { productId, status: 'pending' },
        select: { id: true },
      })
      if (pending) {
        throw new HttpError(409, CATALOG_ERROR_CODES.ASSURANCE_ALREADY_PENDING, '已有待审核的保障申请')
      }
      const active = await tx.productAssuranceGrant.findFirst({
        where: { productId, status: 'active', validFrom: { lte: now }, validUntil: { gt: now } },
        select: { id: true },
      })
      if (active) {
        throw new HttpError(409, CATALOG_ERROR_CODES.ASSURANCE_ALREADY_ACTIVE, '该商品已有有效保障授权')
      }
      const created = await tx.productAssuranceApplication.create({
        data: { productId, merchantId, reason, status: 'pending' },
      })
      return applicationDto(created, 'merchant')
    })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new HttpError(409, CATALOG_ERROR_CODES.ASSURANCE_ALREADY_PENDING, '已有待审核的保障申请')
    }
    throw err
  }
}

export async function withdrawAssuranceApplication(merchantId: number, applicationId: number) {
  return prisma.$transaction(async tx => {
    const application = await tx.productAssuranceApplication.findUnique({ where: { id: applicationId } })
    if (!application || application.merchantId !== merchantId) throw notFound('申请不存在')
    await lockProductRow(tx, application.productId)
    const updated = await tx.productAssuranceApplication.updateMany({
      where: { id: applicationId, merchantId, status: 'pending' },
      data: { status: 'withdrawn' },
    })
    if (updated.count !== 1) {
      throw new HttpError(409, CATALOG_ERROR_CODES.ASSURANCE_APPLICATION_CLOSED, '申请已结束，无法撤回')
    }
    return applicationDto(
      await tx.productAssuranceApplication.findUniqueOrThrow({ where: { id: applicationId } }),
      'merchant',
    )
  })
}

export async function listAdminAssuranceApplications(query: {
  status?: string
  page?: number
  pageSize?: number
}) {
  const page = query.page ?? 1
  const pageSize = query.pageSize ?? 20
  const where = query.status ? { status: query.status } : {}
  const [total, items] = await prisma.$transaction([
    prisma.productAssuranceApplication.count({ where }),
    prisma.productAssuranceApplication.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])
  return {
    items: items.map(item => applicationDto(item, 'admin')),
    total,
    page,
    pageSize,
  }
}

export async function approveAssuranceApplication(
  adminUserId: number,
  applicationId: number,
  input: { validUntil: Date; reason: string },
) {
  const result = await prisma.$transaction(async tx => {
    const application = await tx.productAssuranceApplication.findUnique({ where: { id: applicationId } })
    if (!application) throw notFound('申请不存在')
    const product = await lockProductRow(tx, application.productId)
    const now = await clockNow(tx)
    assertValidUntil(input.validUntil, now)
    const merchant = await merchantOf(tx, product.merchantId)
    if (!isEligibleProduct({ ...product, merchant })) {
      throw badRequest('仅已上架且经营有效的商品可以授权保障')
    }
    const updated = await tx.productAssuranceApplication.updateMany({
      where: { id: applicationId, status: 'pending' },
      data: {
        status: 'approved',
        reviewReason: input.reason,
        reviewedByUserId: adminUserId,
        reviewedAt: now,
      },
    })
    if (updated.count !== 1) {
      throw new HttpError(409, CATALOG_ERROR_CODES.ASSURANCE_APPLICATION_CLOSED, '申请已被处理')
    }
    const grant = await createGrantRow(tx, {
      productId: application.productId,
      applicationId,
      adminUserId,
      reason: input.reason,
      validUntil: input.validUntil,
      now,
    })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '批准商品保障',
        targetType: 'productAssuranceApplication',
        targetId: applicationId,
        detail: `申请 #${applicationId} 商品 #${application.productId} 授权 #${grant.id}`,
      },
    })
    return {
      application: applicationDto(
        await tx.productAssuranceApplication.findUniqueOrThrow({ where: { id: applicationId } }),
        'admin',
      ),
      grant: grantDto(grant, 'admin', now),
    }
  })
  await invalidateProductPublicCache(result.grant.productId, { detail: true, list: true })
  return result
}

export async function rejectAssuranceApplication(
  adminUserId: number,
  applicationId: number,
  reason: string,
) {
  return prisma.$transaction(async tx => {
    const application = await tx.productAssuranceApplication.findUnique({ where: { id: applicationId } })
    if (!application) throw notFound('申请不存在')
    await lockProductRow(tx, application.productId)
    const now = await clockNow(tx)
    const updated = await tx.productAssuranceApplication.updateMany({
      where: { id: applicationId, status: 'pending' },
      data: {
        status: 'rejected',
        reviewReason: reason,
        reviewedByUserId: adminUserId,
        reviewedAt: now,
      },
    })
    if (updated.count !== 1) {
      throw new HttpError(409, CATALOG_ERROR_CODES.ASSURANCE_APPLICATION_CLOSED, '申请已被处理')
    }
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '拒绝商品保障申请',
        targetType: 'productAssuranceApplication',
        targetId: applicationId,
        detail: `申请 #${applicationId} 商品 #${application.productId}`,
      },
    })
    return applicationDto(
      await tx.productAssuranceApplication.findUniqueOrThrow({ where: { id: applicationId } }),
      'admin',
    )
  })
}

export async function grantProductAssurance(
  adminUserId: number,
  productId: number,
  input: { validUntil: Date; reason: string },
) {
  const result = await prisma.$transaction(async tx => {
    const product = await lockProductRow(tx, productId)
    const now = await clockNow(tx)
    assertValidUntil(input.validUntil, now)
    const merchant = await merchantOf(tx, product.merchantId)
    if (!isEligibleProduct({ ...product, merchant })) {
      throw badRequest('仅已上架且经营有效的商品可以授权保障')
    }
    const pending = await tx.productAssuranceApplication.findFirst({
      where: { productId, status: 'pending' },
      select: { id: true },
    })
    if (pending) {
      throw new HttpError(409, CATALOG_ERROR_CODES.ASSURANCE_ALREADY_PENDING, '请先审核该商品的待处理申请')
    }
    const grant = await createGrantRow(tx, {
      productId,
      applicationId: null,
      adminUserId,
      reason: input.reason,
      validUntil: input.validUntil,
      now,
    })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '授予商品保障',
        targetType: 'productAssuranceGrant',
        targetId: grant.id,
        detail: `商品 #${productId} 授权 #${grant.id}`,
      },
    })
    return grantDto(grant, 'admin', now)
  })
  await invalidateProductPublicCache(productId, { detail: true, list: true })
  return result
}

export async function revokeAssuranceGrant(
  adminUserId: number,
  grantId: number,
  reason: string,
) {
  const result = await prisma.$transaction(async tx => {
    const grant = await tx.productAssuranceGrant.findUnique({ where: { id: grantId } })
    if (!grant) throw notFound('授权不存在')
    await lockProductRow(tx, grant.productId)
    const now = await clockNow(tx)
    if (grant.status === 'revoked') {
      return { dto: grantDto(grant, 'admin', now), productId: grant.productId, changed: false }
    }
    if (grant.status === 'expired' || (grant.status === 'active' && grant.validUntil <= now)) {
      if (grant.status === 'active') {
        await tx.productAssuranceGrant.update({
          where: { id: grantId },
          data: { status: 'expired' },
        })
      }
      const current = await tx.productAssuranceGrant.findUniqueOrThrow({ where: { id: grantId } })
      return { dto: grantDto(current, 'admin', now), productId: grant.productId, changed: false }
    }
    const updated = await tx.productAssuranceGrant.update({
      where: { id: grantId },
      data: {
        status: 'revoked',
        revokedAt: now,
        revokedByUserId: adminUserId,
        revokeReason: reason,
      },
    })
    await tx.adminLog.create({
      data: {
        adminUserId,
        action: '撤销商品保障',
        targetType: 'productAssuranceGrant',
        targetId: grantId,
        detail: `商品 #${grant.productId} 授权 #${grantId}`,
      },
    })
    return { dto: grantDto(updated, 'admin', now), productId: grant.productId, changed: true }
  })
  if (result.changed) {
    await invalidateProductPublicCache(result.productId, { detail: true, list: true })
  }
  return result.dto
}

export async function loadPublicAssuranceByProductIds(productIds: number[]): Promise<Map<number, PublicAssuranceDto>> {
  const map = new Map<number, PublicAssuranceDto>()
  if (productIds.length === 0) return map
  const now = await clockNow(prisma)
  const grants = await prisma.productAssuranceGrant.findMany({
    where: {
      productId: { in: productIds },
      status: 'active',
      validFrom: { lte: now },
      validUntil: { gt: now },
    },
    select: {
      id: true,
      productId: true,
      validUntil: true,
      product: {
        select: {
          status: true,
          archivedAt: true,
          merchantId: true,
          merchant: { select: { status: true } },
        },
      },
    },
  })
  for (const grant of grants) {
    if (!isEligibleProduct(grant.product)) continue
    if (map.has(grant.productId)) continue
    map.set(grant.productId, {
      label: '平台保障',
      policyCode: ASSURANCE_POLICY_CODE,
      policyText: ASSURANCE_POLICY_TEXT,
      validUntil: grant.validUntil.toISOString(),
    })
  }
  return map
}
