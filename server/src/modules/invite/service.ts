import { Prisma } from '@prisma/client'
import {
  businessDateString,
  businessDayStartUtc,
  businessMonthStart,
} from '../../lib/businessTime.js'
import { badRequest, conflict, forbidden, notFound } from '../../lib/httpError.js'
import { generateInviteCode } from '../../lib/inviteCode.js'
import {
  getCurrentTierConfig,
  resolveTier,
  tierByRank,
  tierLabel,
  tierRank,
} from '../../lib/memberTier.js'
import { prisma } from '../../lib/prisma.js'
import { getSystemConfigValue } from '../../lib/systemConfig.js'

const DAY_MS = 24 * 60 * 60 * 1_000
const NORMAL_USER_STATUS = '正常'
/** IV-01：撞唯一约束的重试上限；每次重试只重掷码值。 */
const CODE_GENERATION_MAX_ATTEMPTS = 5
/** 个人中心列表上限——名额封顶了增长速度，这只是读侧的兜底 LIMIT。 */
const CODES_LIST_LIMIT = 100

/** IV-07：统一文案，不区分不存在/已用/过期/生成者被冻结，防码状态探测。 */
export const INVITE_CODE_INVALID_MESSAGE = '邀请码无效或已失效'

export function inviteCodeInvalid() {
  return badRequest(INVITE_CODE_INVALID_MESSAGE)
}

export type InviteIneligibleReason =
  | 'not_verified'
  | 'account_too_young'
  | 'suspended'
  | 'tier_too_low'
  | 'role_paused'

export type InviteCodeDto = {
  code: string
  status: 'active' | 'used' | 'expired' | 'revoked'
  expiresAt: string
  usedAt: string | null
  createdAt: string
}

export type InviteQuotaDto = {
  limit: number
  used: number
  remaining: number
  periodKey: string
}

export type MyInvitesDto = {
  eligible: boolean
  reason?: InviteIneligibleReason
  tierRequired?: string
  /** admin 为 null 表示不限量。 */
  quota: InviteQuotaDto | null
  codes: InviteCodeDto[]
}

type InviteEligibilityUser = {
  id: number
  role: string
  status: string
  emailVerified: Date | null
  referralSuspended: boolean
  createdAt: Date
}

type EligibilityOutcome =
  | { eligible: true; monthlyLimit: number | null }
  | { eligible: false; reason: InviteIneligibleReason; tierRequired?: string }

type ConfigClient = typeof prisma | Prisma.TransactionClient

