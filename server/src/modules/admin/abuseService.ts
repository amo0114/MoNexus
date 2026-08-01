import { Prisma } from '@prisma/client'
import { HttpError, notFound } from '../../lib/httpError.js'
import { prisma } from '../../lib/prisma.js'
import { recordAbuseEvent } from '../auth/abuseEvents.js'
import { voidGrowthRewardInTransaction } from '../auth/growthRewards.js'

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100
const VOIDABLE_REWARD_STATES = ['pending_verification', 'held'] as const

export type AbuseOverviewWindow = '1h' | '24h'
export type AbuseReferralState = 'legacy' | 'pending_verification' | 'qualified' | 'quota_exhausted' | 'voided'
export type AbuseRewardState = 'pending_verification' | 'held' | 'granted' | 'voided'

type ReferralAdminUser = {
  id: number
  referralSuspended: boolean
}

function maskEmail(email: string) {
  const [local = '', domain = ''] = email.split('@')
  const localHint = local.slice(0, 1) || '*'
  const domainParts = domain.split('.')
  const domainHint = domainParts[0]?.slice(0, 1) || '*'
  const suffix = domainParts.length > 1 ? `.${domainParts.slice(1).join('.')}` : ''
  return `${localHint}***@${domainHint}***${suffix}`
}

function normalizePagination(page?: number, pageSize?: number) {
  const safePage = Number.isSafeInteger(page) && page! > 0 ? page! : 1
  const requestedSize = Number.isSafeInteger(pageSize) && pageSize! > 0 ? pageSize! : DEFAULT_PAGE_SIZE
  return { page: safePage, pageSize: Math.min(requestedSize, MAX_PAGE_SIZE) }
}

function countByField<T extends Record<string, unknown>>(
  rows: Array<T & { _count: { _all: number } }>,
  field: keyof T,
) {
  return new Map(rows.map(row => [String(row[field]), row._count._all]))
}

async function lockReferralAdminUser(tx: Prisma.TransactionClient, userId: number): Promise<ReferralAdminUser | null> {
  const rows = await tx.$queryRaw<ReferralAdminUser[]>`
    SELECT "id", "referralSuspended"
    FROM "User"
    WHERE "id" = ${userId}
    FOR UPDATE`
  return rows[0] ?? null
}

function isExpectedRewardRace(error: unknown) {
  return error instanceof HttpError && error.code === 'CONFLICT'
}

/**
 * MFA is enforced by the parent router. This projection intentionally uses
 * only indexed aggregate/count queries and returns no raw abuse hashes,
 * provider payloads, tokens, or user identifiers beyond aggregate counts.
 */
export async function getAbuseOverview(window: AbuseOverviewWindow = '24h') {
  const now = new Date()
  const durationMs = window === '1h' ? 60 * 60 * 1_000 : 24 * 60 * 60 * 1_000
  const since = new Date(now.getTime() - durationMs)

  const [
    acceptedRegistrations,
    rejectedRegistrations,
    challengeFailures,
    verificationEmailSends,
    mailThrottles,
    unverifiedUsers,
    referralStates,
    rewardStates,
  ] = await Promise.all([
    prisma.user.count({ where: { createdAt: { gte: since } } }),
    prisma.abuseEvent.count({
      where: {
        createdAt: { gte: since },
        type: { in: ['registration_rejected', 'registration_rate_limited'] },
      },
    }),
    prisma.abuseEvent.count({
      where: {
        createdAt: { gte: since },
        type: { in: ['challenge_failed', 'challenge_unavailable'] },
      },
    }),
    prisma.emailVerificationToken.count({ where: { createdAt: { gte: since } } }),
    prisma.abuseEvent.count({ where: { createdAt: { gte: since }, type: 'mail_throttled' } }),
    prisma.user.count({ where: { emailVerified: null, status: { not: '已封禁' } } }),
    prisma.inviteRelation.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.growthReward.groupBy({ by: ['state'], _count: { _all: true } }),
  ])
  const referralCounts = countByField(referralStates, 'status')
  const rewardCounts = countByField(rewardStates, 'state')

  return {
    window,
    since: since.toISOString(),
    registrations: {
      attempts: acceptedRegistrations + rejectedRegistrations,
      accepted: acceptedRegistrations,
      rejected: rejectedRegistrations,
    },
    challengeFailures,
    verificationEmail: {
      sent: verificationEmailSends,
      throttled: mailThrottles,
    },
    unverifiedUsers,
    referrals: {
      pendingVerification: referralCounts.get('pending_verification') ?? 0,
      qualified: referralCounts.get('qualified') ?? 0,
      quotaExhausted: referralCounts.get('quota_exhausted') ?? 0,
      voided: referralCounts.get('voided') ?? 0,
    },
    rewards: {
      pendingVerification: rewardCounts.get('pending_verification') ?? 0,
      held: rewardCounts.get('held') ?? 0,
      granted: rewardCounts.get('granted') ?? 0,
      voided: rewardCounts.get('voided') ?? 0,
    },
  }
}

