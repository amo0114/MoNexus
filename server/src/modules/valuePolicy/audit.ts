import type { Prisma, PrismaClient } from '@prisma/client'
import { config } from '../../config/index.js'
import { valuePolicyMissingSnapshotOrders } from '../../lib/metrics.js'
import {
  POINT_ASSET_CODE,
  POINT_ASSET_SCALE,
  REFERENCE_ASSET_CODE,
  REFERENCE_ASSET_SCALE,
} from './constants.js'
import { convertPointsToReferenceAtomic } from './money.js'

type DbClient = PrismaClient | Prisma.TransactionClient

export type ValuePolicyAuditSeverity = 'P0' | 'P1'

export type ValuePolicyAuditFinding = {
  code: string
  severity: ValuePolicyAuditSeverity
  message: string
  details?: Record<string, unknown>
}

export type ValuePolicyAuditReport = {
  ok: boolean
  mode: string
  generatedAt: string
  summary: {
    activePolicyCount: number
    snapshotCount: number
    findingCount: number
    missingSnapshotSince: string | null
    missingSnapshotCheck: 'ran' | 'skipped_off' | 'skipped_no_since'
  }
  findings: ValuePolicyAuditFinding[]
}

export type ValuePolicyAuditOptions = {
  /** Inclusive lower bound for the enabled-mode missing-snapshot window. */
  since?: Date
}

function finding(
  code: string,
  severity: ValuePolicyAuditSeverity,
  message: string,
  details?: Record<string, unknown>,
): ValuePolicyAuditFinding {
  return { code, severity, message, details }
}

/**
 * Read-only ValuePolicy audit. Never updates, deletes, or repairs rows.
 */
export async function auditValuePolicies(
  db: DbClient,
  options: ValuePolicyAuditOptions = {},
): Promise<ValuePolicyAuditReport> {
  const findings: ValuePolicyAuditFinding[] = []
  const mode = config.pointValuePolicyMode
  let missingSnapshotCheck: ValuePolicyAuditReport['summary']['missingSnapshotCheck'] =
    mode === 'shadow' || mode === 'enforce' ? 'skipped_no_since' : 'skipped_off'
  let missingSnapshotSince: string | null = null

  const activePolicies = await db.valuePolicy.findMany({
    where: { status: 'active' },
    include: { pointAsset: true, referenceAsset: true },
  })

  if (activePolicies.length > 1) {
    findings.push(finding(
      'multiple_active_policies',
      'P0',
      'more than one active ValuePolicy exists',
      { ids: activePolicies.map(policy => policy.id), count: activePolicies.length },
    ))
  }

  for (const policy of activePolicies) {
    if (policy.referenceAssetCode !== REFERENCE_ASSET_CODE) {
      findings.push(finding(
        'illegal_active_reference_asset',
        'P0',
        'active policy is not CNY-denominated',
        { policyId: policy.id, referenceAssetCode: policy.referenceAssetCode },
      ))
    }
    if (policy.pointAssetCode !== POINT_ASSET_CODE) {
      findings.push(finding(
        'illegal_active_point_asset',
        'P0',
        'active policy point asset is not RP',
        { policyId: policy.id, pointAssetCode: policy.pointAssetCode },
      ))
    }
    if (
      policy.pointAsset.kind !== 'reward_point'
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
      || policy.retiredAt != null
    ) {
      findings.push(finding(
        'active_policy_invariant_violated',
        'P0',
        'active policy asset, ratio, or enablement invariant is violated',
        { policyId: policy.id },
      ))
    }
    if (
      policy.approvedAt == null
      || policy.activatedAt == null
      || policy.createdAt > policy.approvedAt
      || policy.approvedAt > policy.effectiveAt
      || policy.createdAt > policy.activatedAt
      || policy.activatedAt < policy.effectiveAt
    ) {
      findings.push(finding(
        'active_policy_time_invariant_violated',
        'P0',
        'active policy timestamp order is invalid',
        { policyId: policy.id },
      ))
    }
  }

  const illegalProductionAssets = await db.valuePolicy.findMany({
    where: {
      status: 'active',
      referenceAssetCode: { in: ['USD', 'USDT'] },
    },
    select: { id: true, referenceAssetCode: true },
  })
  for (const policy of illegalProductionAssets) {
    findings.push(finding(
      'illegal_production_active_usd_usdt',
      'P0',
      'active USD/USDT value policy is forbidden in Phase 1',
      { policyId: policy.id, referenceAssetCode: policy.referenceAssetCode },
    ))
  }

  const snapshots = await db.orderPricingSnapshot.findMany({
    include: {
      order: { select: { id: true, price: true, createdAt: true } },
      valuePolicy: true,
    },
  })

  for (const snapshot of snapshots) {
    if (snapshot.pointsAmountAtomic !== BigInt(snapshot.order.price)) {
      findings.push(finding(
        'snapshot_order_price_mismatch',
        'P0',
        'snapshot points do not match Order.price',
        {
          orderId: snapshot.orderId,
          orderPrice: snapshot.order.price,
          pointsAmountAtomic: snapshot.pointsAmountAtomic.toString(),
        },
      ))
    }

    const expected = convertPointsToReferenceAtomic({
      pointsAtomic: snapshot.pointsAmountAtomic,
      referenceAtomicPerPointNumerator: snapshot.valuePolicy.referenceAtomicPerPointNumerator,
      referenceAtomicPerPointDenominator: snapshot.valuePolicy.referenceAtomicPerPointDenominator,
      roundingMode: snapshot.valuePolicy.roundingMode,
    })
    if (snapshot.referenceAmountAtomic !== expected) {
      findings.push(finding(
        'snapshot_policy_ratio_mismatch',
        'P0',
        'snapshot reference amount does not match ValuePolicy ratio',
        {
          orderId: snapshot.orderId,
          policyId: snapshot.valuePolicyId,
          expected: expected.toString(),
          actual: snapshot.referenceAmountAtomic.toString(),
        },
      ))
    }
  }

  if ((mode === 'shadow' || mode === 'enforce') && options.since) {
    missingSnapshotCheck = 'ran'
    missingSnapshotSince = options.since.toISOString()
    const missing = await db.order.findMany({
      where: {
        createdAt: { gte: options.since },
        pricingSnapshot: { is: null },
      },
      select: { id: true, createdAt: true },
    })
    valuePolicyMissingSnapshotOrders.set(missing.length)
    if (missing.length > 0) {
      findings.push(finding(
        'enabled_mode_order_missing_snapshot',
        'P0',
        'enabled-window orders exist without a pricing snapshot',
        {
          orderIds: missing.map(order => order.id),
          count: missing.length,
          since: missingSnapshotSince,
        },
      ))
    }
  } else {
    valuePolicyMissingSnapshotOrders.set(0)
  }

  return {
    ok: findings.length === 0,
    mode,
    generatedAt: new Date().toISOString(),
    summary: {
      activePolicyCount: activePolicies.length,
      snapshotCount: snapshots.length,
      findingCount: findings.length,
      missingSnapshotSince,
      missingSnapshotCheck,
    },
    findings,
  }
}
