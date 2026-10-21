import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { badRequest, conflict, notFound } from '../../lib/httpError.js'
import { getIsoCurrencyMetadata, serializeAmountMinor, parseAmountMinorString } from './money.js'
import type { RechargeCurrency, RechargePricePolicyStatus } from './types.js'
import type { AdminCreatePricePolicyBody } from './adminSchema.js'

type PolicyWithSuggested = Prisma.RechargePricePolicyGetPayload<{
  include: { suggestedAmounts: true }
}>

function policyInclude() {
  return { suggestedAmounts: { orderBy: { sortOrder: 'asc' as const } } }
}

export async function adminListPricePolicies(query: {
  page: number
  pageSize: number
  currency?: RechargeCurrency
  status?: RechargePricePolicyStatus
  adminSandbox?: boolean
}) {
  const where = {
    ...(query.currency ? { currency: query.currency } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.adminSandbox === undefined ? {} : { adminSandbox: query.adminSandbox }),
  }
  const [total, items] = await prisma.$transaction([
    prisma.rechargePricePolicy.count({ where }),
    prisma.rechargePricePolicy.findMany({
      where,
      orderBy: [{ currency: 'asc' }, { adminSandbox: 'asc' }, { version: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: policyInclude(),
    }),
  ])
  return {
    page: query.page,
    pageSize: query.pageSize,
    total,
    items: items.map(serializePolicy),
  }
}

export async function adminCreatePricePolicy(body: AdminCreatePricePolicyBody, actorUserId: number) {
  const minAmountMinor = parseAmountMinorString(body.minAmountMinor)
  const maxAmountMinor = parseAmountMinorString(body.maxAmountMinor)
  const amountStepMinor = parseAmountMinorString(body.amountStepMinor)
  const dailyLimitMinor = parseAmountMinorString(body.dailyLimitMinor)
  const monthlyLimitMinor = parseAmountMinorString(body.monthlyLimitMinor)
  const pointsNumerator = parseAmountMinorString(body.pointsNumerator)
  const pointsDenominator = parseAmountMinorString(body.pointsDenominator)
  const iso = getIsoCurrencyMetadata(body.currency)
  if (body.currencyScale !== iso.scale) {
    throw badRequest(`currencyScale 必须与 ${body.currency} 的 ISO 精度 ${iso.scale} 一致`)
  }
  if (minAmountMinor > maxAmountMinor) {
    throw badRequest('最低金额不能高于最高金额')
  }
  if (dailyLimitMinor < maxAmountMinor) {
    throw badRequest('日限额不能低于最高金额')
  }
  if (monthlyLimitMinor < dailyLimitMinor) {
    throw badRequest('月限额不能低于日限额')
  }

  const suggested = body.suggestedAmounts.map(item => ({
    amountMinor: parseAmountMinorString(item.amountMinor),
    sortOrder: item.sortOrder,
  }))
  const seenAmounts = new Set<string>()
  const seenOrders = new Set<number>()
  for (const item of suggested) {
    const key = serializeAmountMinor(item.amountMinor)
    if (seenAmounts.has(key)) throw badRequest('推荐金额不能重复')
    if (seenOrders.has(item.sortOrder)) throw badRequest('推荐金额排序不能重复')
    seenAmounts.add(key)
    seenOrders.add(item.sortOrder)
    if (item.amountMinor < minAmountMinor || item.amountMinor > maxAmountMinor) {
      throw badRequest('推荐金额必须在最低和最高金额之间')
    }
    if (amountStepMinor > 0n && item.amountMinor % amountStepMinor !== 0n) {
      throw badRequest('推荐金额必须符合金额步进')
    }
  }

  const adminSandbox = body.adminSandbox === true
  try {
    return await prisma.$transaction(async tx => {
      const existing = await tx.rechargePricePolicy.findUnique({ where: { code: body.code } })
      if (existing) throw conflict('价格政策代码已存在')
      const latest = await tx.rechargePricePolicy.aggregate({
        where: { currency: body.currency, adminSandbox },
        _max: { version: true },
      })
      const created = await tx.rechargePricePolicy.create({
        data: {
          code: body.code,
          version: (latest._max.version ?? 0) + 1,
          currency: body.currency,
          adminSandbox,
          currencyScale: body.currencyScale,
          pointsNumerator,
          pointsDenominator,
          roundingMode: body.roundingMode,
          minAmountMinor,
          maxAmountMinor,
          amountStepMinor,
          dailyLimitMinor,
          monthlyLimitMinor,
          limitTimeZone: body.limitTimeZone,
          bonusRuleVersion: body.bonusRuleVersion ?? null,
          status: 'draft',
          effectiveAt: new Date(),
          suggestedAmounts: { create: suggested },
        },
        include: policyInclude(),
      })
      await tx.adminLog.create({
        data: {
          adminUserId: actorUserId,
          action: 'recharge.price_policy.create',
          targetType: 'RechargePricePolicy',
          detail: JSON.stringify({
            policyId: created.id,
            code: created.code,
            currency: created.currency,
            adminSandbox,
            status: 'draft',
          }),
        },
      })
      return serializePolicy(created)
    })
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw conflict('价格政策代码或版本已存在')
    }
    throw err
  }
}

export async function adminPatchPricePolicy(id: string, body: {
  minAmountMinor?: string
  maxAmountMinor?: string
  amountStepMinor?: string
  dailyLimitMinor?: string
  monthlyLimitMinor?: string
  status?: string
}, actorUserId: number) {
  const current = await prisma.rechargePricePolicy.findUnique({ where: { id } })
  if (!current) throw notFound('价格政策不存在')
  if (current.status === 'retired') throw conflict('已退役的价格政策不能修改')
  const data: Record<string, bigint | string> = {}
  if (body.minAmountMinor) data.minAmountMinor = parseAmountMinorString(body.minAmountMinor)
  if (body.maxAmountMinor) data.maxAmountMinor = parseAmountMinorString(body.maxAmountMinor)
  if (body.amountStepMinor) data.amountStepMinor = parseAmountMinorString(body.amountStepMinor)
  if (body.dailyLimitMinor) data.dailyLimitMinor = parseAmountMinorString(body.dailyLimitMinor)
  if (body.monthlyLimitMinor) data.monthlyLimitMinor = parseAmountMinorString(body.monthlyLimitMinor)
  if (body.status === 'draft' || body.status === 'retired') data.status = body.status
  await prisma.rechargePricePolicy.update({ where: { id }, data })
  await prisma.adminLog.create({
    data: {
      adminUserId: actorUserId,
      action: 'recharge.price_policy.patch',
      targetType: 'RechargePricePolicy',
      detail: JSON.stringify({ policyId: id, fields: Object.keys(data) }),
    },
  })
  return serializePolicy(await loadPolicy(id))
}

export async function adminActivatePricePolicy(id: string, actorUserId: number) {
  return prisma.$transaction(async tx => {
    const policy = await tx.rechargePricePolicy.findUnique({
      where: { id },
      include: policyInclude(),
    })
    if (!policy) throw notFound('价格政策不存在')
    if (policy.status === 'active') return serializePolicy(policy)
    await tx.rechargePricePolicy.updateMany({
      where: {
        currency: policy.currency,
        adminSandbox: policy.adminSandbox,
        status: 'active',
        id: { not: id },
      },
      data: { status: 'retired' },
    })
    const updated = await tx.rechargePricePolicy.update({
      where: { id },
      data: { status: 'active', effectiveAt: new Date() },
      include: policyInclude(),
    })
    await tx.adminLog.create({
      data: {
        adminUserId: actorUserId,
        action: 'recharge.price_policy.activate',
        targetType: 'RechargePricePolicy',
        detail: JSON.stringify({
          policyId: id,
          code: policy.code,
          currency: policy.currency,
          adminSandbox: policy.adminSandbox,
        }),
      },
    })
    return serializePolicy(updated)
  })
}

async function loadPolicy(id: string): Promise<PolicyWithSuggested> {
  const row = await prisma.rechargePricePolicy.findUnique({
    where: { id },
    include: policyInclude(),
  })
  if (!row) throw notFound('价格政策不存在')
  return row
}

function serializePolicy(row: PolicyWithSuggested) {
  return {
    id: row.id,
    code: row.code,
    version: row.version,
    currency: row.currency,
    adminSandbox: row.adminSandbox,
    status: row.status,
    currencyScale: row.currencyScale,
    pointsNumerator: serializeAmountMinor(row.pointsNumerator),
    pointsDenominator: serializeAmountMinor(row.pointsDenominator),
    roundingMode: row.roundingMode,
    minAmountMinor: serializeAmountMinor(row.minAmountMinor),
    maxAmountMinor: serializeAmountMinor(row.maxAmountMinor),
    amountStepMinor: serializeAmountMinor(row.amountStepMinor),
    dailyLimitMinor: serializeAmountMinor(row.dailyLimitMinor),
    monthlyLimitMinor: serializeAmountMinor(row.monthlyLimitMinor),
    limitTimeZone: row.limitTimeZone,
    bonusRuleVersion: row.bonusRuleVersion,
    suggestedAmounts: row.suggestedAmounts.map(item => ({
      amountMinor: serializeAmountMinor(item.amountMinor),
      sortOrder: item.sortOrder,
    })),
    effectiveAt: row.effectiveAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }
}
