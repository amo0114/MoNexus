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
}

function prismaError(message: string): Error {
  const err = new Error(message)
  err.name = 'ValuePolicyGovernanceError'
  return err
}

async function createDraftValuePolicyInTx(
  tx: Prisma.TransactionClient,
  input: DraftValuePolicyInput,
): Promise<ValuePolicy> {
  await lockValuePolicyGovernance(tx)
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
    },
  })
}

async function approveValuePolicyInTx(
  tx: Prisma.TransactionClient,
  id: string,
  approvedAt: Date,
): Promise<ValuePolicy> {
  await lockValuePolicyGovernance(tx)
  const current = await tx.valuePolicy.findUnique({ where: { id } })
  if (!current) throw prismaError('value_policy_not_found')
  if (current.status !== 'draft') throw prismaError('value_policy_invalid_status_transition')
  return tx.valuePolicy.update({
    where: { id },
    data: { status: 'approved', approvedAt },
  })
}

async function scheduleValuePolicyInTx(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<ValuePolicy> {
  await lockValuePolicyGovernance(tx)
  const current = await tx.valuePolicy.findUnique({ where: { id } })
  if (!current) throw prismaError('value_policy_not_found')
  if (current.status !== 'approved') throw prismaError('value_policy_invalid_status_transition')
  return tx.valuePolicy.update({
    where: { id },
    data: { status: 'scheduled' },
  })
}

async function activateValuePolicyInTx(
  tx: Prisma.TransactionClient,
  id: string,
  activatedAt: Date,
): Promise<ValuePolicy> {
  await lockValuePolicyGovernance(tx)
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
    data: { status: 'active', activatedAt },
  })
}

async function retireValuePolicyInTx(
  tx: Prisma.TransactionClient,
  id: string,
  retiredAt: Date,
): Promise<ValuePolicy> {
  await lockValuePolicyGovernance(tx)
  const current = await tx.valuePolicy.findUnique({ where: { id } })
  if (!current) throw prismaError('value_policy_not_found')
  if (current.status !== 'active') throw prismaError('value_policy_retire_requires_active')
  return tx.valuePolicy.update({
    where: { id },
    data: { status: 'retired', retiredAt },
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
  approvedAt: Date = new Date(),
): Promise<ValuePolicy> {
  return withGovernanceTransaction(db, tx => approveValuePolicyInTx(tx, id, approvedAt))
}

export async function scheduleValuePolicy(db: DbClient, id: string): Promise<ValuePolicy> {
  return withGovernanceTransaction(db, tx => scheduleValuePolicyInTx(tx, id))
}

export async function activateValuePolicy(
  db: DbClient,
  id: string,
  activatedAt: Date = new Date(),
): Promise<ValuePolicy> {
  return withGovernanceTransaction(db, tx => activateValuePolicyInTx(tx, id, activatedAt))
}

export async function retireValuePolicy(
  db: DbClient,
  id: string,
  retiredAt: Date = new Date(),
): Promise<ValuePolicy> {
  return withGovernanceTransaction(db, tx => retireValuePolicyInTx(tx, id, retiredAt))
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

    await approveValuePolicyInTx(tx, draft.id, approvedAt)
    if (target === 'approved') {
      return tx.valuePolicy.findUniqueOrThrow({ where: { id: draft.id } })
    }

    await scheduleValuePolicyInTx(tx, draft.id)
    if (target === 'scheduled') {
      return tx.valuePolicy.findUniqueOrThrow({ where: { id: draft.id } })
    }

    const activatedAt = now.getTime() >= effectiveAt.getTime() ? now : effectiveAt
    await activateValuePolicyInTx(tx, draft.id, activatedAt)
    if (target === 'active') {
      return tx.valuePolicy.findUniqueOrThrow({ where: { id: draft.id } })
    }

    return retireValuePolicyInTx(tx, draft.id, now)
  })
}
