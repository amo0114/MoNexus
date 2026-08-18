import type { MoneyRoundingMode, Prisma, PrismaClient } from '@prisma/client'
import { config } from '../../config/index.js'
import { logger } from '../../lib/logger.js'
import {
  orderPricingSnapshotCreatedTotal,
  orderPricingSnapshotFailureTotal,
  orderValuePolicyEnabledCommittedTotal,
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
import {
  POINT_ASSET_CODE,
  POINT_ASSET_SCALE,
  REFERENCE_ASSET_CODE,
  REFERENCE_ASSET_SCALE,
  VALUE_POLICY_DISCLOSURE,
} from './constants.js'
import { lockValuePolicyGovernance } from './governance.js'
import { atomicToDecimalString, convertPointsToReferenceAtomic } from './money.js'

export type PointValuePolicyMode = 'off' | 'shadow' | 'enforce'

export {
  POINT_ASSET_CODE,
  POINT_ASSET_SCALE,
  REFERENCE_ASSET_CODE,
  REFERENCE_ASSET_SCALE,
  VALUE_POLICY_DISCLOSURE,
}

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

function validateResolvedPolicy(policy: PolicyWithAssets): ResolvedValuePolicy {
  if (policyViolatesInvariants(policy)) {
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

const policyInclude = {
  pointAsset: true,
  referenceAsset: true,
} as const

type PolicyWithAssets = Prisma.ValuePolicyGetPayload<{ include: typeof policyInclude }>

function policyViolatesInvariants(policy: PolicyWithAssets): boolean {
  return policy.pointAssetCode !== POINT_ASSET_CODE
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
}

async function loadActiveCnyPolicies(db: DbClient): Promise<PolicyWithAssets[]> {
  return db.valuePolicy.findMany({
    where: {
      status: 'active',
      pointAssetCode: POINT_ASSET_CODE,
      referenceAssetCode: REFERENCE_ASSET_CODE,
    },
    include: policyInclude,
  })
}

function rejectChanged(): never {
  valuePolicyChangedTotal.inc()
  throw valuePolicyChanged()
}

export async function resolveActiveCnyPolicy(
  db: DbClient = prisma,
  options: { lock?: boolean } = {},
): Promise<ResolvedValuePolicy> {
  const mode = currentMode()
  if (options.lock) {
    // Advisory lock only, and only inside an already-open transaction.
    await lockValuePolicyGovernance(db as Prisma.TransactionClient)
  }

  const policies = await loadActiveCnyPolicies(db)

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
  const mode = currentMode()
  if (!isEnabledMode(mode)) {
    recordResolution('disabled', mode)
    return undefined
  }
  const policy = await resolveActiveCnyPolicy(db)
  const referenceAmountAtomic = convertOfferPrice(policy, pointsAmount)
  return toOrderPricingDto(policy, pointsAmount, referenceAmountAtomic)
}

function hasExpectedPolicyId(value: string | undefined): value is string {
  return value != null && value !== ''
}

function toPricingContext(policy: ResolvedValuePolicy, pointsAmount: number): OrderPricingContext {
  return {
    policy,
    pointsAmountAtomic: BigInt(pointsAmount),
    referenceAmountAtomic: convertOfferPrice(policy, pointsAmount),
  }
}

/**
 * Frozen Phase 1 closure contract:
 * - A concrete but unusable expectedValuePolicyId is always 409 VALUE_POLICY_CHANGED.
 * - shadow without an ID and without a unique usable active CNY policy is 503.
 * - An existing active CNY row whose internals are corrupt is 500.
 */
export async function resolvePricingForOrder(
  db: Prisma.TransactionClient,
  input: {
    pointsAmount: number
    expectedValuePolicyId?: string
  },
): Promise<OrderPricingContext | undefined> {
  const mode = currentMode()
  if (mode === 'off') {
    recordResolution('disabled', mode)
    return undefined
  }

  if (mode === 'enforce' && !hasExpectedPolicyId(input.expectedValuePolicyId)) {
    throw valuePolicyRequired()
  }

  await lockValuePolicyGovernance(db)

  const expectedId = hasExpectedPolicyId(input.expectedValuePolicyId)
    ? input.expectedValuePolicyId
    : undefined
  const actives = await loadActiveCnyPolicies(db)

  if (actives.length > 1) {
    logger.error({
      event: 'value_policy_multiple_active',
      mode,
      count: actives.length,
    }, 'multiple active CNY value policies detected')
    if (expectedId) rejectChanged()
    recordResolution('multiple', mode)
    throw valuePolicyUnavailable()
  }

  if (actives.length === 1) {
    const current = actives[0]
    if (policyViolatesInvariants(current)) {
      logger.error({
        event: 'value_policy_data_invalid',
        policyId: current.id,
        pointAssetCode: current.pointAssetCode,
        referenceAssetCode: current.referenceAssetCode,
      }, 'active value policy violates internal invariants')
      recordResolution('invalid', mode)
      throw valuePolicyDataInvalid()
    }

    const resolved = validateResolvedPolicy(current)
    if (expectedId && expectedId !== resolved.id) {
      rejectChanged()
    }
    recordResolution('found', mode)
    return toPricingContext(resolved, input.pointsAmount)
  }

  if (expectedId) {
    rejectChanged()
  }

  logger.error({
    event: 'value_policy_unavailable',
    mode,
  }, 'no unique active CNY value policy')
  recordResolution('unavailable', mode)
  throw valuePolicyUnavailable()
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

  return toOrderPricingDto(context.policy, input.orderPrice, context.referenceAmountAtomic)
}

export function recordOrderPricingSnapshotCommitted(): void {
  orderPricingSnapshotCreatedTotal.inc()
}

export function recordOrderPricingSnapshotRolledBack(): void {
  orderPricingSnapshotFailureTotal.inc()
}

export function recordEnabledModeOrderCommitted(): void {
  if (isEnabledMode(currentMode())) {
    orderValuePolicyEnabledCommittedTotal.inc()
  }
}
