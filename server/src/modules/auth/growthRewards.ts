import type { Prisma } from '@prisma/client'
import { conflict, HttpError, notFound } from '../../lib/httpError.js'
import { applyTierBonus, getCurrentTierConfig, resolveTier } from '../../lib/memberTier.js'
import { prisma } from '../../lib/prisma.js'
import { getSystemConfigValue } from '../../lib/systemConfig.js'
import { creditAvailablePoints } from '../points/checkedMutation.js'
import { getShanghaiDayWindow } from './abusePolicy.js'
import {
  recordAbuseEvent,
  type RewardVoidReason,
} from './abuseEvents.js'

const DAY_MS = 24 * 60 * 60 * 1_000
const NORMAL_USER_STATUS = '正常'
const PENDING_REFERRAL_STATES = ['pending_verification', 'qualified'] as const
const VOIDABLE_REWARD_STATES = ['pending_verification', 'held'] as const

export const GROWTH_REWARD_BATCH_SIZE = 100

type ReferralEligibilityUser = {
  id: number
  status: string
  emailVerified: Date | null
  referralSuspended: boolean
  createdAt: Date
}

type LockedInviteRelation = {
  id: number
  inviterId: number
  inviteeId: number
  status: string
}

type LockedGrowthReward = {
  id: number
  recipientUserId: number
  inviteRelationId: number | null
  kind: string
  amount: number
  state: string
  availableAt: Date | null
}

export type GrowthRewardReleaseOutcome =
  | { outcome: 'granted'; rewardId: number }
  | { outcome: 'voided'; rewardId: number; reason: RewardVoidReason }
  | { outcome: 'skipped'; rewardId: number }

function assertBoundedInteger(value: number, min: number, max: number, name: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    // SystemConfig mutations validate these values. A direct database
    // corruption must not silently turn into a more generous reward policy.
    throw new Error(`${name} configuration is invalid`)
  }
  return value
}

function addHoldDays(verifiedAt: Date, holdDays: number) {
  return new Date(verifiedAt.getTime() + holdDays * DAY_MS)
}

function isEligibleReferralInviter(
  inviter: ReferralEligibilityUser,
  minimumAgeDays: number,
  now: Date,
) {
  const requiredAge = assertBoundedInteger(minimumAgeDays, 0, 365, 'referral inviter age')
  return inviter.status === NORMAL_USER_STATUS
    && inviter.emailVerified !== null
    && !inviter.referralSuspended
    && inviter.createdAt.getTime() <= now.getTime() - requiredAge * DAY_MS
}

async function lockUserForGrowthReward(
  tx: Prisma.TransactionClient,
  userId: number,
): Promise<ReferralEligibilityUser | null> {
  const rows = await tx.$queryRaw<ReferralEligibilityUser[]>`
    SELECT "id", "status", "emailVerified", "referralSuspended", "createdAt"
    FROM "User"
    WHERE "id" = ${userId}
    FOR UPDATE`
  return rows[0] ?? null
}

async function lockPendingInviteRelation(
  tx: Prisma.TransactionClient,
  inviteeId: number,
): Promise<LockedInviteRelation | null> {
  const rows = await tx.$queryRaw<LockedInviteRelation[]>`
    SELECT "id", "inviterId", "inviteeId", "status"
    FROM "InviteRelation"
    WHERE "inviteeId" = ${inviteeId}
      AND "status" = 'pending_verification'
    FOR UPDATE`
  return rows[0] ?? null
}

async function lockGrowthReward(
  tx: Prisma.TransactionClient,
  rewardId: number,
): Promise<LockedGrowthReward | null> {
  const rows = await tx.$queryRaw<LockedGrowthReward[]>`
    SELECT "id", "recipientUserId", "inviteRelationId", "kind", "amount", "state", "availableAt"
    FROM "GrowthReward"
    WHERE "id" = ${rewardId}
    FOR UPDATE`
  return rows[0] ?? null
}

function referralVoidReasonForInviter(inviter: ReferralEligibilityUser | null): RewardVoidReason {
  if (!inviter || inviter.status !== NORMAL_USER_STATUS) return 'recipient_banned'
  if (inviter.referralSuspended) return 'referral_suspended'
  return 'invite_relation_voided'
}

