import bcrypt from 'bcryptjs'
import type { Prisma } from '@prisma/client'
import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import { badRequest, HttpError, notFound, unauthenticated } from '../../lib/httpError.js'
import { consumePasswordReset } from './abusePolicy.js'
import type { HumanVerificationRequest } from './humanVerification.js'
import { getMailer } from '../../lib/mailer/index.js'
import { renderMail } from '../../lib/mailer/templates/index.js'
import { logger } from '../../lib/logger.js'
import { lockUserRefreshSessionMutations, revokeAllUserRefreshTokens } from './sessionService.js'
import {
  PASSWORD_BCRYPT_ROUNDS,
  normalizeEmailAddress,
  hashAuthToken,
  generateAuthToken,
} from './credentialPrimitives.js'
import {
  registrationProtectionIsEnforced,
  consumeAbuseBucket,
  enforceHumanVerification,
} from './authProtection.js'

async function enforcePasswordResetProtection(
  email: string,
  ip: string | undefined,
  proof?: HumanVerificationRequest | string,
) {
  if (!registrationProtectionIsEnforced()) return

  await enforceHumanVerification({
    proof,
    ip,
    action: 'forgot_password',
  })

  // The proof is checked before consuming the existing password-reset
  // allowance. Invalid challenges do not burn the user's daily quota.
  await consumeAbuseBucket(() => consumePasswordReset({
    email: normalizeEmailAddress(email),
    ip: ip ?? '',
  }))
}

export async function requestPasswordReset(
  email: string,
  ip?: string,
  proof?: HumanVerificationRequest | string,
) {
  const normalizedEmail = normalizeEmailAddress(email)
  // The policy is consumed before the account lookup. Unknown addresses pay
  // the same email/IP cost as known ones, while the controller preserves the
  // endpoint's generic 200 response for every outcome.
  await enforcePasswordResetProtection(normalizedEmail, ip, proof)

  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } })
  // Silently no-op for unknown emails so the public endpoint can return
  // the same 200 response regardless of existence (no enumeration).
  if (!user) return
  if (user.status === '已封禁') return

  const rawToken = generateAuthToken()
  // A newly generated credential starts inactive. This lets SMTP fail (or the
  // process stop after SMTP returns ambiguously) without destroying a reset
  // link the user already possesses or leaving an unseen credential usable.
  const candidate = await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashAuthToken(rawToken),
      used: true,
      expiresAt: new Date(Date.now() + config.passwordResetTokenMaxAgeMs),
    },
  })

  const link = `${config.appBaseUrl}/reset-password/${rawToken}`
  try {
    const mailer = await getMailer()
    await mailer.send(renderMail('password_reset', {
      to: user.email,
      resetUrl: link,
      expiresMinutes: 30,
    }))
  } catch (err) {
    // SMTP delivery failed. Remove the candidate token (best-effort) so
    // the user's existing reset link remains valid. The candidate was
    // committed as used=true, so even a database outage cannot turn it
    // into a usable credential.
    try {
      await prisma.passwordResetToken.deleteMany({
        where: { id: candidate.id, userId: user.id, used: true },
      })
    } catch {
      logger.warn({ candidateId: candidate.id }, 'password reset candidate cleanup failed')
    }
    // Never propagate the provider error object: an adapter is allowed to
    // include message content in it, and the message could contain the raw
    // token. Log and throw only an allow-listed category.
    const code = (err as { code?: unknown } | null)?.code
    const failure = code === 'EAUTH' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' ? code : 'UNKNOWN'
    logger.warn({ failure }, 'password reset email delivery failed')
    // The controller catches this and suppresses the error for the caller.
    // Throwing is necessary to abort the function so no activation happens.
    throw Object.assign(new Error('Password reset email delivery failed'), { code: failure })
  }

  // SMTP succeeded. Atomically activate the new token inside a user-level
  // advisory lock, invalidating all previously active tokens.
  await prisma.$transaction(async tx => {
    await lockUserRefreshSessionMutations(tx, user.id)

    // If a reset/change/admin action changed the password while SMTP was in
    // flight, that mutation already invalidated every credential that existed
    // before it. Do not resurrect this earlier candidate afterwards.
    const currentUser = await tx.user.findUnique({
      where: { id: user.id },
      select: { password: true },
    })
    if (!currentUser || currentUser.password !== user.password) {
      throw new HttpError(500, 'INTERNAL_SERVER_ERROR', '服务器内部错误')
    }

    // Invalidate all previously active tokens.
    await tx.passwordResetToken.updateMany({
      where: { userId: user.id, used: false },
      data: { used: true },
    })

    // Atomically activate the candidate token. If it was already expired
    // or deleted by the SMTP-failure cleanup path above, the update count
    // will be 0 and we abort.
    const activated = await tx.passwordResetToken.updateMany({
      where: {
        id: candidate.id,
        userId: user.id,
        used: true,
        expiresAt: { gt: new Date() },
      },
      data: { used: false },
    })
    if (activated.count !== 1) {
      // Throwing rolls back the old-token invalidation as well. The email may
      // already have been accepted, but the user's earlier recovery ability is
      // preserved and the new link cannot become an unseen active credential.
      throw new HttpError(500, 'INTERNAL_SERVER_ERROR', '服务器内部错误')
    }
  })
}

