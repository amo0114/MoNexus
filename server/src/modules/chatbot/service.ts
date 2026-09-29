import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { prisma } from '../../lib/prisma.js'
import { badRequest, conflict, notFound, HttpError } from '../../lib/httpError.js'
import { getMailer } from '../../lib/mailer/index.js'
import { renderMail } from '../../lib/mailer/templates/render.js'
import { config } from '../../config/index.js'
import { consumeChatBindRequest, consumeChatBindConfirm } from './abusePolicy.js'

/**
 * SPEC-CHAT-BOT-001 —— 聊天机器人（QQ / Telegram）绑定与查询服务。
 *
 * 核心设计：绑定锚点是「邮箱」而非「网站绑定码」。
 *
 * 为什么：签到强制 requireVerifiedEmail，所以能用签到的人，邮箱必然已验证。
 * 邮箱是注册时用户亲自填并验证过的，本身就是一条既成的身份证明链。让用户
 * 在群里直接报邮箱、由后端发验证码，就不必先把人拉回网站——而这套机器人
 * 存在的意义正是服务「不来网站」的用户。
 *
 * 安全边界：
 * 1. 验证码 6 位数字、10 分钟过期、最多 5 次尝试。10^6 的空间必须限次，
 *    否则可被枚举。失败次数记在行上，超限即作废该码。
 * 2. 验证码只存 sha256，库被读也拿不到可用码。
 * 3. 绑定双向唯一：一个平台号 ↔ 一个站内账号，堵住建小号刷签到。
 * 4. 邮箱反查使用不区分大小写的精确匹配，且只对已验证邮箱发码。
 */

export const BIND_CODE_TTL_MS = 10 * 60 * 1000
export const BIND_CODE_MAX_ATTEMPTS = 5

function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

