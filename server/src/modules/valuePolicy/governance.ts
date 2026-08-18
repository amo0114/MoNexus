import type { Prisma, PrismaClient, ValuePolicy, ValuePolicyStatus } from '@prisma/client'
import { POINT_ASSET_CODE, REFERENCE_ASSET_CODE } from './constants.js'

type DbClient = PrismaClient | Prisma.TransactionClient

/**
 * Shared transaction advisory lock for ValuePolicy / AssetDefinition
 * invariant changes. Must match pg_advisory_xact_lock keys in:
 * - 20260817180000_add_value_policy_foundation
 * - 20260818120000_value_policy_phase1_closure
 *
 * Application order paths take this lock before reading expected/current
 * policies. Triggers take the same lock. Neither path then waits on the
 * other table's row lock, so there is no 40P01 cycle.
 */
export const VALUE_POLICY_GOVERNANCE_LOCK = { classid: 88170001, objid: 1 } as const

export async function lockValuePolicyGovernance(db: DbClient): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(88170001, 1)`
}

export type DraftValuePolicyInput = {
  id: string
  version: number
  pointAssetCode?: string
  referenceAssetCode?: string
  numerator?: bigint
  denominator?: bigint
  effectiveAt: Date
  createdAt?: Date
}

function prismaError(message: string): Error {
  const err = new Error(message)
  err.name = 'ValuePolicyGovernanceError'
  return err
}

export async function createDraftValuePolicy(
  db: DbClient,
  input: DraftValuePolicyInput,
): Promise<ValuePolicy> {
  await lockValuePolicyGovernance(db)
  return db.valuePolicy.create({
    data: {
      id: input.id,
      version: input.version,
      pointAssetCode: input.pointAssetCode ?? POINT_ASSET_CODE,
      referenceAssetCode: input.referenceAssetCode ?? REFERENCE_ASSET_CODE,
      referenceAtomicPerPointNumerator: input.numerator ?? 1n,
      referenceAtomicPerPointDenominator: input.denominator ?? 1n,
      roundingMode: 'HALF_EVEN',
      status: 'draft',
      effectiveAt: input.effectiveAt,
      createdAt: input.createdAt ?? new Date(),
      approvedAt: null,
      activatedAt: null,
      retiredAt: null,
    },
  })
}

export async function approveValuePolicy(
  db: DbClient,
  id: string,
  approvedAt: Date = new Date(),
): Promise<ValuePolicy> {
  await lockValuePolicyGovernance(db)
  const current = await db.valuePolicy.findUnique({ where: { id } })
  if (!current) throw prismaError('value_policy_not_found')
  if (current.status !== 'draft') throw prismaError('value_policy_invalid_status_transition')
  return db.valuePolicy.update({
    where: { id },
    data: { status: 'approved', approvedAt },
  })
}

export async function scheduleValuePolicy(db: DbClient, id: string): Promise<ValuePolicy> {
  await lockValuePolicyGovernance(db)
  const current = await db.valuePolicy.findUnique({ where: { id } })
  if (!current) throw prismaError('value_policy_not_found')
  if (current.status !== 'approved') throw prismaError('value_policy_invalid_status_transition')
  return db.valuePolicy.update({
    where: { id },
    data: { status: 'scheduled' },
  })
}

export async function activateValuePolicy(
  db: DbClient,
  id: string,
  activatedAt: Date = new Date(),
): Promise<ValuePolicy> {
  await lockValuePolicyGovernance(db)
  const current = await db.valuePolicy.findUnique({
    where: { id },
    include: { pointAsset: true, referenceAsset: true },
  })
  if (!current) throw prismaError('value_policy_not_found')
  if (current.status !== 'scheduled') throw prismaError('value_policy_invalid_activation')
  if (activatedAt.getTime() < current.effectiveAt.getTime() || Date.now() < current.effectiveAt.getTime()) {
    throw prismaError('value_policy_effective_at_not_reached')
  }
  const assetsOk =
    current.pointAsset.enabled
    && current.pointAsset.retiredAt == null
    && current.referenceAsset.enabled
    && current.referenceAsset.retiredAt == null
  if (!assetsOk) throw prismaError('value_policy_active_asset_must_be_enabled')

  return db.valuePolicy.update({
    where: { id },
    data: { status: 'active', activatedAt },
  })
}

export async function retireValuePolicy(
  db: DbClient,
  id: string,
  retiredAt: Date = new Date(),
): Promise<ValuePolicy> {
  await lockValuePolicyGovernance(db)
  const current = await db.valuePolicy.findUnique({ where: { id } })
  if (!current) throw prismaError('value_policy_not_found')
  if (current.status !== 'active') throw prismaError('value_policy_retire_requires_active')
  return db.valuePolicy.update({
    where: { id },
    data: { status: 'retired', retiredAt },
  })
}

export type ProvisionValuePolicyInput = DraftValuePolicyInput & {
  status?: ValuePolicyStatus
}

/**
 * Test / staging helper. Walks the only legal chain:
 * draft → approved → scheduled → active → retired.
 * Never inserts an active row and never disables triggers.
 */
export async function provisionValuePolicy(
  db: DbClient,
  input: ProvisionValuePolicyInput,
): Promise<ValuePolicy> {
  const target = input.status ?? 'active'
  const now = new Date()
  const effectiveAt = input.effectiveAt
  const createdAt = input.createdAt
    ?? (effectiveAt.getTime() <= now.getTime() ? effectiveAt : now)
  const approvedAt = createdAt.getTime() <= effectiveAt.getTime() ? createdAt : effectiveAt

  const draft = await createDraftValuePolicy(db, {
    ...input,
    effectiveAt,
    createdAt,
  })
  if (target === 'draft') return draft

  const approved = await approveValuePolicy(db, draft.id, approvedAt)
  if (target === 'approved') return approved

  const scheduled = await scheduleValuePolicy(db, draft.id)
  if (target === 'scheduled') return scheduled

  const activatedAt = now.getTime() >= effectiveAt.getTime() ? now : effectiveAt
  const active = await activateValuePolicy(db, draft.id, activatedAt)
  if (target === 'active') return active

  return retireValuePolicy(db, draft.id, now)
}
