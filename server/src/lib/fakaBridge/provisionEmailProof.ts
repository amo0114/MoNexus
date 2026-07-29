import { createHash, randomInt } from 'node:crypto'
import { prisma } from '../prisma.js'
import { badRequest, tooManyRequests, provisionEmailUnverified } from '../httpError.js'
import { getMailer } from '../mailer/index.js'
import { config } from '../../config/index.js'
import { FAKA_PROVISION_EMAIL_KEYS } from './provisionEmail.js'

/** OTP 有效期 */
export const PROVISION_CODE_TTL_MS = 10 * 60 * 1000
/**
 * @deprecated 绑定已改为永久（proofExpiresAt = null）。保留常量仅兼容旧测试/调用方。
 * 历史 24h 窗口已废弃：验证一次即与 MoNexus 账号长期绑定。
 */
export const PROVISION_PROOF_TTL_MS = 0
const MAX_SENDS_PER_HOUR = 5
const MAX_CONFIRM_ATTEMPTS = 8
const MIN_RESEND_INTERVAL_MS = 60 * 1000

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

function assertEmailShape(email: string): string {
  const e = normalizeEmail(email)
  if (!e || !EMAIL_RE.test(e) || e.length > 255) {
    throw badRequest('Xboard 邮箱格式无效')
  }
  return e
}

function hashCode(userId: number, email: string, code: string): string {
  return createHash('sha256')
    .update(`${config.jwtSecret}:faka-provision:${userId}:${email}:${code}`)
    .digest('hex')
}

function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/**
 * Account login email that is already verified is trusted for provision
 * without a separate OTP (user proved ownership at signup/verify-email).
 */
export async function isProvisionEmailTrusted(
  userId: number,
  emailRaw: string
): Promise<boolean> {
  const email = assertEmailShape(emailRaw)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true, status: true },
  })
  if (!user || user.status !== '正常') return false

  if (user.emailVerified && user.email.toLowerCase() === email) {
    return true
  }

  const proof = await prisma.fakaProvisionEmailProof.findUnique({
    where: { userId_email: { userId, email } },
  })
  // Permanent bind: verifiedAt set + proofExpiresAt null.
  // Legacy rows may still have an expiry timestamp — honour until then.
  if (!proof?.verifiedAt) return false
  if (proof.proofExpiresAt == null) return true
  return proof.proofExpiresAt.getTime() > Date.now()
}

/** Resolve intended provision email from form answers for trust checks. */
export function peekProvisionEmailFromAnswers(
  formAnswers: Record<string, string> | null | undefined,
  accountEmail: string
): string {
  if (formAnswers) {
    for (const key of FAKA_PROVISION_EMAIL_KEYS) {
      const raw = formAnswers[key]
      if (raw == null) continue
      const v = String(raw).trim()
      if (v) return assertEmailShape(v)
    }
  }
  return assertEmailShape(accountEmail)
}

/**
 * Hard gate at order create: untrusted email → 400 (do not open on victim accounts).
 * Upgrade/downgrade on a trusted email are both allowed by design.
 */
export async function assertProvisionEmailTrusted(
  userId: number,
  emailRaw: string
): Promise<string> {
  const email = assertEmailShape(emailRaw)
  const ok = await isProvisionEmailTrusted(userId, email)
  if (!ok) {
    throw provisionEmailUnverified(
      '请先完成 Xboard 开通邮箱验证（向该邮箱发送验证码并确认）。禁止使用未验证的他人邮箱。'
    )
  }
  return email
}

