import type { MoneyRoundingMode, Prisma, PrismaClient } from '@prisma/client'
import { config } from '../../config/index.js'
import { logger } from '../../lib/logger.js'
import {
  orderPricingSnapshotCreatedTotal,
  orderPricingSnapshotFailureTotal,
  valuePolicyChangedTotal,
  valuePolicyResolutionTotal,
  type ValuePolicyModeLabel,
  type ValuePolicyResolutionResult,
} from '../../lib/metrics.js'
import {
  valuePolicyChanged,
  valuePolicyDataInvalid,
  valuePolicyDisabled,
  valuePolicyRequired,
  valuePolicyUnavailable,
} from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'
import { atomicToDecimalString, convertPointsToReferenceAtomic } from './money.js'

export type PointValuePolicyMode = 'off' | 'shadow' | 'enforce'

export const VALUE_POLICY_DISCLOSURE =
  '积分为平台内部权益，所示金额仅为参考价值，不代表现金赎回承诺。'

export const POINT_ASSET_CODE = 'RP'
export const REFERENCE_ASSET_CODE = 'CNY'
const POINT_ASSET_SCALE = 0
const REFERENCE_ASSET_SCALE = 2

type DbClient = PrismaClient | Prisma.TransactionClient

export type AtomicAmountDto = {
  assetCode: string
  amountAtomic: string
  scale: number
}

export type OrderPricingDto = {
  points: AtomicAmountDto
  reference: AtomicAmountDto
  valuePolicyId: string
}

export type CurrentValuePolicyDto = {
  id: string
  version: number
  pointAsset: { code: string; scale: number }
  referenceAsset: { code: string; scale: number }
  ratio: {
    referenceAtomicPerPointNumerator: string
    referenceAtomicPerPointDenominator: string
  }
  roundingMode: 'HALF_EVEN'
  effectiveAt: string
  disclosure: string
}

export type ResolvedValuePolicy = {
  id: string
  version: number
  pointAssetCode: string
  referenceAssetCode: string
  pointScale: number
  referenceScale: number
  referenceAtomicPerPointNumerator: bigint
  referenceAtomicPerPointDenominator: bigint
  roundingMode: MoneyRoundingMode
  effectiveAt: Date
}

export type OrderPricingContext = {
  policy: ResolvedValuePolicy
  pointsAmountAtomic: bigint
  referenceAmountAtomic: bigint
}

function currentMode(): PointValuePolicyMode {
  return config.pointValuePolicyMode
}

function recordResolution(result: ValuePolicyResolutionResult, mode: ValuePolicyModeLabel) {
  valuePolicyResolutionTotal.inc({ result, mode })
}

function isEnabledMode(mode: PointValuePolicyMode): mode is 'shadow' | 'enforce' {
  return mode === 'shadow' || mode === 'enforce'
}

function validateResolvedPolicy(policy: {
  id: string
  version: number
  pointAssetCode: string
  referenceAssetCode: string
  referenceAtomicPerPointNumerator: bigint
  referenceAtomicPerPointDenominator: bigint
  roundingMode: MoneyRoundingMode
  status: string
  effectiveAt: Date
  retiredAt: Date | null
  pointAsset: { kind: string; scale: number; enabled: boolean; retiredAt: Date | null }
  referenceAsset: { kind: string; scale: number; enabled: boolean; retiredAt: Date | null }
}): ResolvedValuePolicy {
  const invalid =
    policy.pointAssetCode !== POINT_ASSET_CODE
    || policy.referenceAssetCode !== REFERENCE_ASSET_CODE
    || policy.pointAsset.kind !== 'reward_point'
    || policy.referenceAsset.kind !== 'fiat'
    || policy.pointAsset.scale !== POINT_ASSET_SCALE
    || policy.referenceAsset.scale !== REFERENCE_ASSET_SCALE
    || policy.pointAsset.enabled !== true
    || policy.referenceAsset.enabled !== true
    || policy.pointAsset.retiredAt != null
    || policy.referenceAsset.retiredAt != null
    || policy.referenceAtomicPerPointNumerator <= 0n
    || policy.referenceAtomicPerPointDenominator <= 0n
    || policy.roundingMode !== 'HALF_EVEN'
    || policy.status !== 'active'
    || policy.retiredAt != null
    || policy.effectiveAt.getTime() > Date.now()

  if (invalid) {
    logger.error({
      event: 'value_policy_data_invalid',
      policyId: policy.id,
      pointAssetCode: policy.pointAssetCode,
      referenceAssetCode: policy.referenceAssetCode,
    }, 'active value policy violates internal invariants')
    recordResolution('invalid', currentMode())
    throw valuePolicyDataInvalid()
  }

  return {
    id: policy.id,
    version: policy.version,
    pointAssetCode: policy.pointAssetCode,
    referenceAssetCode: policy.referenceAssetCode,
    pointScale: policy.pointAsset.scale,
    referenceScale: policy.referenceAsset.scale,
    referenceAtomicPerPointNumerator: policy.referenceAtomicPerPointNumerator,
    referenceAtomicPerPointDenominator: policy.referenceAtomicPerPointDenominator,
    roundingMode: policy.roundingMode,
    effectiveAt: policy.effectiveAt,
  }
}

