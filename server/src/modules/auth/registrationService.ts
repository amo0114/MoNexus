import { PASSWORD_BCRYPT_ROUNDS, normalizeEmailAddress } from './credentialPrimitives.js'
import {
  registrationProtectionIsEnforced,
  consumeAbuseBucket,
  enforceHumanVerification,
} from './authProtection.js'
import { buildAuthUser, generateAccessToken, createStoredRefreshToken } from './sessionIssuance.js'
import bcrypt from 'bcryptjs'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import { badRequest, conflict, notFound, registrationDisabled } from '../../lib/httpError.js'
import { consumeRegistrationAttempt, consumeRegistrationProviderPreflight } from './abusePolicy.js'
import { ALTCHA_CHALLENGE_URL, type HumanVerificationRequest } from './humanVerification.js'
import { normalizeInviteCode } from '../../lib/inviteCode.js'
import { claimInviteCodeForRegistration } from '../invite/service.js'
import { getRefreshTokenMaxAgeMs, getSystemConfigValue } from '../../lib/systemConfig.js'
import { lockUserRefreshSessionMutations } from './sessionService.js'
import { getLegalRequirement, recordUserConsents, resolveConsentEvidence } from '../legal/service.js'
import { createClaimedReferralGrowthReward, createRegistrationGrowthReward } from './growthRewards.js'
import { generateDefaultNickname, normalizeUserNickname } from '../../lib/defaultNickname.js'

/**
 * REG-01 / C2：开关判定的唯一定义。fail-closed——只有恰好为 1 才算开启，
 * 被手工写坏的值（例如 2）一律按关闭处理；缺记录时 `getSystemConfigValue`
 * 回落默认 1，保证升级站点默认仍开放注册。
 *
 * 刻意不缓存：REG-05 要求"改开关成功之后开始处理的请求必须读到新值"，
 * 一次主键读换取即时性。
 */
export async function isRegistrationEnabled(): Promise<boolean> {
  return (await getSystemConfigValue('registrationEnabled')) === 1
}

/**
 * REG-03/REG-04 的强制边界。放在 service 而不是 controller/路由，是为了让
 * 未来的 CLI、内部调用共享同一道门；删路由式的"关闭"做不到这点，也留不下
 * 运营审计记录。
 */
export async function assertRegistrationEnabled() {
  if (!(await isRegistrationEnabled())) throw registrationDisabled()
}

async function enforceRegistrationProtection(input: {
  email: string
  ip?: string
  proof?: HumanVerificationRequest | string
}) {
  if (!registrationProtectionIsEnforced()) return

  // This is deliberately the first side effect after the registration gate:
  // a provider flood must be stopped before proof verification or any password/DB work.
  await consumeAbuseBucket(() => consumeRegistrationProviderPreflight(input.ip ?? ''))

  await enforceHumanVerification({
    proof: input.proof,
    ip: input.ip,
    action: 'register',
  })

  // Human verification has established a proof; only now consume the expensive
  // registration attempt buckets, immediately before bcrypt and DB work.
  await consumeAbuseBucket(() => consumeRegistrationAttempt({
    ip: input.ip ?? '',
    email: input.email,
  }))
}

function publicChallengeDescriptor() {
  if (config.humanVerificationProvider === 'altcha') {
    if (!config.altcha.hmacKey) return null
    return {
      provider: 'altcha' as const,
      challengeUrl: `${ALTCHA_CHALLENGE_URL}?action=register`,
    }
  }
  if (config.humanVerificationProvider === 'turnstile') {
    if (!config.turnstile.siteKey) return null
    return {
      provider: 'turnstile' as const,
      siteKey: config.turnstile.siteKey,
    }
  }
  return null
}

function humanVerificationIsConfigured() {
  if (!config.redisEnabled || !config.redisRequired || !config.abuseHashKey) return false
  if (config.humanVerificationProvider === 'altcha') return Boolean(config.altcha.hmacKey)
  if (config.humanVerificationProvider === 'turnstile') {
    return Boolean(
      config.turnstile.siteKey
      && config.turnstile.secretKey
      && config.turnstile.allowedHostnames.length > 0,
    )
  }
  return false
}

/**
 * SPEC-INVITE-001 IV-08：invite-only 开关，读法与 registrationEnabled 同款
 * fail-closed（恰为 1 才算开启）且刻意不缓存。
 */
export async function isInviteOnlyRegistration(): Promise<boolean> {
  return (await getSystemConfigValue('registrationInviteOnly')) === 1
}

/**
 * Public status intentionally reports only a safe browser challenge
 * descriptor. Redis health is deliberately not probed here: the actual
 * registration path remains fail-closed if a runtime command is unavailable.
 */
export async function getPublicRegistrationStatus() {
  const [registrationEnabled, inviteRequired] = await Promise.all([
    isRegistrationEnabled(),
    isInviteOnlyRegistration(),
  ])

  // SPEC-LEGAL-001：注册勾选项的协议要求（页面关闭 = null，前端隐藏勾选区）。
  const legalRequirement = getLegalRequirement('registration')

  if (!registrationProtectionIsEnforced()) {
    return {
      registrationEnabled,
      registrationAvailable: registrationEnabled,
      inviteRequired,
      challenge: null,
      legalRequirement,
    }
  }

  if (!humanVerificationIsConfigured()) {
    return {
      registrationEnabled,
      registrationAvailable: false,
      inviteRequired,
      challenge: null,
      legalRequirement,
    }
  }

  return {
    registrationEnabled,
    registrationAvailable: registrationEnabled,
    inviteRequired,
    challenge: publicChallengeDescriptor(),
    legalRequirement,
  }
}