export async function sendProvisionEmailCode(userId: number, emailRaw: string) {
  const email = assertEmailShape(emailRaw)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true, status: true },
  })
  if (!user || user.status !== '正常') throw badRequest('账号状态异常')

  // Already trusted → no mail needed
  if (await isProvisionEmailTrusted(userId, email)) {
    return { sent: false as const, alreadyTrusted: true as const, email }
  }

  const now = Date.now()
  const existing = await prisma.fakaProvisionEmailProof.findUnique({
    where: { userId_email: { userId, email } },
  })

  if (existing?.lastSentAt) {
    const since = now - existing.lastSentAt.getTime()
    if (since < MIN_RESEND_INTERVAL_MS) {
      throw tooManyRequests(
        `请 ${Math.ceil((MIN_RESEND_INTERVAL_MS - since) / 1000)} 秒后再发送验证码`
      )
    }
  }

  // Rolling hour window on sendCount
  let sendCount = existing?.sendCount ?? 0
  if (
    !existing?.lastSentAt ||
    now - existing.lastSentAt.getTime() > 60 * 60 * 1000
  ) {
    sendCount = 0
  }
  if (sendCount >= MAX_SENDS_PER_HOUR) {
    throw tooManyRequests('该邮箱验证码发送过于频繁，请一小时后再试')
  }

  const code = generateCode()
  const codeHash = hashCode(userId, email, code)
  const codeExpiresAt = new Date(now + PROVISION_CODE_TTL_MS)

  await prisma.fakaProvisionEmailProof.upsert({
    where: { userId_email: { userId, email } },
    create: {
      userId,
      email,
      codeHash,
      codeExpiresAt,
      sendCount: 1,
      lastSentAt: new Date(now),
      confirmAttempts: 0,
      verifiedAt: null,
      proofExpiresAt: null,
    },
    update: {
      codeHash,
      codeExpiresAt,
      sendCount: sendCount + 1,
      lastSentAt: new Date(now),
      confirmAttempts: 0,
      // Keep existing proof if still valid; sending a new code does not revoke proof
    },
  })

  const mailer = await getMailer()
  await mailer.send({
    to: email,
    subject: 'MoNexus 开通邮箱验证码',
    text: [
      `您正在 MoNexus 验证 Xboard 开通邮箱。`,
      ``,
      `验证码：${code}`,
      `有效期 10 分钟。`,
      ``,
      `如非本人操作，请忽略本邮件。他人无法在未持有验证码的情况下为您的面板账号开通或变更套餐。`,
    ].join('\n'),
  })

  return { sent: true as const, alreadyTrusted: false as const, email, expiresInSec: PROVISION_CODE_TTL_MS / 1000 }
}

export async function confirmProvisionEmailCode(
  userId: number,
  emailRaw: string,
  codeRaw: string
) {
  const email = assertEmailShape(emailRaw)
  const code = String(codeRaw ?? '').trim()
  if (!/^\d{6}$/.test(code)) throw badRequest('验证码格式无效')

  const row = await prisma.fakaProvisionEmailProof.findUnique({
    where: { userId_email: { userId, email } },
  })
  if (!row?.codeHash || !row.codeExpiresAt) {
    throw badRequest('请先发送验证码')
  }
  if (row.confirmAttempts >= MAX_CONFIRM_ATTEMPTS) {
    throw tooManyRequests('验证失败次数过多，请重新发送验证码')
  }
  if (row.codeExpiresAt.getTime() < Date.now()) {
    throw badRequest('验证码已过期，请重新发送')
  }

  const expected = hashCode(userId, email, code)
  if (expected !== row.codeHash) {
    await prisma.fakaProvisionEmailProof.update({
      where: { id: row.id },
      data: { confirmAttempts: { increment: 1 } },
    })
    throw badRequest('验证码错误')
  }

  const now = new Date()
  // Permanent account binding: null proofExpiresAt = never re-OTP for this user+email.
  await prisma.fakaProvisionEmailProof.update({
    where: { id: row.id },
    data: {
      verifiedAt: now,
      proofExpiresAt: null,
      codeHash: null,
      codeExpiresAt: null,
      confirmAttempts: 0,
    },
  })

  return {
    email,
    verified: true as const,
    bound: true as const,
    proofExpiresAt: null,
  }
}

/**
 * List Xboard emails permanently (or still validly) bound to this MoNexus user.
 * Used for checkout defaults / personal-center display.
 */
export async function listBoundProvisionEmails(userId: number): Promise<
  Array<{ email: string; verifiedAt: Date; permanent: boolean; proofExpiresAt: Date | null }>
> {
  const rows = await prisma.fakaProvisionEmailProof.findMany({
    where: {
      userId,
      verifiedAt: { not: null },
      OR: [{ proofExpiresAt: null }, { proofExpiresAt: { gt: new Date() } }],
    },
    orderBy: { verifiedAt: 'desc' },
    select: { email: true, verifiedAt: true, proofExpiresAt: true },
  })
  return rows
    .filter((r): r is typeof r & { verifiedAt: Date } => r.verifiedAt != null)
    .map(r => ({
      email: r.email,
      verifiedAt: r.verifiedAt,
      permanent: r.proofExpiresAt == null,
      proofExpiresAt: r.proofExpiresAt,
    }))
}

export async function getProvisionEmailStatus(userId: number, emailRaw: string) {
  const email = assertEmailShape(emailRaw)
  const trusted = await isProvisionEmailTrusted(userId, email)
  if (trusted) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerified: true },
    })
    if (user?.emailVerified && user.email.toLowerCase() === email) {
      return {
        email,
        trusted: true,
        bound: true as const,
        source: 'account' as const,
        proofExpiresAt: null,
      }
    }
    const proof = await prisma.fakaProvisionEmailProof.findUnique({
      where: { userId_email: { userId, email } },
    })
    return {
      email,
      trusted: true,
      bound: true as const,
      source: 'otp' as const,
      proofExpiresAt: proof?.proofExpiresAt ?? null,
    }
  }
  return {
    email,
    trusted: false,
    bound: false as const,
    source: null,
    proofExpiresAt: null,
  }
}
