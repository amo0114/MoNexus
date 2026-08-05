import type { NextFunction, Request, Response } from 'express'
import { Writable } from 'node:stream'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { api, authHeader, createTestUser, loginAs } from './helpers.js'
import { config } from '../config/index.js'
import { prisma } from '../lib/prisma.js'
import { normalizedEmailSchema } from '../lib/email.js'
import { loggerRedact } from '../lib/logger.js'
import { CaptureMailer } from '../lib/mailer/capture.js'
import { __setMailerForTesting, type Mailer } from '../lib/mailer/index.js'
import {
  MAIL_TEST_ADMIN_LOG_ACTION,
  MAIL_TEST_ADMIN_LOG_TARGET_TYPE,
  MAIL_TEST_SUBJECT,
  getMailDeliveryStatus,
} from '../modules/admin/mailOperations.js'
import {
  ADMIN_MAIL_TEST_LIMIT,
  ADMIN_MAIL_TEST_WINDOW_MS,
  adminMailTestLimiter,
  createAdminMailTestLimiter,
} from '../modules/admin/mailTestLimiter.js'

type MailerConfig = typeof config.mailer
type MutableConfig = { mailer: MailerConfig }

/** DTO 的字段集合是封闭白名单，任何新增字段都必须先改规格。 */
const STATUS_FIELDS = ['authConfigured', 'configuredVia', 'deliveryReady', 'from', 'mode']

// 金丝雀：这些值一旦出现在响应或审计里，就是泄漏。
const CANARY_HOST = 'smtp.internal-canary.invalid'
const CANARY_USER = 'canary-smtp-user@internal.invalid'
const CANARY_PASS = 'canary-smtp-password-9f3a'

let originalMailer: MailerConfig

function setMailerConfig(next: MailerConfig) {
  ;(config as unknown as MutableConfig).mailer = next
}

function smtpConfig(overrides: Partial<Omit<Extract<MailerConfig, { kind: 'smtp' }>, 'kind'>> = {}) {
  const user = 'user' in overrides ? overrides.user : CANARY_USER
  const explicitFrom = 'displayFrom' in overrides ? overrides.displayFrom : undefined
  return {
    kind: 'smtp' as const,
    host: CANARY_HOST,
    port: 587,
    secure: false,
    user,
    pass: 'pass' in overrides ? overrides.pass : CANARY_PASS,
    // 生产语义：实际生效发件地址是 SMTP_FROM ?? SMTP_USER。
    from: 'from' in overrides ? overrides.from : explicitFrom ?? user,
    displayFrom: explicitFrom,
  }
}

class FailingMailer implements Mailer {
  constructor(private readonly error: Error) {}
  async send(): Promise<void> {
    throw this.error
  }
}

async function loginAdmin(email: string) {
  const { user, password } = await createTestUser(email, 'admin123', 'admin')
  const { accessToken } = await loginAs(user.email, password)
  return { user, accessToken }
}

function mailTestLogs(adminUserId?: number) {
  return prisma.adminLog.findMany({
    where: {
      targetType: MAIL_TEST_ADMIN_LOG_TARGET_TYPE,
      ...(adminUserId === undefined ? {} : { adminUserId }),
    },
    orderBy: { id: 'asc' },
  })
}

function parsedDetails(logs: Array<{ detail: string | null }>) {
  return logs.map(log => JSON.parse(log.detail ?? '{}'))
}

beforeEach(() => {
  originalMailer = config.mailer
})

afterEach(() => {
  // 配置与 mailer 缓存都是进程级单例，任何一处泄漏都会污染后续套件（R5）。
  setMailerConfig(originalMailer)
  __setMailerForTesting(null)
  vi.useRealTimers()
})