async function transitionReferralToVoided(
  tx: Prisma.TransactionClient,
  input: {
    relationId: number
    inviterId: number
    inviteeId: number
    state: 'pending_verification' | 'held'
    reason: RewardVoidReason
    now: Date
  },
) {
  await tx.inviteRelation.updateMany({
    where: {
      id: input.relationId,
      status: { in: [...PENDING_REFERRAL_STATES] },
    },
    data: {
      status: 'voided',
      voidedAt: input.now,
    },
  })

  const voided = await tx.growthReward.updateMany({
    where: {
      inviteRelationId: input.relationId,
      state: input.state,
    },
    data: {
      state: 'voided',
      voidedAt: input.now,
      voidReason: input.reason,
    },
  })

  if (voided.count > 0) {
    await recordAbuseEvent({
      type: 'reward_voided',
      userId: input.inviterId,
      inviterId: input.inviterId,
      inviteeId: input.inviteeId,
      detail: { kind: 'referral', reason: input.reason },
    }, tx)
  }
}

/** Create the held-ledger source row for a newly registered account. */
export async function createRegistrationGrowthReward(
  tx: Prisma.TransactionClient,
  userId: number,
  amount: number,
) {
  const snapshotAmount = assertBoundedInteger(amount, 0, Number.MAX_SAFE_INTEGER, 'registration reward')
  return tx.growthReward.create({
    data: {
      recipientUserId: userId,
      kind: 'registration',
      amount: snapshotAmount,
      state: 'pending_verification',
      dedupeKey: `registration:${userId}`,
    },
  })
}

/**
 * SPEC-INVITE-001 IV-09: create the pending relation and its frozen referral
 * reward for a one-time invite code that this registration transaction has
 * already atomically claimed. The claim step re-checked issuer status and
 * `referralSuspended` under the issuer's row lock; tier and account age were
 * verified when the code was issued, so this path deliberately does not run
 * `isEligibleReferralInviter` again. Any failure here rejects and rolls back
 * the whole registration — there is no silent-degradation branch left.
 *
 * The email-verification qualified/quota/void pipeline below keeps its
 * original eligibility semantics untouched.
 */
export async function createClaimedReferralGrowthReward(
  tx: Prisma.TransactionClient,
  input: {
    inviterId: number
    inviteeId: number
  },
) {
  const relation = await tx.inviteRelation.create({
    data: {
      inviterId: input.inviterId,
      inviteeId: input.inviteeId,
      status: 'pending_verification',
    },
  })

  const inviteReward = assertBoundedInteger(
    await getSystemConfigValue('inviteReward', tx),
    0,
    Number.MAX_SAFE_INTEGER,
    'invite reward',
  )
  const inviterLifetimeResult = await tx.pointLog.aggregate({
    where: { userId: input.inviterId, type: 'in' },
    _sum: { amount: true },
  })
  const tierConfig = await getCurrentTierConfig(tx)
  const inviterTier = resolveTier(inviterLifetimeResult._sum.amount ?? 0, tierConfig.thresholds)
  const { total } = applyTierBonus(inviteReward, inviterTier, tierConfig.bonusBps)

  const reward = await tx.growthReward.create({
    data: {
      recipientUserId: input.inviterId,
      inviteRelationId: relation.id,
      kind: 'referral',
      amount: total,
      state: 'pending_verification',
      dedupeKey: `referral:${relation.id}`,
    },
  })

  return { relation, reward, inviterTier }
}

/**
 * Called only after an authenticated verification token has been atomically
 * claimed. It moves the new account's registration reward to held and makes
 * the pending referral relation compete for the inviter's qualified quota.
 */
