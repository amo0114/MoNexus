import { config } from '../../config/index.js'
import { prisma } from '../../lib/prisma.js'
import { badRequest, notFound } from '../../lib/httpError.js'
import { consumeVerificationEmailSend } from './abusePolicy.js'
import { getMailer } from '../../lib/mailer/index.js'
import { renderMail } from '../../lib/mailer/templates/index.js'
import { lockUserRefreshSessionMutations } from './sessionService.js'
import { recordAbuseEvent } from './abuseEvents.js'
import { holdGrowthRewardsAfterEmailVerification } from './growthRewards.js'
import { hashAuthToken, generateAuthToken } from './credentialPrimitives.js'
import { registrationProtectionIsEnforced, consumeAbuseBucket } from './authProtection.js'

export async function sendEmailVerification(userId: number, ip?: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) throw notFound('用户不存在')
  if (user.emailVerified) throw badRequest('邮箱已验证')

  if (registrationProtectionIsEnforced()) {
    await consumeAbuseBucket(() => consumeVerificationEmailSend({
      userId: user.id,
      email: user.email,
      ip: ip ?? '',
    }))
  }

  const rawToken = generateAuthToken()
  const issued = await prisma.$transaction(async tx => {
    await lockUserRefreshSessionMutations(tx, userId)
    const currentUser = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, emailVerified: true, status: true },
    })
    if (!currentUser) throw notFound('用户不存在')
    if (currentUser.status === '已封禁') throw badRequest('账号已被封禁')
    if (currentUser.emailVerified) return null

    // One active verification credential per account. The user lock makes
    // concurrent resend requests serialize before this invalidation/create
    // pair, so a stale link cannot remain usable after a newer send wins.
    await tx.emailVerificationToken.updateMany({
      where: { userId: currentUser.id, used: false },
      data: { used: true },
    })
    await tx.emailVerificationToken.create({
      data: {
        userId: currentUser.id,
        tokenHash: hashAuthToken(rawToken),
        expiresAt: new Date(Date.now() + config.emailVerificationTokenMaxAgeMs),
      },
    })
    return { email: currentUser.email }
  })

  if (!issued) throw badRequest('邮箱已验证')

  const mailer = await getMailer()
  const link = `${config.appBaseUrl}/verify-email#token=${rawToken}`
  await mailer.send(
    renderMail('email_verification', {
      to: issued.email,
      verifyUrl: link,
      expiresHours: 24,
    }),
  )
}

export async function verifyEmailWithToken(userId: number, rawToken: string) {
  if (typeof rawToken !== 'string' || rawToken.length === 0 || rawToken.length > 4_096) {
    throw badRequest('验证链接无效或已过期', 'BAD_REQUEST')
  }
  const tokenHash = hashAuthToken(rawToken)
  const claimed = await prisma.$transaction(async tx => {
    // Serialize verification with resend and other account credential
    // transitions. The token update itself remains the atomic owner/expiry
    // claim, so a cross-account or concurrent request changes no state.
    await lockUserRefreshSessionMutations(tx, userId)
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, emailVerified: true, status: true },
    })
    if (!user || user.status === '已封禁' || user.emailVerified) return false

    const claim = await tx.emailVerificationToken.updateMany({
      where: {
        tokenHash,
        userId,
        used: false,
        expiresAt: { gt: new Date() },
      },
      data: { used: true },
    })
    if (claim.count !== 1) return false

    const verifiedAt = new Date()
    await tx.user.update({
      where: { id: userId },
      data: { emailVerified: verifiedAt },
    })
    await holdGrowthRewardsAfterEmailVerification(tx, { userId, verifiedAt })
    await recordAbuseEvent({
      type: 'email_verification_succeeded',
      userId,
    }, tx)
    return true
  })

  if (!claimed) throw badRequest('验证链接无效或已过期', 'BAD_REQUEST')
}