export async function registerUser(
  email: string,
  password: string,
  inviteCode?: string,
  ip?: string,
  userAgent?: string,
  proof?: HumanVerificationRequest | string,
  agreements?: Record<string, string>,
  nickname?: string,
) {
  // REG-03：必须是第一步——查重、bcrypt、建号事务都在其后，关闭态下不会
  // 产生任何可观测副作用（连"该邮箱已注册"这种探测口子也不给）。
  await assertRegistrationEnabled()

  const normalizedEmail = normalizeEmailAddress(email)
  await enforceRegistrationProtection({
    email: normalizedEmail,
    ip,
    proof,
  })

  // SPEC-LEGAL-001：协议证据解析在任何 DB 写入之前（纯注册表比对，零副作用）。
  // enforce 下缺/旧版本在此拒绝，不会产生半截账号。
  const consentEvidence = resolveConsentEvidence('registration', agreements)

  // IV-08：invite-only 检查位于注册开关与滥用防护之后、查邮箱重复之前。
  // HTTP 侧 schema 已归一化；这里对直接调用方（CLI/测试）重跑同一归一化。
  const hasInviteCodeInput = typeof inviteCode === 'string' && inviteCode.trim() !== ''
  const claimCode = hasInviteCodeInput ? normalizeInviteCode(inviteCode) : null
  if (hasInviteCodeInput && claimCode === null) throw badRequest('邀请码格式不正确')
  if (!claimCode && (await isInviteOnlyRegistration())) {
    throw badRequest('当前仅限邀请注册')
  }

  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } })
  if (existing) throw conflict('该邮箱已注册')

  const hashedPassword = await bcrypt.hash(password, PASSWORD_BCRYPT_ROUNDS)

  let chosenNickname: string
  try {
    chosenNickname = normalizeUserNickname(nickname) ?? ''
  } catch (err) {
    if (err instanceof Error && err.message === 'NICKNAME_TOO_LONG') {
      throw badRequest('昵称最多 20 字')
    }
    throw badRequest('昵称格式无效')
  }

  const result = await prisma.$transaction(async tx => {
    const registerReward = await getSystemConfigValue('registerReward', tx)

    // 未填昵称 → 趣味昵称并记录来源；尽量避免重名，昵称并非唯一标识。
    let finalNickname = chosenNickname
    if (!finalNickname) {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const candidate = generateDefaultNickname()
        const clash = await tx.user.findFirst({
          where: { nickname: candidate },
          select: { id: true },
        })
        if (!clash) {
          finalNickname = candidate
          break
        }
      }
      if (!finalNickname) {
        // 昵称允许重名；词表拥挤时仍能完成注册。
        finalNickname = generateDefaultNickname()
      }
    }

    const newUser = await tx.user.create({
      data: {
        email: normalizedEmail,
        password: hashedPassword,
        nickname: finalNickname,
        nicknameIsGenerated: !chosenNickname,
      },
    })

    await tx.pointAccount.create({
      data: { userId: newUser.id, balance: 0 },
    })

    await createRegistrationGrowthReward(tx, newUser.id, registerReward)

    // SPEC-LEGAL-001：同意证据与账号同事务——账号在则证据在，绝不出现
    // "已注册但未留证"的用户。IP/UA 由 retention cron 到期匿名化。
    await recordUserConsents(tx, {
      userId: newUser.id,
      evidences: consentEvidence,
      ip,
      userAgent,
    })

    if (claimCode) {
      // IV-03/IV-07/IV-09：一次性码在本事务内原子领用，任何失败都显式 400
      // 并回滚整个注册；领用成功即建 pending 关系 + 冻结 referral 奖励。
      // 锁序：新用户 User 行（create 自带）→ InviteCode 行 → issuer User 行。
      const claimed = await claimInviteCodeForRegistration(tx, {
        code: claimCode,
        usedByUserId: newUser.id,
      })
      await createClaimedReferralGrowthReward(tx, {
        inviterId: claimed.issuerId,
        inviteeId: newUser.id,
      })
    }

    return { user: newUser }
  })

  // Read the runtime setting before taking the per-user lock. No global Prisma
  // call is allowed while the transaction owns that lock.
  const maxAgeMs = await getRefreshTokenMaxAgeMs()
  const issued = await prisma.$transaction(async tx => {
    await lockUserRefreshSessionMutations(tx, result.user.id)
    const currentUser = await tx.user.findUnique({ where: { id: result.user.id } })
    if (!currentUser) throw notFound('用户不存在')
    if (currentUser.status === '已封禁') throw badRequest('账号已被封禁')

    const session = await createStoredRefreshToken(currentUser.id, ip, userAgent, tx, maxAgeMs)
    return { user: currentUser, session }
  })
  const accessToken = generateAccessToken(issued.user.id, issued.user.role, issued.session.sessionId)

  return {
    accessToken,
    refreshToken: issued.session.refreshToken,
    refreshTokenMaxAgeMs: issued.session.maxAgeMs,
    // Registration awards are only ledger rows at this point. Returning the
    // configured amount here would make clients advertise spendable points
    // that do not exist yet.
    user: buildAuthUser(issued.user, 0),
  }
}