export async function resolveActiveCnyPolicy(
  db: DbClient = prisma,
  options: { lock?: boolean } = {},
): Promise<ResolvedValuePolicy> {
  const mode = currentMode()
  if (options.lock) {
    await db.$queryRaw`
      SELECT "id" FROM "ValuePolicy"
      WHERE status = 'active'
        AND "pointAssetCode" = ${POINT_ASSET_CODE}
        AND "referenceAssetCode" = ${REFERENCE_ASSET_CODE}
      FOR UPDATE`
  }

  const policies = await db.valuePolicy.findMany({
    where: {
      status: 'active',
      pointAssetCode: POINT_ASSET_CODE,
      referenceAssetCode: REFERENCE_ASSET_CODE,
    },
    include: {
      pointAsset: true,
      referenceAsset: true,
    },
  })

  if (policies.length === 0) {
    logger.error({
      event: 'value_policy_unavailable',
      mode,
    }, 'no unique active CNY value policy')
    recordResolution('unavailable', mode)
    throw valuePolicyUnavailable()
  }

  if (policies.length > 1) {
    logger.error({
      event: 'value_policy_multiple_active',
      mode,
      count: policies.length,
    }, 'multiple active CNY value policies detected')
    recordResolution('multiple', mode)
    throw valuePolicyUnavailable()
  }

  const resolved = validateResolvedPolicy(policies[0])
  recordResolution('found', mode)
  return resolved
}

export function convertOfferPrice(policy: ResolvedValuePolicy, pointsAmount: number): bigint {
  if (!Number.isInteger(pointsAmount) || pointsAmount < 0) {
    throw valuePolicyDataInvalid('积分价格不合法')
  }
  return convertPointsToReferenceAtomic({
    pointsAtomic: BigInt(pointsAmount),
    referenceAtomicPerPointNumerator: policy.referenceAtomicPerPointNumerator,
    referenceAtomicPerPointDenominator: policy.referenceAtomicPerPointDenominator,
    roundingMode: policy.roundingMode,
  })
}

export function toOrderPricingDto(
  policy: ResolvedValuePolicy,
  pointsAmount: number,
  referenceAmountAtomic: bigint,
): OrderPricingDto {
  return {
    points: {
      assetCode: policy.pointAssetCode,
      amountAtomic: atomicToDecimalString(BigInt(pointsAmount)),
      scale: policy.pointScale,
    },
    reference: {
      assetCode: policy.referenceAssetCode,
      amountAtomic: atomicToDecimalString(referenceAmountAtomic),
      scale: policy.referenceScale,
    },
    valuePolicyId: policy.id,
  }
}

export function serializeCurrentPolicy(policy: ResolvedValuePolicy): CurrentValuePolicyDto {
  return {
    id: policy.id,
    version: policy.version,
    pointAsset: { code: policy.pointAssetCode, scale: policy.pointScale },
    referenceAsset: { code: policy.referenceAssetCode, scale: policy.referenceScale },
    ratio: {
      referenceAtomicPerPointNumerator: atomicToDecimalString(policy.referenceAtomicPerPointNumerator),
      referenceAtomicPerPointDenominator: atomicToDecimalString(policy.referenceAtomicPerPointDenominator),
    },
    roundingMode: 'HALF_EVEN',
    effectiveAt: policy.effectiveAt.toISOString(),
    disclosure: VALUE_POLICY_DISCLOSURE,
  }
}

