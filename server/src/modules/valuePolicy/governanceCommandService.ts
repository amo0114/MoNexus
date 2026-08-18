import { createHash } from 'node:crypto'
import type { Prisma, ValuePolicy, ValuePolicyStatus } from '@prisma/client'
import { config } from '../../config/index.js'
import { HttpError } from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'
import {
  activateValuePolicy,
  approveValuePolicy,
  createDraftValuePolicy,
  lockValuePolicyGovernance,
  retireValuePolicy,
  scheduleValuePolicy,
} from './governance.js'
import type {
  CreateValuePolicyGovernanceInput,
  TransitionValuePolicyGovernanceInput,
} from './governanceSchema.js'

type GovernanceAction = 'create' | 'approve' | 'schedule' | 'activate' | 'retire'
const MIN_EFFECTIVE_LEAD_MS = 7 * 24 * 60 * 60 * 1000

export type ValuePolicyGovernanceDto = {
  id: string
  version: number
  status: ValuePolicyStatus
  pointAssetCode: string
  referenceAssetCode: string
  referenceAtomicPerPointNumerator: string
  referenceAtomicPerPointDenominator: string
  roundingMode: string
  effectiveAt: string
  approvedAt: string | null
  activatedAt: string | null
  retiredAt: string | null
  createdAt: string
  createdByUserId: number
  approvedByUserId: number | null
  scheduledByUserId: number | null
  activatedByUserId: number | null
  retiredByUserId: number | null
  d02DecisionRecordRef: string
  d02DecisionRecordSha256: string
  d03DecisionRecordRef: string
  d03DecisionRecordSha256: string
  disclosureVersion: string
}

export type GovernanceCommandResult = {
  replayed: boolean
  policy: ValuePolicyGovernanceDto
}

function toDto(policy: ValuePolicy): ValuePolicyGovernanceDto {
  return {
    id: policy.id,
    version: policy.version,
    status: policy.status,
    pointAssetCode: policy.pointAssetCode,
    referenceAssetCode: policy.referenceAssetCode,
    referenceAtomicPerPointNumerator: policy.referenceAtomicPerPointNumerator.toString(),
    referenceAtomicPerPointDenominator: policy.referenceAtomicPerPointDenominator.toString(),
    roundingMode: policy.roundingMode,
    effectiveAt: policy.effectiveAt.toISOString(),
    approvedAt: policy.approvedAt?.toISOString() ?? null,
    activatedAt: policy.activatedAt?.toISOString() ?? null,
    retiredAt: policy.retiredAt?.toISOString() ?? null,
    createdAt: policy.createdAt.toISOString(),
    createdByUserId: policy.createdByUserId,
    approvedByUserId: policy.approvedByUserId,
    scheduledByUserId: policy.scheduledByUserId,
    activatedByUserId: policy.activatedByUserId,
    retiredByUserId: policy.retiredByUserId,
    d02DecisionRecordRef: policy.d02DecisionRecordRef,
    d02DecisionRecordSha256: policy.d02DecisionRecordSha256,
    d03DecisionRecordRef: policy.d03DecisionRecordRef,
    d03DecisionRecordSha256: policy.d03DecisionRecordSha256,
    disclosureVersion: policy.disclosureVersion,
  }
}

function payloadHash(action: GovernanceAction, policyId: string, payload: unknown): string {
  const canonical = JSON.stringify(['value-policy-governance-v1', action, policyId, payload])
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export function isGovernanceEnvironmentAllowed(nodeEnv: string, deployEnv: string): boolean {
  return nodeEnv !== 'production' || deployEnv === 'staging'
}

function assertGovernanceEnvironment(): void {
  if (!isGovernanceEnvironmentAllowed(config.nodeEnv, config.monexusDeployEnv)) {
    throw new HttpError(
      403,
      'VALUE_POLICY_GOVERNANCE_DISABLED',
      '生产 ValuePolicy 治理入口尚未解除门禁',
    )
  }
}

async function assertAdminActor(tx: Prisma.TransactionClient, actorUserId: number): Promise<void> {
  const actor = await tx.user.findUnique({
    where: { id: actorUserId },
    select: { role: true, status: true },
  })
  if (!actor || actor.role !== 'admin' || actor.status !== '正常') {
    throw new HttpError(403, 'FORBIDDEN', 'ValuePolicy 治理仅允许有效管理员执行')
  }
}

function mapGovernanceError(error: unknown): never {
  if (error instanceof HttpError) throw error
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'P2002'
  ) {
    throw new HttpError(409, 'VALUE_POLICY_GOVERNANCE_CONFLICT', 'ValuePolicy 或治理命令已存在')
  }
  if (error instanceof Error) {
    if (error.message.includes('value_policy_not_found')) {
      throw new HttpError(404, 'VALUE_POLICY_GOVERNANCE_NOT_FOUND', 'ValuePolicy 不存在')
    }
    if (error.message.includes('value_policy_approve_requires_independent_actor')) {
      throw new HttpError(409, 'VALUE_POLICY_MAKER_CHECKER_REQUIRED', '创建人与审批人必须为不同管理员')
    }
    if (error.message.includes('value_policy_')) {
      throw new HttpError(409, 'VALUE_POLICY_GOVERNANCE_CONFLICT', 'ValuePolicy 当前状态不允许该操作')
    }
  }
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error.code === 'P2003' || error.code === 'P2004')
  ) {
    throw new HttpError(409, 'VALUE_POLICY_GOVERNANCE_CONFLICT', 'ValuePolicy 数据库约束拒绝该操作')
  }
  throw error
}