describe('mail delivery status DTO (P.5)', () => {
  it('reports the console fallback as not ready', async () => {
    setMailerConfig({ kind: 'console' })

    expect(getMailDeliveryStatus()).toEqual({
      mode: 'console',
      deliveryReady: false,
      from: null,
      authConfigured: false,
      configuredVia: 'environment',
    })
  })

  it('returns the explicitly configured SMTP_FROM only', () => {
    setMailerConfig(smtpConfig({ displayFrom: 'noreply@monexus.test' }))

    expect(getMailDeliveryStatus()).toEqual({
      mode: 'smtp',
      deliveryReady: true,
      from: 'noreply@monexus.test',
      authConfigured: true,
      configuredVia: 'environment',
    })
  })

  it('stays ready with a SMTP_USER fallback while never echoing it (C3)', () => {
    // 只配 SMTP_USER：投递可用，但发件地址不公开展示。
    setMailerConfig(smtpConfig())

    const status = getMailDeliveryStatus()
    expect(status.deliveryReady).toBe(true)
    expect(status.from).toBeNull()
    expect(JSON.stringify(status)).not.toContain(CANARY_USER)
  })

  it('decouples authConfigured from deliveryReady (C4)', () => {
    // 免认证 relay：没有 user/pass 也可能是正常的受控中继。
    setMailerConfig(smtpConfig({ user: undefined, pass: undefined, displayFrom: 'relay@monexus.test' }))
    expect(getMailDeliveryStatus()).toMatchObject({ deliveryReady: true, authConfigured: false })

    // 有 user 无 pass：认证不完整，但发件地址仍然有效。
    setMailerConfig(smtpConfig({ pass: undefined }))
    expect(getMailDeliveryStatus()).toMatchObject({ deliveryReady: true, authConfigured: false })

    // 既无 SMTP_FROM 也无 SMTP_USER：没有生效发件地址，不就绪。
    setMailerConfig(smtpConfig({ user: undefined, from: undefined }))
    expect(getMailDeliveryStatus()).toMatchObject({ deliveryReady: false, from: null })
  })

  it('serializes exactly five whitelisted fields with no SMTP secret (P.5)', async () => {
    const { accessToken } = await loginAdmin('mail-status-admin@test.local')
    setMailerConfig(smtpConfig({ displayFrom: 'noreply@monexus.test' }))

    const res = await api.get('/api/admin/mail/status').set(authHeader(accessToken)).expect(200)

    expect(Object.keys(res.body).sort()).toEqual(STATUS_FIELDS)
    const serialized = JSON.stringify(res.body)
    for (const canary of [CANARY_HOST, CANARY_USER, CANARY_PASS, 'SMTP_', 'host', 'pass', '587']) {
      expect(serialized).not.toContain(canary)
    }
    expect(res.body).toEqual({
      mode: 'smtp',
      deliveryReady: true,
      from: 'noreply@monexus.test',
      authConfigured: true,
      configuredVia: 'environment',
    })
  })

  it('does not open an SMTP connection to answer the status call', async () => {
    const { accessToken } = await loginAdmin('mail-status-noprobe@test.local')
    setMailerConfig(smtpConfig({ displayFrom: 'noreply@monexus.test' }))
    // 状态接口若探测网络，就会取用 mailer 单例；放一个必炸的实现做探针。
    __setMailerForTesting(new FailingMailer(new Error('status endpoint must not send')))

    await api.get('/api/admin/mail/status').set(authHeader(accessToken)).expect(200)
  })
})