function generateBindCode(): string {
  // 6 位纯数字：用户在手机 QQ 里手输最省事。安全性由限次与短 TTL 保证。
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export function normalizePlatform(platform: string): string {
  const p = String(platform || '').trim().toLowerCase()
  if (!p || p.length > 32) throw badRequest('平台标识不合法')
  return p
}

export function normalizePlatformId(platformId: unknown): string {
  const id = String(platformId ?? '').trim()
  if (!id || id.length > 64) throw badRequest('平台账号标识不合法')
  return id
}

function normalizeEmail(email: unknown): string {
  const e = String(email ?? '').trim().toLowerCase()
  if (!e || e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    throw badRequest('邮箱格式不正确')
  }
  return e
}

/**
 * 发起绑定：向指定邮箱发送验证码。
 *
 * 安全设计的核心是**对外响应必须逐字节一致**：调用方（机器人）拿到的
 * `{ sent: true }` 在下列所有情况下完全相同，攻击者无法据响应差异推断
 * 任何信息：
 *
 *   邮箱不存在 / 未验证 / 被封禁      → 不发信
 *   邮箱已绑给别的平台账号            → 不发信（关键：防撞库）
 *   邮箱已绑给当前平台账号            → 发信（用户自己重发）
 *   邮箱可用但触发限流                → 不发信
 *
 * 为什么「已绑给他人」必须静默而非报错：若返回「该邮箱已绑定」，攻击者就能
 * 用它批量验证哪些邮箱是本平台用户（撞库）。用户侧的感受也不该有差别——
 * 那本来就是别人的邮箱，他不该收到任何关于它的提示。
 */
export async function requestBind(params: {
  platform: string
  platformId: unknown
  email: unknown
}) {
  const platform = normalizePlatform(params.platform)
  const platformId = normalizePlatformId(params.platformId)
  const email = normalizeEmail(params.email)

  // 统一的「已受理」响应。所有不发信的路径都返回它，保证外部不可区分。
  const accepted = { sent: true, ttlMs: BIND_CODE_TTL_MS, expiresAt: null as Date | null }

  // 该平台号已绑定时直接拒绝：这不是泄露——用户本来就知道自己绑过什么，
  // 且必须明确告知「先解绑」，否则他会困惑为什么发码没反应。
  const alreadyBound = await prisma.chatBinding.findUnique({
    where: { platform_platformId: { platform, platformId } },
  })
  if (alreadyBound) throw conflict('该账号已绑定，如需更换请先发送 /解绑')

  const user = await prisma.user.findFirst({
    where: { email, emailVerified: { not: null } },
    select: { id: true, email: true, status: true },
  })

  // 邮箱不存在 / 未验证 / 被封禁：静默返回，不泄露账号状态。
  if (!user || user.status !== '正常') return accepted

  // 反向检查（防撞库）：该邮箱若已绑给别的平台账号，这里必须停下。
  // 缺少这一步时，任何人都能对「已知的、属于他人的邮箱」反复触发发信——
  // 既骚扰用户，也消耗 SMTP 配额并损害发件域信誉。
  const emailBinding = await prisma.chatBinding.findUnique({
    where: { platform_userId: { platform, userId: user.id } },
    select: { platformId: true },
  })
  if (emailBinding && emailBinding.platformId !== platformId) return accepted

  // 限流：放在所有「已确认会真发信」的前置判定之后、任何写库与发信之前。
  // 被限流时同样返回 accepted——若这里回「请求过于频繁」，攻击者反而能借
  // 「是否被限流」反推该邮箱真实存在（因为他只对真实邮箱狂点才会触发限流）。
  const gate = await consumeChatBindRequest({ platform, platformId, email })
  if (!gate.allowed) return accepted

  const code = generateBindCode()
  const expiresAt = new Date(Date.now() + BIND_CODE_TTL_MS)

  // 同平台号重发即作废旧码，避免群里堆积多枚可用码。
  await prisma.$transaction(async tx => {
    await tx.chatBindCode.deleteMany({ where: { platform, platformId } })
    await tx.chatBindCode.create({
      data: {
        codeHash: hashCode(code),
        platform,
        platformId,
        userId: user.id,
        expiresAt,
      },
    })
  })

  // 邮件发送失败必须清理刚写入的验证码：否则会留下「码在库里、用户收不到」
  // 的脏数据，用户拿不到码却看到 500，无从判断该重试还是该找客服。
  // 与既有密码重置流程（auth/service.ts）的处理方式保持一致。
  try {
    const mailer = await getMailer()
    await mailer.send(
      renderMail('chat_bind_otp', {
        to: user.email,
        code,
        expiresMinutes: Math.round(BIND_CODE_TTL_MS / 60000),
      })
    )
  } catch (err) {
    await prisma.chatBindCode
      .deleteMany({ where: { platform, platformId } })
      .catch(() => {})
    // 不让 SMTP 的原始错误冒泡成 500：对用户是无意义的，且可能泄露内部细节。
    throw new HttpError(503, 'MAIL_DELIVERY_FAILED', '验证码邮件发送失败，请稍后重试')
  }

  return { sent: true, ttlMs: BIND_CODE_TTL_MS, expiresAt }
}

/**
 * 确认绑定：校验验证码并建立绑定关系。
 *
 * ⚠️ 关键实现约束：事务回调内**绝不抛业务异常**。
 *
 * Prisma 的交互式事务只要回调抛出异常就整体回滚——包括失败计数的那次
 * update。如果在这里直接 `throw badRequest('验证码不正确')`，failedAttempts
 * 会被一并回滚，攻击者就能无限次枚举 6 位码（10^6 空间），限次保护形同虚设。
 *
 * 因此事务内只做判定并把结论作为**返回值**送出，等事务提交、计数落库之后，
 * 再把结论翻译成 HTTP 错误。
 */
export async function confirmBind(params: {
  platform: string
  platformId: unknown
  code: unknown
}) {
  const platform = normalizePlatform(params.platform)
  const platformId = normalizePlatformId(params.platformId)
  const raw = String(params.code ?? '').trim()
  if (!/^\d{6}$/.test(raw)) throw badRequest('验证码应为 6 位数字')

  // 幂等短路：已绑定的 platformId 重复发 /确认 直接按成功处理。
  // 否则用户在绑定成功后多按一次，会收到「请先发送 /绑定」这种自相矛盾的
  // 提示——他刚刚才绑好。这里不对已绑定关系做任何修改。
  const already = await prisma.chatBinding.findUnique({
    where: { platform_platformId: { platform, platformId } },
  })
  if (already) {
    const boundUser = await prisma.user.findUnique({
      where: { id: already.userId },
      select: { id: true, nickname: true, status: true },
    })
    return {
      userId: already.userId,
      nickname: boundUser?.nickname ?? null,
      status: boundUser?.status ?? null,
      platform,
      platformId: already.platformId,
    }
  }

  // 限流：6 位码只有 10^6 空间，行上的 failedAttempts 是第一道闸（每枚码 5 次），
  // 这里是第二道——防止攻击者通过反复「发码 → 试 5 次 → 再发码」无限提高命中率。
  const gate = await consumeChatBindConfirm({ platform, platformId })
  if (!gate.allowed) throw badRequest('尝试次数过多，请稍后再试')

  type Outcome =
    | { kind: 'no_challenge' }
    | { kind: 'expired' }
    | { kind: 'too_many' }
    | { kind: 'bad_code'; remaining: number }
    | { kind: 'platform_taken' }
    | { kind: 'user_taken' }
    | { kind: 'consumed' }
    | { kind: 'ok'; payload: Record<string, unknown> }

  const outcome = await prisma.$transaction(async (tx): Promise<Outcome> => {
    const row = await tx.chatBindCode.findFirst({
      where: { platform, platformId, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    })
    if (!row) return { kind: 'no_challenge' }
    if (row.expiresAt.getTime() < Date.now()) return { kind: 'expired' }
    if (row.failedAttempts >= BIND_CODE_MAX_ATTEMPTS) return { kind: 'too_many' }

    // 先比哈希再累加失败数，避免把明文码写进日志或返回体。
    const expected = Buffer.from(row.codeHash, 'utf8')
    const actual = Buffer.from(hashCode(raw), 'utf8')
    const ok = expected.length === actual.length && timingSafeEqual(expected, actual)

    if (!ok) {
      const next = row.failedAttempts + 1
      await tx.chatBindCode.update({
        where: { id: row.id },
        data: {
          failedAttempts: next,
          // 触顶即作废，杜绝「慢速穷举」：每次都从 0 计数的话，
          // 攻击者可以永远试下去。
          ...(next >= BIND_CODE_MAX_ATTEMPTS ? { consumedAt: new Date() } : {}),
        },
      })
      return { kind: 'bad_code', remaining: BIND_CODE_MAX_ATTEMPTS - next }
    }

    // 冲突检查放在验码成功之后：避免未验码者探测绑定关系。
    const byPlatform = await tx.chatBinding.findUnique({
      where: { platform_platformId: { platform, platformId } },
    })
    if (byPlatform && byPlatform.userId !== row.userId) return { kind: 'platform_taken' }

    const byUser = await tx.chatBinding.findUnique({
      where: { platform_userId: { platform, userId: row.userId } },
    })
    if (byUser && byUser.platformId !== platformId) return { kind: 'user_taken' }

    const claimed = await tx.chatBindCode.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: new Date() },
    })
    if (claimed.count !== 1) return { kind: 'consumed' }

    const binding = byPlatform
      ? byPlatform
      : await tx.chatBinding.create({ data: { platform, platformId, userId: row.userId } })

    const user = await tx.user.findUnique({
      where: { id: row.userId },
      select: { id: true, nickname: true, status: true },
    })

    return {
      kind: 'ok',
      payload: {
        userId: row.userId,
        nickname: user?.nickname ?? null,
        status: user?.status ?? null,
        platform,
        platformId: binding.platformId,
      },
    }
  })

  // 事务已提交，失败计数已持久化，现在才翻译成 HTTP 错误。
  switch (outcome.kind) {
    case 'ok':
      return outcome.payload
    case 'no_challenge':
      throw notFound('请先在群里发送 /绑定 <邮箱> 获取验证码')
    case 'expired':
      throw badRequest('验证码已过期，请重新发送 /绑定 <邮箱>')
    case 'too_many':
      throw badRequest('尝试次数过多，请重新获取验证码')
    case 'bad_code':
      throw badRequest(
        outcome.remaining > 0
          ? `验证码不正确，还可尝试 ${outcome.remaining} 次`
          : '尝试次数过多，请重新获取验证码'
      )
    case 'platform_taken':
      throw conflict('该平台账号已绑定其他站内账号，请先 /解绑')
    case 'user_taken':
      throw conflict('该站内账号已绑定其他平台账号，请先 /解绑')
    case 'consumed':
      throw badRequest('验证码已被使用')
  }
}