export async function holdGrowthRewardsAfterEmailVerification(
  tx: Prisma.TransactionClient,
  input: { userId: number; verifiedAt: Date },
) {
  const holdDays = assertBoundedInteger(
    await getSystemConfigValue('growthRewardHoldDays', tx),
    0,
    30,
    'growth reward hold days',
  )
  const availableAt = addHoldDays(input.verifiedAt, holdDays)

  const registrationHeld = await tx.growthReward.updateMany({
    where: {
      recipientUserId: input.userId,
      kind: 'registration',
      state: 'pending_verification',
    },
    data: {
      state: 'held',
      availableAt,
    },
  })

  const relation = await lockPendingInviteRelation(tx, input.userId)
  if (!relation) return { registrationHeld: registrationHeld.count, referral: 'none' as const, availableAt }

  // Every qualifier locks the same inviter row before counting. PostgreSQL
  // serializes the last-slot race without a process-local mutex or a stale
  // count-then-write window.
  const inviter = await lockUserForGrowthReward(tx, relation.inviterId)
  const minimumAgeDays = await getSystemConfigValue('referralInviterMinAgeDays', tx)
  if (!inviter || !isEligibleReferralInviter(inviter, minimumAgeDays, input.verifiedAt)) {
    const reason = referralVoidReasonForInviter(inviter)
    await transitionReferralToVoided(tx, {
      relationId: relation.id,
      inviterId: relation.inviterId,
      inviteeId: relation.inviteeId,
      state: 'pending_verification',
      reason,
      now: input.verifiedAt,
    })
    return { registrationHeld: registrationHeld.count, referral: 'voided' as const, availableAt }
  }

  const dailyLimit = assertBoundedInteger(
    await getSystemConfigValue('referralDailyQualifiedLimit', tx),
    0,
    100,
    'referral daily qualified limit',
  )
  const lifetimeLimit = assertBoundedInteger(
    await getSystemConfigValue('referralLifetimeQualifiedLimit', tx),
    0,
    10_000,
    'referral lifetime qualified limit',
  )
  const qualificationDay = getShanghaiDayWindow(input.verifiedAt).key
  const [qualifiedLifetime, qualifiedToday] = await Promise.all([
    tx.inviteRelation.count({
      where: { inviterId: inviter.id, status: 'qualified' },
    }),
    tx.inviteRelation.count({
      where: {
        inviterId: inviter.id,
        status: 'qualified',
        qualificationDay,
      },
    }),
  ])

  const quotaLimit = dailyLimit === 0 || qualifiedToday >= dailyLimit
    ? 'daily'
    : lifetimeLimit === 0 || qualifiedLifetime >= lifetimeLimit
      ? 'lifetime'
      : null

  if (quotaLimit) {
    await tx.inviteRelation.update({
      where: { id: relation.id },
      data: { status: 'quota_exhausted' },
    })
    const voided = await tx.growthReward.updateMany({
      where: {
        inviteRelationId: relation.id,
        state: 'pending_verification',
      },
      data: {
        state: 'voided',
        voidedAt: input.verifiedAt,
        voidReason: 'invite_relation_voided',
      },
    })
    await recordAbuseEvent({
      type: 'referral_quota_exhausted',
      inviterId: relation.inviterId,
      inviteeId: relation.inviteeId,
      detail: { limit: quotaLimit },
    }, tx)
    if (voided.count > 0) {
      await recordAbuseEvent({
        type: 'reward_voided',
        userId: relation.inviterId,
        inviterId: relation.inviterId,
        inviteeId: relation.inviteeId,
        detail: { kind: 'referral', reason: 'invite_relation_voided' },
      }, tx)
    }
    return { registrationHeld: registrationHeld.count, referral: 'quota_exhausted' as const, availableAt }
  }

  await tx.inviteRelation.update({
    where: { id: relation.id },
    data: {
      status: 'qualified',
      qualifiedAt: input.verifiedAt,
      qualificationDay,
    },
  })
  await tx.growthReward.updateMany({
    where: {
      inviteRelationId: relation.id,
      state: 'pending_verification',
    },
    data: {
      state: 'held',
      availableAt,
    },
  })
  await recordAbuseEvent({
    type: 'referral_qualified',
    inviterId: relation.inviterId,
    inviteeId: relation.inviteeId,
  }, tx)

  return { registrationHeld: registrationHeld.count, referral: 'qualified' as const, availableAt }
}