async function replayOrConflict(
  tx: Prisma.TransactionClient,
  actorUserId: number,
  idempotencyKey: string,
  expectedHash: string,
): Promise<GovernanceCommandResult | null> {
  const existing = await tx.valuePolicyGovernanceCommand.findUnique({
    where: { actorUserId_idempotencyKey: { actorUserId, idempotencyKey } },
  })
  if (!existing) return null
  if (existing.payloadHash !== expectedHash) {
    throw new HttpError(409, 'VALUE_POLICY_IDEMPOTENCY_CONFLICT', '同一 Idempotency-Key 对应了不同治理请求')
  }
  return { replayed: true, policy: existing.result as unknown as ValuePolicyGovernanceDto }
}

async function persistCommand(
  tx: Prisma.TransactionClient,
  input: {
    action: GovernanceAction
    actorUserId: number
    idempotencyKey: string
    hash: string
    policy: ValuePolicy
    fromStatus: ValuePolicyStatus | null
    reason: string
  },
): Promise<GovernanceCommandResult> {
  const dto = toDto(input.policy)
  const command = await tx.valuePolicyGovernanceCommand.create({
    data: {
      valuePolicyId: input.policy.id,
      actorUserId: input.actorUserId,
      idempotencyKey: input.idempotencyKey,
      payloadHash: input.hash,
      action: input.action,
      result: dto as unknown as Prisma.InputJsonObject,
    },
  })
  await tx.valuePolicyGovernanceEvent.create({
    data: {
      valuePolicyId: input.policy.id,
      commandId: command.id,
      actorUserId: input.actorUserId,
      action: input.action,
      fromStatus: input.fromStatus,
      toStatus: input.policy.status,
      reason: input.reason,
    },
  })
  await tx.adminLog.create({
    data: {
      adminUserId: input.actorUserId,
      action: `value_policy.${input.action}`,
      targetType: 'ValuePolicy',
      targetId: null,
      detail: JSON.stringify({
        policyId: input.policy.id,
        commandId: command.id,
        fromStatus: input.fromStatus,
        toStatus: input.policy.status,
      }),
    },
  })
  return { replayed: false, policy: dto }
}

export async function createPolicyCommand(
  actorUserId: number,
  idempotencyKey: string,
  input: CreateValuePolicyGovernanceInput,
): Promise<GovernanceCommandResult> {
  assertGovernanceEnvironment()
  if (new Date(input.effectiveAt).getTime() < Date.now() + MIN_EFFECTIVE_LEAD_MS) {
    throw new HttpError(
      400,
      'VALUE_POLICY_EFFECTIVE_AT_INVALID',
      'ValuePolicy 生效时间必须至少提前 7 天',
    )
  }
  const hash = payloadHash('create', input.id, input)
  try {
    return await prisma.$transaction(async tx => {
      await lockValuePolicyGovernance(tx)
      await assertAdminActor(tx, actorUserId)
      const replay = await replayOrConflict(tx, actorUserId, idempotencyKey, hash)
      if (replay) return replay
      const policy = await createDraftValuePolicy(tx, {
        id: input.id,
        version: input.version,
        numerator: BigInt(input.referenceAtomicPerPointNumerator),
        denominator: BigInt(input.referenceAtomicPerPointDenominator),
        effectiveAt: new Date(input.effectiveAt),
        createdByUserId: actorUserId,
        d02DecisionRecordRef: input.d02DecisionRecordRef,
        d02DecisionRecordSha256: input.d02DecisionRecordSha256,
        d03DecisionRecordRef: input.d03DecisionRecordRef,
        d03DecisionRecordSha256: input.d03DecisionRecordSha256,
        disclosureVersion: input.disclosureVersion,
      })
      return persistCommand(tx, {
        action: 'create', actorUserId, idempotencyKey, hash, policy,
        fromStatus: null, reason: input.reason,
      })
    })
  } catch (error) {
    return mapGovernanceError(error)
  }
}

export async function transitionPolicyCommand(
  action: Exclude<GovernanceAction, 'create'>,
  policyId: string,
  actorUserId: number,
  idempotencyKey: string,
  input: TransitionValuePolicyGovernanceInput,
): Promise<GovernanceCommandResult> {
  assertGovernanceEnvironment()
  const hash = payloadHash(action, policyId, input)
  try {
    return await prisma.$transaction(async tx => {
      await lockValuePolicyGovernance(tx)
      await assertAdminActor(tx, actorUserId)
      const replay = await replayOrConflict(tx, actorUserId, idempotencyKey, hash)
      if (replay) return replay
      const current = await tx.valuePolicy.findUnique({ where: { id: policyId } })
      if (!current) {
        throw new Error('value_policy_not_found')
      }
      const policy = action === 'approve'
        ? await approveValuePolicy(tx, policyId, actorUserId)
        : action === 'schedule'
          ? await scheduleValuePolicy(tx, policyId, actorUserId)
          : action === 'activate'
            ? await activateValuePolicy(tx, policyId, actorUserId)
            : await retireValuePolicy(tx, policyId, actorUserId)
      return persistCommand(tx, {
        action, actorUserId, idempotencyKey, hash, policy,
        fromStatus: current.status, reason: input.reason,
      })
    })
  } catch (error) {
    return mapGovernanceError(error)
  }
}
