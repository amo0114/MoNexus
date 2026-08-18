import type { Prisma, PrismaClient, ValuePolicy, ValuePolicyStatus } from '@prisma/client'
import { POINT_ASSET_CODE, REFERENCE_ASSET_CODE } from './constants.js'

type DbClient = PrismaClient | Prisma.TransactionClient

/**
 * Shared transaction advisory lock for ValuePolicy / AssetDefinition
 * invariant changes. Must match pg_advisory_xact_lock keys in:
 * - 20260817180000_add_value_policy_foundation
 * - 20260818120000_value_policy_phase1_closure
 * - 20260818140000_value_policy_asset_share_before_advisory
 *
 * The lock is transaction-scoped. Callers MUST hold an open transaction;
 * a bare PrismaClient implicit transaction would release the lock at the
 * end of the SELECT/EXECUTE statement.
 */
export const VALUE_POLICY_GOVERNANCE_LOCK = { classid: 88170001, objid: 1 } as const

export function isPrismaClient(db: DbClient): db is PrismaClient {
  return typeof (db as PrismaClient).$connect === 'function'
    && typeof (db as PrismaClient).$transaction === 'function'
}

export async function withGovernanceTransaction<T>(
  db: DbClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (isPrismaClient(db)) {
    return db.$transaction(tx => fn(tx))
  }
  return fn(db)
}