async function voidLockedGrowthReward(
  tx: Prisma.TransactionClient,
  reward: LockedGrowthReward,
  input: { reason: RewardVoidReason; now: Date; caseRef?: string },
) {
  const voided = await tx.growthReward.updateMany({
    where: {
      id: reward.id,
      state: { in: [...VOIDABLE_REWARD_STATES] },
    },
    data: {
      state: 'voided',
      voidedAt: input.now,
      voidReason: input.reason,
    },
  })
  if (voided.count !== 1) return false

  if (reward.inviteRelationId !== null) {
    await tx.inviteRelation.updateMany({
      where: {
        id: reward.inviteRelationId,
        status: { in: [...PENDING_REFERRAL_STATES] },
      },
      data: {
        status: 'voided',
        voidedAt: input.now,
      },
    })
  }

  await recordAbuseEvent({
    type: 'reward_voided',
    userId: reward.recipientUserId,
    detail: {
      kind: reward.kind === 'referral' ? 'referral' : 'registration',
      reason: input.reason,
      ...(input.caseRef ? { caseRef: input.caseRef } : {}),
    },
  }, tx)
  return true
}

/**
 * Admin callers compose this with their AdminLog in the same transaction.
 * `granted` is deliberately a conflict: correcting historical points belongs
 * to the established audited point-adjustment workflow, never this ledger.
 */
export async function voidGrowthRewardInTransaction(
  tx: Prisma.TransactionClient,
  input: { rewardId: number; reason: RewardVoidReason; caseRef?: string; now?: Date },
) {
  const reward = await lockGrowthReward(tx, input.rewardId)
  if (!reward) throw notFound('奖励不存在')
  if (reward.state === 'granted') throw conflict('已发放奖励不能在此作废')
  if (reward.state === 'voided') throw conflict('奖励已作废')
  if (!VOIDABLE_REWARD_STATES.includes(reward.state as typeof VOIDABLE_REWARD_STATES[number])) {
    throw conflict('奖励当前状态不能作废')
  }

  const voided = await voidLockedGrowthReward(tx, reward, {
    reason: input.reason,
    now: input.now ?? new Date(),
    caseRef: input.caseRef,
  })
  if (!voided) throw conflict('奖励状态已变化，请刷新后重试')
  return reward
}

/** Convenience wrapper for non-admin in-process callers and integration tests. */
export async function voidGrowthReward(
  input: { rewardId: number; reason: RewardVoidReason; caseRef?: string; now?: Date },
) {
  return prisma.$transaction(tx => voidGrowthRewardInTransaction(tx, input))
}

/**
 * Grant or void one row while its GrowthReward row lock is held. The lock is
 * the exactly-once claim; balance increment, PointLog and state transition all
 * stay in this one transaction.
 */