export async function listAbuseReferrals(input: {
  state?: AbuseReferralState
  q?: string
  page?: number
  pageSize?: number
} = {}) {
  const { page, pageSize } = normalizePagination(input.page, input.pageSize)
  const where: Prisma.InviteRelationWhereInput = {}
  if (input.state) where.status = input.state

  const query = input.q?.trim()
  if (query) {
    const numericId = /^\d+$/.test(query) ? Number(query) : null
    where.OR = [
      ...(numericId && Number.isSafeInteger(numericId)
        ? [{ inviterId: numericId }, { inviteeId: numericId }]
        : []),
      { inviter: { email: { contains: query, mode: 'insensitive' } } },
      { invitee: { email: { contains: query, mode: 'insensitive' } } },
    ]
  }

  const [total, rows] = await prisma.$transaction([
    prisma.inviteRelation.count({ where }),
    prisma.inviteRelation.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        status: true,
        qualifiedAt: true,
        voidedAt: true,
        qualificationDay: true,
        createdAt: true,
        inviter: {
          select: { id: true, email: true, referralSuspended: true },
        },
        invitee: {
          select: { id: true, email: true, emailVerified: true },
        },
        growthReward: {
          select: {
            id: true,
            amount: true,
            state: true,
            availableAt: true,
            grantedAt: true,
            voidedAt: true,
            voidReason: true,
          },
        },
      },
    }),
  ])

  return {
    total,
    page,
    pageSize,
    items: rows.map(row => ({
      id: row.id,
      status: row.status,
      qualifiedAt: row.qualifiedAt,
      voidedAt: row.voidedAt,
      qualificationDay: row.qualificationDay,
      createdAt: row.createdAt,
      inviter: {
        id: row.inviter.id,
        email: maskEmail(row.inviter.email),
        referralSuspended: row.inviter.referralSuspended,
      },
      invitee: {
        id: row.invitee.id,
        email: maskEmail(row.invitee.email),
        emailVerified: row.invitee.emailVerified,
      },
      reward: row.growthReward,
    })),
  }
}