describe('POST /api/admin/mail/test', () => {
  it('sends fixed, business-data-free content to the normalized recipient (P.6)', async () => {
    const { user: admin, accessToken } = await loginAdmin('mail-send-admin@test.local')
    setMailerConfig(smtpConfig({ displayFrom: 'noreply@monexus.test' }))
    const capture = new CaptureMailer()
    __setMailerForTesting(capture)

    const res = await api
      .post('/api/admin/mail/test')
      .set(authHeader(accessToken))
      .send({ email: '  OPS.Team@Test.Local  ' })
      .expect(200)

    expect(res.body).toEqual({ message: '测试邮件已提交发送' })
    expect(capture.sent).toHaveLength(1)
    const sent = capture.sent[0]
    // trim + lowercase 规范形（P.6）。
    expect(sent.to).toBe('ops.team@test.local')
    expect(sent.subject).toBe(MAIL_TEST_SUBJECT)
    expect(typeof sent.html).toBe('string')
    expect(sent.html!.length).toBeGreaterThan(0)
    expect(sent.text).toContain('MoNexus')
    expect(sent.text).toMatch(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/)
    // 纯文本无链接、无 token、无业务数据（MAIL-04）；HTML 仅允许品牌静态资源 URL。
    expect(sent.text).not.toMatch(/https?:\/\//)
    expect(sent.text).not.toContain(admin.email)
    expect(sent.text).not.toContain(accessToken)
    expect(sent.html).not.toContain(admin.email)
    expect(sent.html).not.toContain(accessToken)
    expect(sent.html).not.toMatch(/token=/i)

    // 审计：attempt + sent 两行，收件人只留脱敏形态。
    const logs = await mailTestLogs(admin.id)
    expect(logs.map(log => log.action)).toEqual([MAIL_TEST_ADMIN_LOG_ACTION, MAIL_TEST_ADMIN_LOG_ACTION])
    const details = parsedDetails(logs)
    expect(details.map(d => d.phase)).toEqual(['attempt', 'sent'])
    expect(details.every(d => d.recipient === 'op***@test.local')).toBe(true)
    // 两行共用同一 correlation id。
    expect(new Set(details.map(d => d.correlationId)).size).toBe(1)
    for (const log of logs) {
      expect(log.detail).not.toContain('ops.team@test.local')
    }
  })

  it('rejects with 409 and sends nothing under the console fallback (MAIL-03)', async () => {
    const { user: admin, accessToken } = await loginAdmin('mail-console-admin@test.local')
    setMailerConfig({ kind: 'console' })
    const capture = new CaptureMailer()
    __setMailerForTesting(capture)

    const res = await api
      .post('/api/admin/mail/test')
      .set(authHeader(accessToken))
      .send({ email: 'ops@test.local' })
      .expect(409)

    expect(res.body.error).toMatchObject({
      code: 'MAILER_NOT_CONFIGURED',
      message: '尚未配置真实 SMTP，无法发送测试邮件',
    })
    expect(capture.sent).toHaveLength(0)

    const details = parsedDetails(await mailTestLogs(admin.id))
    expect(details.map(d => d.phase)).toEqual(['rejected'])
    expect(details[0].recipient).toBe('op***@test.local')
  })

  it('classifies a provider failure without leaking its payload (C10 / P.8)', async () => {
    const { user: admin, accessToken } = await loginAdmin('mail-failure-admin@test.local')
    setMailerConfig(smtpConfig({ displayFrom: 'noreply@monexus.test' }))
    const providerError = Object.assign(
      new Error(`535 auth failed: user=${CANARY_USER} password=${CANARY_PASS}`),
      { code: 'EAUTH', response: `535 ${CANARY_PASS}` }
    )
    __setMailerForTesting(new FailingMailer(providerError))

    const res = await api
      .post('/api/admin/mail/test')
      .set(authHeader(accessToken))
      .send({ email: 'ops@test.local' })
      .expect(500)

    expect(res.body.error.message).toContain('EAUTH')
    const serialized = JSON.stringify(res.body)
    for (const canary of [CANARY_USER, CANARY_PASS, '535', 'auth failed']) {
      expect(serialized).not.toContain(canary)
    }

    const logs = await mailTestLogs(admin.id)
    const details = parsedDetails(logs)
    expect(details.map(d => d.phase)).toEqual(['attempt', 'failed'])
    expect(details[1].failure).toBe('EAUTH')
    for (const log of logs) {
      for (const canary of [CANARY_USER, CANARY_PASS, 'ops@test.local', '535']) {
        expect(log.detail).not.toContain(canary)
      }
    }
  })

  it('falls back to the UNKNOWN classification for unrecognized errors', async () => {
    const { user: admin, accessToken } = await loginAdmin('mail-unknown-admin@test.local')
    setMailerConfig(smtpConfig({ displayFrom: 'noreply@monexus.test' }))
    __setMailerForTesting(new FailingMailer(new Error('SMTP send exceeded total deadline (30000ms)')))

    const res = await api
      .post('/api/admin/mail/test')
      .set(authHeader(accessToken))
      .send({ email: 'ops@test.local' })
      .expect(500)

    expect(res.body.error.message).toContain('UNKNOWN')
    expect(res.body.error.message).not.toContain('30000')
    expect(parsedDetails(await mailTestLogs(admin.id))[1].failure).toBe('UNKNOWN')
  })

  it('validates the body strictly and never sends on a rejected payload', async () => {
    const { accessToken } = await loginAdmin('mail-validation-admin@test.local')
    setMailerConfig(smtpConfig({ displayFrom: 'noreply@monexus.test' }))
    const capture = new CaptureMailer()
    __setMailerForTesting(capture)

    const rejected: unknown[] = [
      { email: 'not-an-email' },
      { email: '' },
      { email: 12345 },
      { email: null },
      {},
      // strict：不允许调用方自定义主题/正文。
      { email: 'ops@test.local', subject: 'custom' },
      { email: 'ops@test.local', text: 'custom body' },
    ]

    for (const body of rejected) {
      await api
        .post('/api/admin/mail/test')
        .set(authHeader(accessToken))
        .send(body as Record<string, unknown>)
        .expect(400)
    }
    expect(capture.sent).toHaveLength(0)
  })
})

describe('email normalization idempotence (P.6)', () => {
  it('reaches a fixed point after one application', () => {
    const inputs = [
      '  OPS@Test.Local  ',
      'ops@test.local',
      'Mixed.Case+tag@Sub.Test.Local',
      '\tSPACED@test.local\n',
    ]

    for (const input of inputs) {
      const once = normalizedEmailSchema.parse(input)
      expect(normalizedEmailSchema.parse(once)).toBe(once)
      expect(once).toBe(once.trim().toLowerCase())
    }
  })
})

describe('admin mail route authorization', () => {
  it('requires an authenticated, active, MFA-verified administrator', async () => {
    const { user: admin } = await loginAdmin('mail-authz-admin@test.local')
    await createTestUser('mail-authz-user@test.local', 'pass123', 'user')
    const normalUser = await loginAs('mail-authz-user@test.local', 'pass123')
    const session = await prisma.refreshToken.findFirstOrThrow({
      where: { userId: admin.id, revoked: false },
      orderBy: { id: 'desc' },
    })
    const adminWithoutMfa = jwt.sign(
      { userId: admin.id, role: 'admin', sid: session.sessionId },
      config.jwtSecret,
      { expiresIn: '15m' }
    )
    setMailerConfig(smtpConfig({ displayFrom: 'noreply@monexus.test' }))
    const capture = new CaptureMailer()
    __setMailerForTesting(capture)

    await api.get('/api/admin/mail/status').expect(401)
    await api.post('/api/admin/mail/test').send({ email: 'ops@test.local' }).expect(401)
    await api.get('/api/admin/mail/status').set(authHeader(normalUser.accessToken)).expect(403)
    await api
      .post('/api/admin/mail/test')
      .set(authHeader(normalUser.accessToken))
      .send({ email: 'ops@test.local' })
      .expect(403)
    const statusMfa = await api.get('/api/admin/mail/status').set(authHeader(adminWithoutMfa)).expect(403)
    expect(statusMfa.body.error.code).toBe('MFA_REQUIRED')
    await api
      .post('/api/admin/mail/test')
      .set(authHeader(adminWithoutMfa))
      .send({ email: 'ops@test.local' })
      .expect(403)

    expect(capture.sent).toHaveLength(0)
    expect(await mailTestLogs()).toHaveLength(0)
  })
})

describe('admin mail test rate limit (P.7)', () => {
  /**
   * 直接驱动中间件而不是走 supertest：限流窗口要跨 10 分钟边界，只能靠伪造
   * 时钟；只 fake `Date`（MemoryStore 的过期判定完全基于 `Date.now()`），
   * 真实 timer 与 Prisma I/O 保持原样。
   */
  function invokeLimiter(
    limiter: ReturnType<typeof createAdminMailTestLimiter>,
    userId: number,
    body: unknown = { email: 'ops@test.local' }
  ): Promise<{ status?: number; code?: string }> {
    const req = { user: { userId, role: 'admin' }, body, headers: {}, ip: '127.0.0.1' } as unknown as Request
    const res = { headersSent: false, setHeader: () => undefined } as unknown as Response
    return new Promise(resolve => {
      const next = ((err?: unknown) => {
        const httpError = err as { status?: number; code?: string } | undefined
        resolve({ status: httpError?.status, code: httpError?.code })
      }) as NextFunction
      void limiter(req, res, next)
    })
  }

  it('allows three sends per administrator per window and recovers at the boundary', async () => {
    const { user: adminA } = await createTestUser('mail-limit-a@test.local', 'admin123', 'admin')
    const { user: adminB } = await createTestUser('mail-limit-b@test.local', 'admin123', 'admin')

    const start = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(start))
    const limiter = createAdminMailTestLimiter({ skipInTests: false })

    for (let i = 0; i < ADMIN_MAIL_TEST_LIMIT; i++) {
      expect(await invokeLimiter(limiter, adminA.id)).toEqual({ status: undefined, code: undefined })
    }
    expect(await invokeLimiter(limiter, adminA.id)).toEqual({ status: 429, code: 'RATE_LIMITED' })

    // 跨管理员额度独立。
    for (let i = 0; i < ADMIN_MAIL_TEST_LIMIT; i++) {
      expect(await invokeLimiter(limiter, adminB.id)).toEqual({ status: undefined, code: undefined })
    }
    expect(await invokeLimiter(limiter, adminB.id)).toEqual({ status: 429, code: 'RATE_LIMITED' })

    // 窗口尚未走完：仍然拒绝。
    vi.setSystemTime(new Date(start + ADMIN_MAIL_TEST_WINDOW_MS - 1))
    expect(await invokeLimiter(limiter, adminA.id)).toEqual({ status: 429, code: 'RATE_LIMITED' })

    // 恰好到点：额度重置。
    vi.setSystemTime(new Date(start + ADMIN_MAIL_TEST_WINDOW_MS))
    expect(await invokeLimiter(limiter, adminA.id)).toEqual({ status: undefined, code: undefined })
    vi.setSystemTime(new Date(start + ADMIN_MAIL_TEST_WINDOW_MS + 1))
    expect(await invokeLimiter(limiter, adminA.id)).toEqual({ status: undefined, code: undefined })

    vi.useRealTimers()

    // 每次拒绝恰好一条脱敏审计（P.8）；放行不写审计。
    const logsA = parsedDetails(await mailTestLogs(adminA.id))
    const logsB = parsedDetails(await mailTestLogs(adminB.id))
    expect(logsA.map(d => d.phase)).toEqual(['rate_limited', 'rate_limited'])
    expect(logsB.map(d => d.phase)).toEqual(['rate_limited'])
    expect(logsA.every(d => d.recipient === 'op***@test.local')).toBe(true)
  })

  it('counts malformed bodies and audits them as [invalid] (C5 / C6)', async () => {
    const { user: admin } = await createTestUser('mail-limit-malformed@test.local', 'admin123', 'admin')
    const limiter = createAdminMailTestLimiter({ skipInTests: false })

    // 限流挂在 body 校验之前：畸形请求同样消耗额度，否则失败重试就是免费的
    // 外发放大器。
    for (let i = 0; i < ADMIN_MAIL_TEST_LIMIT; i++) {
      expect(await invokeLimiter(limiter, admin.id, { email: 12345 })).toEqual({
        status: undefined,
        code: undefined,
      })
    }
    expect(await invokeLimiter(limiter, admin.id, { nope: true })).toEqual({
      status: 429,
      code: 'RATE_LIMITED',
    })

    const details = parsedDetails(await mailTestLogs(admin.id))
    expect(details.map(d => d.phase)).toEqual(['rate_limited'])
    expect(details[0].recipient).toBe('[invalid]')
  })

  it('bypasses the production singleton under NODE_ENV=test (F8)', async () => {
    const { user: admin } = await createTestUser('mail-limit-bypass@test.local', 'admin123', 'admin')

    for (let i = 0; i < ADMIN_MAIL_TEST_LIMIT + 3; i++) {
      expect(await invokeLimiter(adminMailTestLimiter, admin.id)).toEqual({
        status: undefined,
        code: undefined,
      })
    }
    expect(await mailTestLogs(admin.id)).toHaveLength(0)
  })
})