export async function getBinding(userId: number, platform = 'qq') {
  return prisma.chatBinding.findUnique({
    where: { platform_userId: { platform: normalizePlatform(platform), userId } },
    select: { platform: true, platformId: true, createdAt: true },
  })
}

/** 解绑：已经绑定的 QQ 立刻失去签到与查询权限。 */
export async function unbind(userId: number, platform = 'qq') {
  const p = normalizePlatform(platform)
  const existing = await prisma.chatBinding.findUnique({
    where: { platform_userId: { platform: p, userId } },
  })
  if (!existing) throw notFound('尚未绑定')
  await prisma.chatBinding.delete({ where: { id: existing.id } })
  return { platform: p, platformId: existing.platformId }
}

/** 机器人每次请求都要做：platformId → userId。未绑定返回 null。 */
export async function resolveUserByPlatformId(platform: string, platformId: unknown) {
  const binding = await prisma.chatBinding.findUnique({
    where: {
      platform_platformId: {
        platform: normalizePlatform(platform),
        platformId: normalizePlatformId(platformId),
      },
    },
    select: { userId: true },
  })
  return binding?.userId ?? null
}

/**
 * 定时催签：返回「已绑定该平台 且 今天未签到」的正常状态用户。
 * 只查已绑定用户——未绑定的人机器人根本没法私聊。
 */