/**
 * A password mutation invalidates more than refresh sessions. An administrator
 * may have completed the password half of an MFA login just before the
 * mutation, so every still-pending pre-auth challenge must become unusable in
 * the same user-locked transaction. Advancing the version also invalidates
 * any administrator access token that survives outside a session check.
 */
async function applySuccessfulPasswordChange(
  tx: Prisma.TransactionClient,
  user: { id: number; role: string },
  passwordHash: string,
) {
  const now = new Date()
  await tx.user.update({
    where: { id: user.id },
    data: {
      password: passwordHash,
      ...(user.role === 'admin' ? { mfaVersion: { increment: 1 } } : {}),
    },
  })
  await tx.authChallenge.updateMany({
    where: { userId: user.id, consumedAt: null },
    data: { consumedAt: now },
  })
}

export async function resetPasswordWithToken(rawToken: string, newPassword: string) {
  const tokenHash = hashAuthToken(rawToken)
  const stored = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  })
  if (!stored) throw badRequest('重置链接无效', 'BAD_REQUEST')
  if (stored.used) throw badRequest('重置链接已被使用', 'BAD_REQUEST')
  if (stored.expiresAt < new Date()) throw badRequest('重置链接已过期', 'BAD_REQUEST')

  const hashed = await bcrypt.hash(newPassword, PASSWORD_BCRYPT_ROUNDS)
  const consumed = await prisma.$transaction(async tx => {
    await lockUserRefreshSessionMutations(tx, stored.userId)
    // Claim the credential atomically. The initial checks above are only used
    // to return helpful errors; this condition is what prevents two parallel
    // requests from both changing the password.
    const claim = await tx.passwordResetToken.updateMany({
      where: {
        id: stored.id,
        tokenHash,
        used: false,
        expiresAt: { gt: new Date() },
      },
      data: { used: true },
    })
    if (claim.count !== 1) return false

    const user = await tx.user.findUnique({
      where: { id: stored.userId },
      select: { id: true, role: true },
    })
    if (!user) throw notFound('用户不存在')
    await applySuccessfulPasswordChange(tx, user, hashed)
    // A successful reset must invalidate any other link that was issued at
    // roughly the same time.
    await tx.passwordResetToken.updateMany({
      where: { userId: stored.userId, id: { not: stored.id }, used: false },
      data: { used: true },
    })
    // Revoke every refresh token outstanding for this user — if the
    // password is being reset, assume the prior session is compromised.
    await revokeAllUserRefreshTokens(stored.userId, tx)
    return true
  })

  if (!consumed) throw badRequest('重置链接已被使用或已过期', 'BAD_REQUEST')
}

export async function changePassword(userId: number, currentPassword: string, newPassword: string) {
  const hashed = await bcrypt.hash(newPassword, PASSWORD_BCRYPT_ROUNDS)
  await prisma.$transaction(async tx => {
    await lockUserRefreshSessionMutations(tx, userId)
    const user = await tx.user.findUnique({ where: { id: userId } })
    if (!user) throw notFound('用户不存在')
    if (user.status === '已封禁') throw badRequest('账号已被封禁')

    const valid = await bcrypt.compare(currentPassword, user.password)
    if (!valid) throw unauthenticated('当前密码错误')

    await applySuccessfulPasswordChange(tx, user, hashed)
    await tx.passwordResetToken.updateMany({
      where: { userId, used: false },
      data: { used: true },
    })
    await revokeAllUserRefreshTokens(userId, tx)
  })
}