describe('SMTP credential redaction in structured logs (A.3)', () => {
  function serializeLog(payload: Record<string, unknown>) {
    let line = ''
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        line += chunk.toString()
        callback()
      },
    })
    pino({ base: undefined, timestamp: false, redact: loggerRedact }, destination)
      .info(payload, 'smtp-redaction-test')
    return JSON.parse(line) as Record<string, any>
  }

  it('censors credentials in env, config.mailer and nodemailer auth containers', () => {
    const logged = serializeLog({
      SMTP_USER: CANARY_USER,
      SMTP_PASS: CANARY_PASS,
      config: { mailer: { host: CANARY_HOST, user: CANARY_USER, pass: CANARY_PASS } },
      err: { context: { auth: { user: CANARY_USER, pass: CANARY_PASS } } },
      transport: { auth: { user: CANARY_USER, pass: CANARY_PASS } },
      // 反向断言：普通业务字段不能被"顺手"抹掉。
      req: { user: { userId: 42, role: 'admin' } },
      userId: 42,
    })

    const serialized = JSON.stringify(logged)
    expect(serialized).not.toContain(CANARY_USER)
    expect(serialized).not.toContain(CANARY_PASS)
    expect(logged.SMTP_USER).toBe('[redacted]')
    expect(logged.SMTP_PASS).toBe('[redacted]')
    expect(logged.config.mailer.user).toBe('[redacted]')
    expect(logged.config.mailer.pass).toBe('[redacted]')
    expect(logged.transport.auth.pass).toBe('[redacted]')
    expect(logged.err.context.auth.pass).toBe('[redacted]')
    expect(logged.req.user).toEqual({ userId: 42, role: 'admin' })
    expect(logged.userId).toBe(42)
  })
})