/**
 * 定时催签名单：返回「已绑定该平台 且 今天未签到」的正常状态用户。
 *
 * ⚠️ 只返回 platformId（数据最小化）。
 *
 * 催签只需要「把提醒发给谁」，不需要知道对方是哪个站内账号、叫什么昵称。
 * 早先的版本还返回 userId 与 nickname，等于把「QQ号 ↔ 账号ID ↔ 昵称」的
 * 完整对应表暴露在这个批量接口上——而它只靠 HMAC 保护，任何拿到
 * BOT_SHARED_SECRET 的一方都能一次拉走全量。键值对本身是敏感数据，
 * 且对催签功能毫无必要，故收窄。
 */
export async function listUncheckedBoundUsers(platform: string, dateStr: string) {
  const p = normalizePlatform(platform)
  return prisma.chatBinding.findMany({
    where: {
      platform: p,
      user: {
        status: '正常',
        checkins: { none: { date: dateStr } },
      },
    },
    select: { platformId: true },
  })
}

// ── 机器人请求签名（HMAC-SHA256） ─────────────────────────────────────────
// 机器人不是浏览器用户，不能给它发 JWT：长期 JWT 等同万能钥匙，泄露即全站
// 失守。改用共享密钥 HMAC + 时间戳防重放，密钥走 BOT_SHARED_SECRET。

export const BOT_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000

export function buildBotSignPayload(params: Record<string, unknown>): string {
  return Object.keys(params)
    .filter(k => k !== 'sign' && params[k] !== undefined && params[k] !== null)
    .sort()
    .map(k => `${k}=${String(params[k])}`)
    .join('&')
}

export function signBotParams(params: Record<string, unknown>, secret: string): string {
  if (!secret) throw new Error('BOT_SHARED_SECRET is empty')
  return createHmac('sha256', secret).update(buildBotSignPayload(params), 'utf8').digest('hex')
}

export function botSignaturesEqual(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(String(a ?? ''), 'utf8')
    const bb = Buffer.from(String(b ?? ''), 'utf8')
    if (ba.length !== bb.length) return false
    return timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}

export function chatBotChannelEnabled(): boolean {
  return Boolean(config.chatBot?.enabled)
}