export async function releaseGrowthRewardInTransaction(
  tx: Prisma.TransactionClient,
  rewardId: number,
  now: Date = new Date(),
): Promise<GrowthRewardReleaseOutcome> {
  const reward = await lockGrowthReward(tx, rewardId)
  if (!reward || reward.state !== 'held' || !reward.availableAt || reward.availableAt > now) {
    return { outcome: 'skipped', rewardId }
  }

  // The GrowthReward row is the grant/void serialization point. Read the
  // recipient without taking a User row lock: an admin referral suspension
  // locks User first so it can also block new registrations/qualifications;
  // taking locks in the inverse order here would create a cron↔suspension
  // deadlock. If either mutation wins the reward row race, the other observes
  // its terminal state and never creates a second PointLog.
  const recipient = await tx.user.findUnique({
    where: { id: reward.recipientUserId },
    select: {
      id: true,
      status: true,
      emailVerified: true,
      referralSuspended: true,
      createdAt: true,
    },
  })
  if (!recipient || recipient.status !== NORMAL_USER_STATUS) {
    const reason: RewardVoidReason = 'recipient_banned'
    const voided = await voidLockedGrowthReward(tx, reward, { reason, now })
    return { outcome: voided ? 'voided' : 'skipped', rewardId, ...(voided ? { reason } : {}) } as GrowthRewardReleaseOutcome
  }

  if (reward.kind === 'referral') {
    if (reward.inviteRelationId === null) {
      const reason: RewardVoidReason = 'invite_relation_voided'
      const voided = await voidLockedGrowthReward(tx, reward, { reason, now })
      return { outcome: voided ? 'voided' : 'skipped', rewardId, ...(voided ? { reason } : {}) } as GrowthRewardReleaseOutcome
    }

    const relationRows = await tx.$queryRaw<LockedInviteRelation[]>`
      SELECT "id", "inviterId", "inviteeId", "status"
      FROM "InviteRelation"
      WHERE "id" = ${reward.inviteRelationId}
      FOR UPDATE`
    const relation = relationRows[0]
    const reason = !relation || relation.status !== 'qualified' || relation.inviterId !== reward.recipientUserId
      ? 'invite_relation_voided'
      : recipient.referralSuspended
        ? 'referral_suspended'
        : null
    if (reason) {
      const voided = await voidLockedGrowthReward(tx, reward, { reason, now })
      return { outcome: voided ? 'voided' : 'skipped', rewardId, ...(voided ? { reason } : {}) } as GrowthRewardReleaseOutcome
    }
  }

  const account = await tx.pointAccount.findUnique({ where: { userId: reward.recipientUserId } })
  if (!account) throw notFound('积分账户不存在')
  const balanceAfter = reward.amount > 0
    ? (await creditAvailablePoints(tx, reward.recipientUserId, reward.amount)).balance
    : account.balance
  await tx.pointLog.create({
    data: {
      userId: reward.recipientUserId,
      type: 'in',
      amount: reward.amount,
      balanceAfter,
      reason: reward.kind === 'referral' ? '邀请奖励冷静期发放' : '注册奖励冷静期发放',
    },
  })
  const granted = await tx.growthReward.updateMany({
    where: { id: reward.id, state: 'held' },
    data: { state: 'granted', grantedAt: now },
  })
  if (granted.count !== 1) {
    throw new Error('growth reward state changed while locked')
  }
  await recordAbuseEvent({
    type: 'reward_granted',
    userId: reward.recipientUserId,
    detail: {
      kind: reward.kind === 'referral' ? 'referral' : 'registration',
      amount: reward.amount,
    },
  }, tx)

  return { outcome: 'granted', rewardId: reward.id }
}

function assertBatchSize(value: number) {
  return assertBoundedInteger(value, 1, GROWTH_REWARD_BATCH_SIZE, 'growth reward batch size')
}

function growthRewardSavepoint(rewardId: number): string {
  if (!Number.isInteger(rewardId) || rewardId <= 0) {
    throw new Error('invalid growth reward id')
  }
  return `growth_reward_${rewardId}`
}

/**
 * Claims up to one cron batch with PostgreSQL `FOR UPDATE SKIP LOCKED`.
 * POINT_BALANCE_HARD_CAP is isolated per row with a savepoint so one at-cap
 * recipient cannot roll the rest of the batch back. Other grant failures
 * still abort the transaction.
 */
export async function releaseMatureGrowthRewards(options: {
  now?: Date
  batchSize?: number
} = {}) {
  const now = options.now ?? new Date()
  const batchSize = assertBatchSize(options.batchSize ?? GROWTH_REWARD_BATCH_SIZE)
  return prisma.$transaction(async tx => {
    const candidates = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT "id"
      FROM "GrowthReward"
      WHERE "state" = 'held'
        AND "availableAt" <= now()
      ORDER BY "availableAt" ASC, "id" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED`

    const outcomes: GrowthRewardReleaseOutcome[] = []
    for (const candidate of candidates) {
      const savepoint = growthRewardSavepoint(candidate.id)
      await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`)
      try {
        outcomes.push(await releaseGrowthRewardInTransaction(tx, candidate.id, now))
        await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`)
      } catch (error) {
        if (error instanceof HttpError && error.code === 'POINT_BALANCE_HARD_CAP') {
          await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`)
          outcomes.push({ outcome: 'skipped', rewardId: candidate.id })
          continue
        }
        throw error
      }
    }
    return outcomes
  })
}