export async function listAbuseRewards(input: {
  state?: AbuseRewardState
  userId?: number
  page?: number
  pageSize?: number
} = {}) {
  const { page, pageSize } = normalizePagination(input.page, input.pageSize)
  const where: Prisma.GrowthRewardWhereInput = {
    ...(input.state ? { state: input.state } : {}),
    ...(input.userId ? { recipientUserId: input.userId } : {}),
  }
  const [total, rows] = await prisma.$transaction([
    prisma.growthReward.count({ where }),
    prisma.growthReward.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        kind: true,
        amount: true,
        state: true,
        availableAt: true,
        grantedAt: true,
        voidedAt: true,
        voidReason: true,
        createdAt: true,
        recipient: { select: { id: true, email: true } },
        inviteRelation: {
          select: {
            id: true,
            status: true,
            inviter: { select: { id: true, email: true, referralSuspended: true } },
            invitee: { select: { id: true, email: true } },
          },
        },
      },
    }),
  ])

  return {
    total,
    page,
    pageSize,
    items: rows.map(row => ({
      id: row.id,
      kind: row.kind,
      amount: row.amount,
      state: row.state,
      availableAt: row.availableAt,
      grantedAt: row.grantedAt,
      voidedAt: row.voidedAt,
      voidReason: row.voidReason,
      createdAt: row.createdAt,
      recipient: { id: row.recipient.id, email: maskEmail(row.recipient.email) },
      inviteRelation: row.inviteRelation
        ? {
            id: row.inviteRelation.id,
            status: row.inviteRelation.status,
            inviter: {
              id: row.inviteRelation.inviter.id,
              email: maskEmail(row.inviteRelation.inviter.email),
              referralSuspended: row.inviteRelation.inviter.referralSuspended,
            },
            invitee: {
              id: row.inviteRelation.invitee.id,
              email: maskEmail(row.inviteRelation.invitee.email),
            },
          }
        : null,
    })),
  }
}

/**
 * Stops future referral qualification and voids only this inviter's still
 * pending/held referral rewards. Already granted PointLog history remains
 * untouched; callers must use the established point-adjustment workflow for
 * a separately reviewed correction.
 */
export async function setReferralSuspension(input: {
  adminUserId: number
  userId: number
  suspended: boolean
  caseRef: string
}) {
  return prisma.$transaction(async tx => {
    const user = await lockReferralAdminUser(tx, input.userId)
    if (!user) throw notFound('用户不存在')

    await tx.user.update({
      where: { id: user.id },
      data: { referralSuspended: input.suspended },
    })

    let voidedRewards = 0
    if (input.suspended) {
      const candidates = await tx.growthReward.findMany({
        where: {
          recipientUserId: user.id,
          kind: 'referral',
          state: { in: [...VOIDABLE_REWARD_STATES] },
        },
        select: { id: true },
      })
      for (const candidate of candidates) {
        try {
          await voidGrowthRewardInTransaction(tx, {
            rewardId: candidate.id,
            reason: 'referral_suspended',
            caseRef: input.caseRef,
          })
          voidedRewards += 1
        } catch (error) {
          // A cron worker can win an individual reward row before this
          // suspension reaches it. That reward is terminal and must never be
          // clawed back here; all non-race failures still rollback the action.
          if (!isExpectedRewardRace(error)) throw error
        }
      }
    }

    await tx.adminLog.create({
      data: {
        adminUserId: input.adminUserId,
        action: input.suspended ? '暂停邀请码资格' : '恢复邀请码资格',
        targetType: 'user_referral',
        targetId: user.id,
        detail: `caseRef=${input.caseRef}; voidedRewards=${voidedRewards}`,
      },
    })
    await recordAbuseEvent({
      type: input.suspended ? 'referral_suspended' : 'referral_restored',
      userId: user.id,
      inviterId: user.id,
      detail: { caseRef: input.caseRef },
    }, tx)

    return { userId: user.id, suspended: input.suspended, voidedRewards }
  })
}

export async function voidAbuseReward(input: {
  adminUserId: number
  rewardId: number
  caseRef: string
}) {
  return prisma.$transaction(async tx => {
    const reward = await voidGrowthRewardInTransaction(tx, {
      rewardId: input.rewardId,
      reason: 'admin_void',
      caseRef: input.caseRef,
    })
    await tx.adminLog.create({
      data: {
        adminUserId: input.adminUserId,
        action: '作废未发奖励',
        targetType: 'growthReward',
        targetId: reward.id,
        detail: `caseRef=${input.caseRef}; kind=${reward.kind}; amount=${reward.amount}`,
      },
    })
    return {
      id: reward.id,
      kind: reward.kind,
      amount: reward.amount,
      state: 'voided' as const,
      caseRef: input.caseRef,
    }
  })
}

export { maskEmail }