export async function lockValuePolicyGovernance(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(88170001, 1)`
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
  createdByUserId: number
  d02DecisionRecordRef: string
  d02DecisionRecordSha256: string
  d03DecisionRecordRef: string
  d03DecisionRecordSha256: string
  disclosureVersion: string
}

function prismaError(message: string): Error {
  const err = new Error(message)
  err.name = 'ValuePolicyGovernanceError'
  return err
}

async function assertGovernanceActor(tx: Prisma.TransactionClient, actorUserId: number): Promise<void> {
  const actor = await tx.user.findUnique({
    where: { id: actorUserId },
    select: { role: true, status: true },
  })
  if (!actor || actor.role !== 'admin' || actor.status !== '正常') {
    throw prismaError('value_policy_actor_must_be_active_admin')
  }
}

async function createDraftValuePolicyInTx(
  tx: Prisma.TransactionClient,
  input: DraftValuePolicyInput,
): Promise<ValuePolicy> {
  await lockValuePolicyGovernance(tx)
  await assertGovernanceActor(tx, input.createdByUserId)
  return tx.valuePolicy.create({
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
      createdByUserId: input.createdByUserId,
      approvedByUserId: null,
      scheduledByUserId: null,
      activatedByUserId: null,
      retiredByUserId: null,
      d02DecisionRecordRef: input.d02DecisionRecordRef,
      d02DecisionRecordSha256: input.d02DecisionRecordSha256,
      d03DecisionRecordRef: input.d03DecisionRecordRef,
      d03DecisionRecordSha256: input.d03DecisionRecordSha256,
      disclosureVersion: input.disclosureVersion,
    },
  })
}

async function approveValuePolicyInTx(
  tx: Prisma.TransactionClient,
  id: string,
  approvedByUserId: number,
  approvedAt: Date,
): Promise<ValuePolicy> {
  await lockValuePolicyGovernance(tx)
  await assertGovernanceActor(tx, approvedByUserId)
  const current = await tx.valuePolicy.findUnique({ where: { id } })
  if (!current) throw prismaError('value_policy_not_found')
  if (current.status !== 'draft') throw prismaError('value_policy_invalid_status_transition')
  if (current.createdByUserId === approvedByUserId) {
    throw prismaError('value_policy_approve_requires_independent_actor')
  }
  return tx.valuePolicy.update({
    where: { id },
    data: { status: 'approved', approvedAt, approvedByUserId },
  })
}

async function scheduleValuePolicyInTx(
  tx: Prisma.TransactionClient,
  id: string,
  scheduledByUserId: number,
): Promise<ValuePolicy> {
  await lockValuePolicyGovernance(tx)
  await assertGovernanceActor(tx, scheduledByUserId)
  const current = await tx.valuePolicy.findUnique({ where: { id } })
  if (!current) throw prismaError('value_policy_not_found')
  if (current.status !== 'approved') throw prismaError('value_policy_invalid_status_transition')
  return tx.valuePolicy.update({
    where: { id },
    data: { status: 'scheduled', scheduledByUserId },
  })
}

async function activateValuePolicyInTx(
  tx: Prisma.TransactionClient,
  id: string,
  activatedByUserId: number,
  activatedAt: Date,
): Promise<ValuePolicy> {
  await lockValuePolicyGovernance(tx)
  await assertGovernanceActor(tx, activatedByUserId)
  const current = await tx.valuePolicy.findUnique({
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

  return tx.valuePolicy.update({
    where: { id },
    data: { status: 'active', activatedAt, activatedByUserId },
  })
}

async function retireValuePolicyInTx(
  tx: Prisma.TransactionClient,
  id: string,
  retiredByUserId: number,
  retiredAt: Date,
): Promise<ValuePolicy> {
  await lockValuePolicyGovernance(tx)
  await assertGovernanceActor(tx, retiredByUserId)
  const current = await tx.valuePolicy.findUnique({ where: { id } })
  if (!current) throw prismaError('value_policy_not_found')
  if (current.status !== 'active') throw prismaError('value_policy_retire_requires_active')
  return tx.valuePolicy.update({
    where: { id },
    data: { status: 'retired', retiredAt, retiredByUserId },
  })
}

export async function createDraftValuePolicy(
  db: DbClient,
  input: DraftValuePolicyInput,
): Promise<ValuePolicy> {
  return withGovernanceTransaction(db, tx => createDraftValuePolicyInTx(tx, input))
}

export async function approveValuePolicy(
  db: DbClient,
  id: string,
  approvedByUserId: number,
  approvedAt: Date = new Date(),
): Promise<ValuePolicy> {
  return withGovernanceTransaction(db, tx => approveValuePolicyInTx(tx, id, approvedByUserId, approvedAt))
}

export async function scheduleValuePolicy(db: DbClient, id: string, scheduledByUserId: number): Promise<ValuePolicy> {
  return withGovernanceTransaction(db, tx => scheduleValuePolicyInTx(tx, id, scheduledByUserId))
}

export async function activateValuePolicy(
  db: DbClient,
  id: string,
  activatedByUserId: number,
  activatedAt: Date = new Date(),
): Promise<ValuePolicy> {
  return withGovernanceTransaction(db, tx => activateValuePolicyInTx(tx, id, activatedByUserId, activatedAt))
}

export async function retireValuePolicy(
  db: DbClient,
  id: string,
  retiredByUserId: number,
  retiredAt: Date = new Date(),
): Promise<ValuePolicy> {
  return withGovernanceTransaction(db, tx => retireValuePolicyInTx(tx, id, retiredByUserId, retiredAt))
}

export type ProvisionValuePolicyInput = DraftValuePolicyInput & {
  status?: ValuePolicyStatus
  approvedByUserId: number
  scheduledByUserId?: number
  activatedByUserId?: number
  retiredByUserId?: number
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
  return withGovernanceTransaction(db, async tx => {
    const target = input.status ?? 'active'
    const now = new Date()
    const effectiveAt = input.effectiveAt
    const createdAt = input.createdAt
      ?? (effectiveAt.getTime() <= now.getTime() ? effectiveAt : now)
    const approvedAt = createdAt.getTime() <= effectiveAt.getTime() ? createdAt : effectiveAt

    const draft = await createDraftValuePolicyInTx(tx, {
      ...input,
      effectiveAt,
      createdAt,
    })
    if (target === 'draft') return draft

    await approveValuePolicyInTx(tx, draft.id, input.approvedByUserId, approvedAt)
    if (target === 'approved') {
      return tx.valuePolicy.findUniqueOrThrow({ where: { id: draft.id } })
    }

    await scheduleValuePolicyInTx(tx, draft.id, input.scheduledByUserId ?? input.approvedByUserId)
    if (target === 'scheduled') {
      return tx.valuePolicy.findUniqueOrThrow({ where: { id: draft.id } })
    }

    const activatedAt = now.getTime() >= effectiveAt.getTime() ? now : effectiveAt
    await activateValuePolicyInTx(tx, draft.id, input.activatedByUserId ?? input.approvedByUserId, activatedAt)
    if (target === 'active') {
      return tx.valuePolicy.findUniqueOrThrow({ where: { id: draft.id } })
    }

    return retireValuePolicyInTx(tx, draft.id, input.retiredByUserId ?? input.approvedByUserId, now)
  })
}