/** IV-05：名额周期 = 上海时区自然月；periodKey 与 leaderboard 同风格（M2026-08）。 */
function currentInvitePeriod(now: Date) {
  const startDay = businessMonthStart(businessDateString(now))
  const [year, month] = startDay.split('-').map(Number)
  const endDay = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, '0')}-01`
  return {
    periodKey: `M${startDay.slice(0, 7)}`,
    startUtc: businessDayStartUtc(startDay),
    endUtc: businessDayStartUtc(endDay),
  }
}

async function lifetimeEarnedPoints(client: ConfigClient, userId: number) {
  const result = await client.pointLog.aggregate({
    where: { userId, type: 'in' },
    _sum: { amount: true },
  })
  return result._sum.amount ?? 0
}

/**
 * IV-04 的唯一判定：admin 只要求状态正常；merchant/user 要求状态正常 +
 * 邮箱已验证 + 未被 referralSuspended + 账龄达标；user 额外要求会员等级
 * ≥ `inviteMinTierRank`。角色月名额为 0 视为该角色发码暂停（IV-05）。
 * 生成事务在 issuer 行锁下用同一函数复核。
 */
async function evaluateInviteEligibility(
  user: InviteEligibilityUser,
  client: ConfigClient,
  now: Date,
): Promise<EligibilityOutcome> {
  if (user.role === 'admin') {
    return user.status === NORMAL_USER_STATUS
      ? { eligible: true, monthlyLimit: null }
      : { eligible: false, reason: 'suspended' }
  }

  if (user.status !== NORMAL_USER_STATUS || user.referralSuspended) {
    return { eligible: false, reason: 'suspended' }
  }
  if (user.emailVerified === null) {
    return { eligible: false, reason: 'not_verified' }
  }
  const minimumAgeDays = await getSystemConfigValue('referralInviterMinAgeDays', client)
  if (user.createdAt.getTime() > now.getTime() - minimumAgeDays * DAY_MS) {
    return { eligible: false, reason: 'account_too_young' }
  }

  if (user.role !== 'merchant') {
    const minTierRank = await getSystemConfigValue('inviteMinTierRank', client)
    if (minTierRank > 0) {
      const tierConfig = await getCurrentTierConfig(client)
      const tier = resolveTier(await lifetimeEarnedPoints(client, user.id), tierConfig.thresholds)
      if (tierRank(tier) < minTierRank) {
        return {
          eligible: false,
          reason: 'tier_too_low',
          tierRequired: tierLabel(tierByRank(minTierRank)),
        }
      }
    }
  }

  const monthlyLimit = await getSystemConfigValue(
    user.role === 'merchant' ? 'inviteQuotaMerchantMonthly' : 'inviteQuotaUserMonthly',
    client,
  )
  if (monthlyLimit === 0) {
    return { eligible: false, reason: 'role_paused' }
  }
  return { eligible: true, monthlyLimit }
}

function inviteIneligibleError(outcome: Extract<EligibilityOutcome, { eligible: false }>) {
  if (outcome.reason === 'tier_too_low' && outcome.tierRequired) {
    return forbidden(`${outcome.tierRequired}及以上会员可邀请好友`)
  }
  if (outcome.reason === 'not_verified') return forbidden('请先完成邮箱验证后再邀请好友')
  if (outcome.reason === 'account_too_young') return forbidden('账号注册时间不足，暂不可邀请好友')
  if (outcome.reason === 'role_paused') return forbidden('邀请功能暂未开放')
  return forbidden('当前账号暂不可邀请好友')
}

/** IV-02：`expired` 惰性折算——读侧一律以 expiresAt 为准，不改写存储行。 */
function effectiveCodeStatus(
  row: { status: string; expiresAt: Date },
  now: Date,
): InviteCodeDto['status'] {
  if (row.status === 'active' && row.expiresAt.getTime() <= now.getTime()) return 'expired'
  return row.status as InviteCodeDto['status']
}

function formatInviteCode(
  row: { code: string; status: string; expiresAt: Date; usedAt: Date | null; createdAt: Date },
  now: Date,
): InviteCodeDto {
  return {
    code: row.code,
    status: effectiveCodeStatus(row, now),
    expiresAt: row.expiresAt.toISOString(),
    usedAt: row.usedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

async function countIssuedInPeriod(
  client: ConfigClient,
  issuerId: number,
  period: { startUtc: Date; endUtc: Date },
) {
  // IV-05：计数口径 = 当月已生成（含已用/已过期/已撤销），过期不返还。
  return client.inviteCode.count({
    where: {
      issuerId,
      createdAt: { gte: period.startUtc, lt: period.endUtc },
    },
  })
}

/** GET /invites/me：资格 + 当月名额 + 码列表；不合格用户不返回 codes。 */
export async function getMyInvites(
  userId: number,
  options: { now?: Date } = {},
): Promise<MyInvitesDto> {
  const now = options.now ?? new Date()
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      status: true,
      emailVerified: true,
      referralSuspended: true,
      createdAt: true,
    },
  })
  if (!user) throw notFound('用户不存在')

  const outcome = await evaluateInviteEligibility(user, prisma, now)
  if (!outcome.eligible) {
    return {
      eligible: false,
      reason: outcome.reason,
      ...(outcome.tierRequired === undefined ? {} : { tierRequired: outcome.tierRequired }),
      quota: null,
      codes: [],
    }
  }

  const period = currentInvitePeriod(now)
  const [used, rows] = await Promise.all([
    outcome.monthlyLimit === null ? Promise.resolve(0) : countIssuedInPeriod(prisma, userId, period),
    prisma.inviteCode.findMany({
      where: { issuerId: userId },
      orderBy: { createdAt: 'desc' },
      take: CODES_LIST_LIMIT,
      select: { code: true, status: true, expiresAt: true, usedAt: true, createdAt: true },
    }),
  ])

  return {
    eligible: true,
    quota: outcome.monthlyLimit === null
      ? null
      : {
          limit: outcome.monthlyLimit,
          used,
          remaining: Math.max(0, outcome.monthlyLimit - used),
          periodKey: period.periodKey,
        },
    codes: rows.map(row => formatInviteCode(row, now)),
  }
}

function isInviteCodeCollision(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === 'P2002'
    && (error.meta?.target as string[] | string | undefined)?.includes('code') === true
}

/**
 * POST /invites：生成一枚一次性码。
 *
 * IV-06 并发安全：事务先 `SELECT ... FOR UPDATE` 锁发码人 User 行，再在锁下
 * 复核资格并 count-then-insert——并发两次生成会在行锁上串行，后到者重新计数。
 * 该事务只锁这一行 User，不触碰其他表的行锁（沿 P6 锁序惯例）。
 *
 * 唯一约束撞车（P2002）重试 ≤5 次：整个事务重跑，等价于"仅重掷码值 + 重新
 * 复核"，比事务内 savepoint 重试更保守也更简单。
 */
export async function createInviteCode(
  userId: number,
  options: { now?: Date; generateCode?: () => string } = {},
) {
  const now = options.now ?? new Date()
  const generate = options.generateCode ?? generateInviteCode

  for (let attempt = 1; attempt <= CODE_GENERATION_MAX_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(async tx => {
        const rows = await tx.$queryRaw<InviteEligibilityUser[]>`
          SELECT "id", "role", "status", "emailVerified", "referralSuspended", "createdAt"
          FROM "User"
          WHERE "id" = ${userId}
          FOR UPDATE`
        const user = rows[0]
        if (!user) throw notFound('用户不存在')

        const outcome = await evaluateInviteEligibility(user, tx, now)
        if (!outcome.eligible) throw inviteIneligibleError(outcome)

        const period = currentInvitePeriod(now)
        if (outcome.monthlyLimit !== null) {
          const used = await countIssuedInPeriod(tx, userId, period)
          if (used >= outcome.monthlyLimit) throw conflict('本月邀请名额已用完')
        }

        const ttlDays = await getSystemConfigValue('inviteCodeTtlDays', tx)
        if (!Number.isSafeInteger(ttlDays) || ttlDays < 1 || ttlDays > 90) {
          // 写入侧已校验 1..90；直改数据库不允许静默变成异常有效期。
          throw new Error('inviteCodeTtlDays configuration is invalid')
        }

        const created = await tx.inviteCode.create({
          data: {
            code: generate(),
            issuerId: userId,
            expiresAt: new Date(now.getTime() + ttlDays * DAY_MS),
            // 生成时刻与名额窗口共用同一时钟（注入的 now 也一致生效）。
            createdAt: now,
          },
        })
        return formatInviteCode(created, now)
      })
    } catch (error) {
      if (isInviteCodeCollision(error) && attempt < CODE_GENERATION_MAX_ATTEMPTS) continue
      throw error
    }
  }
  throw new Error('invite code generation exhausted unique retries')
}

/**
 * IV-03/IV-07：注册事务内的原子领用。条件更新影响行数必须恰为 1，任何
 * 失败（不存在/已用/过期/已撤销）都以统一文案 400 让整个注册回滚；领用
 * 成功后锁 issuer User 行复核状态与 referralSuspended——暂停某用户即时
 * 冻结其全部存量未用码。
 *
 * 锁序（全库统一，勿倒置）：新用户 User 行（tx.user.create 自带）→
 * InviteCode 行（updateMany）→ issuer User 行（FOR UPDATE）。
 */
export async function claimInviteCodeForRegistration(
  tx: Prisma.TransactionClient,
  input: { code: string; usedByUserId: number; now?: Date },
): Promise<{ issuerId: number }> {
  const now = input.now ?? new Date()
  const claimed = await tx.inviteCode.updateMany({
    where: { code: input.code, status: 'active', expiresAt: { gt: now } },
    data: { status: 'used', usedByUserId: input.usedByUserId, usedAt: now },
  })
  if (claimed.count !== 1) throw inviteCodeInvalid()

  const row = await tx.inviteCode.findUniqueOrThrow({
    where: { code: input.code },
    select: { issuerId: true },
  })
  const issuerRows = await tx.$queryRaw<Array<{ id: number; status: string; referralSuspended: boolean }>>`
    SELECT "id", "status", "referralSuspended"
    FROM "User"
    WHERE "id" = ${row.issuerId}
    FOR UPDATE`
  const issuer = issuerRows[0]
  if (!issuer || issuer.status !== NORMAL_USER_STATUS || issuer.referralSuspended) {
    throw inviteCodeInvalid()
  }
  return { issuerId: row.issuerId }
}