export function serializeSnapshotPricing(snapshot: {
  pointsAssetCode: string
  pointsAmountAtomic: bigint
  referenceAssetCode: string
  referenceAmountAtomic: bigint
  valuePolicyId: string
  pointScale?: number
  referenceScale?: number
}): OrderPricingDto {
  return {
    points: {
      assetCode: snapshot.pointsAssetCode,
      amountAtomic: atomicToDecimalString(snapshot.pointsAmountAtomic),
      scale: snapshot.pointScale ?? POINT_ASSET_SCALE,
    },
    reference: {
      assetCode: snapshot.referenceAssetCode,
      amountAtomic: atomicToDecimalString(snapshot.referenceAmountAtomic),
      scale: snapshot.referenceScale ?? REFERENCE_ASSET_SCALE,
    },
    valuePolicyId: snapshot.valuePolicyId,
  }
}

export async function getCurrentValuePolicy(): Promise<CurrentValuePolicyDto> {
  const mode = currentMode()
  if (mode === 'off') {
    recordResolution('disabled', mode)
    throw valuePolicyDisabled()
  }
  return serializeCurrentPolicy(await resolveActiveCnyPolicy())
}

export async function quoteOfferPricing(
  db: DbClient,
  pointsAmount: number,
): Promise<OrderPricingDto | undefined> {
  if (!isEnabledMode(currentMode())) return undefined
  const policy = await resolveActiveCnyPolicy(db)
  const referenceAmountAtomic = convertOfferPrice(policy, pointsAmount)
  return toOrderPricingDto(policy, pointsAmount, referenceAmountAtomic)
}

function policyMatchesExpected(
  policy: ResolvedValuePolicy,
  expectedValuePolicyId: string,
): boolean {
  return policy.id === expectedValuePolicyId
    && policy.referenceAssetCode === REFERENCE_ASSET_CODE
    && policy.effectiveAt.getTime() <= Date.now()
}

export async function resolvePricingForOrder(
  db: DbClient,
  input: {
    pointsAmount: number
    expectedValuePolicyId?: string
  },
): Promise<OrderPricingContext | undefined> {
  const mode = currentMode()
  if (mode === 'off') return undefined

  if (mode === 'enforce' && (input.expectedValuePolicyId == null || input.expectedValuePolicyId === '')) {
    throw valuePolicyRequired()
  }

  const policy = await resolveActiveCnyPolicy(db, { lock: true })

  if (input.expectedValuePolicyId != null && input.expectedValuePolicyId !== '') {
    if (!policyMatchesExpected(policy, input.expectedValuePolicyId)) {
      valuePolicyChangedTotal.inc()
      throw valuePolicyChanged()
    }
  }

  return {
    policy,
    pointsAmountAtomic: BigInt(input.pointsAmount),
    referenceAmountAtomic: convertOfferPrice(policy, input.pointsAmount),
  }
}

export async function createOrderPricingSnapshot(
  db: DbClient,
  input: {
    orderId: number
    orderPrice: number
    context: OrderPricingContext
  },
): Promise<OrderPricingDto> {
  const { context } = input
  if (context.pointsAmountAtomic !== BigInt(input.orderPrice)) {
    orderPricingSnapshotFailureTotal.inc()
    logger.error({
      event: 'order_pricing_snapshot_price_mismatch',
      orderId: input.orderId,
      policyId: context.policy.id,
      orderPrice: input.orderPrice,
    }, 'pricing snapshot points do not match order price')
    throw valuePolicyDataInvalid('订单定价快照与订单价格不一致')
  }

  try {
    await db.orderPricingSnapshot.create({
      data: {
        orderId: input.orderId,
        pointsAssetCode: context.policy.pointAssetCode,
        pointsAmountAtomic: context.pointsAmountAtomic,
        valuePolicyId: context.policy.id,
        referenceAssetCode: context.policy.referenceAssetCode,
        referenceAmountAtomic: context.referenceAmountAtomic,
        roundingMode: context.policy.roundingMode,
      },
    })
  } catch (err) {
    orderPricingSnapshotFailureTotal.inc()
    logger.error({
      event: 'order_pricing_snapshot_create_failed',
      orderId: input.orderId,
      policyId: context.policy.id,
      err,
    }, 'failed to persist order pricing snapshot')
    throw err
  }

  orderPricingSnapshotCreatedTotal.inc()
  return toOrderPricingDto(context.policy, input.orderPrice, context.referenceAmountAtomic)
}
