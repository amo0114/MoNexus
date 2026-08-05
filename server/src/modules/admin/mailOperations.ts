import crypto from 'crypto'
import { config } from '../../config/index.js'
import { maskEmail } from '../../lib/email.js'
import { HttpError, mailerNotConfigured } from '../../lib/httpError.js'
import { logger } from '../../lib/logger.js'
import { getMailer } from '../../lib/mailer/index.js'
import { MAIL_TEST_SUBJECT as TEMPLATE_MAIL_TEST_SUBJECT, renderMail } from '../../lib/mailer/templates/index.js'
import { prisma } from '../../lib/prisma.js'

/**
 * 邮件状态 DTO：字段集合是封闭白名单（规格 §4.3）。
 *
 * MAIL-01 的实现方式是"只构造允许的字段"，而不是"从 config.mailer 里删掉
 * 敏感字段"——后者每加一个环境变量就多一次泄漏机会。
 */
export interface MailDeliveryStatus {
  mode: 'smtp' | 'console'
  deliveryReady: boolean
  from: string | null
  authConfigured: boolean
  configuredVia: 'environment'
}

/** 审计与前端提示都固定使用这个主题（C9）；与模板层同源。 */
export const MAIL_TEST_SUBJECT = TEMPLATE_MAIL_TEST_SUBJECT

export const MAIL_TEST_ADMIN_LOG_ACTION = '测试邮件投递'
export const MAIL_TEST_ADMIN_LOG_TARGET_TYPE = 'mailDelivery'

/** 收件人无法解析为邮箱时的审计占位（限流拒绝发生在 body 校验之前，C6）。 */
export const MAIL_TEST_INVALID_RECIPIENT = '[invalid]'

/**
 * 出网失败的分类白名单（C10）。原始 provider 报文可能包含认证头、内网主机名
 * 或完整连接串，既不进 HTTP 响应也不进 AdminLog——只留这四个稳定分类。
 */
export type MailTestFailureCode = 'EAUTH' | 'ETIMEDOUT' | 'ENOTFOUND' | 'UNKNOWN'

const FAILURE_CODE_WHITELIST: readonly MailTestFailureCode[] = [
  'EAUTH',
  'ETIMEDOUT',
  'ENOTFOUND',
]

/**
 * 审计阶段。`attempt` 是出网前的意图记录，其余四个是终态：
 * 每次调用恰好留下一条终态行（P.8）。
 */
export type MailTestAuditPhase = 'attempt' | 'sent' | 'failed' | 'rejected' | 'rate_limited'

interface MailTestAuditInput {
  adminUserId: number
  phase: MailTestAuditPhase
  /** 已脱敏的收件人，绝不接收原文。 */
  recipientMasked: string
  correlationId: string
  failure?: MailTestFailureCode
}

/**
 * 基于已解析的 `config.mailer` 生成状态 DTO；**不做任何 SMTP 网络探测**——
 * 刷新一次后台页面就对外建连，既会阻塞请求，也会把内网拓扑暴露成可探测面。
 */
export function getMailDeliveryStatus(): MailDeliveryStatus {
  const mailer = config.mailer
  if (mailer.kind === 'console') {
    return {
      mode: 'console',
      deliveryReady: false,
      from: null,
      authConfigured: false,
      configuredVia: 'environment',
    }
  }

  return {
    mode: 'smtp',
    // C3：就绪性看**实际生效**的发件 From 头（含 SMTP_USER 兜底与显示名）。
    // 缺显式 SMTP_FROM 不等于不可投递，不能据此禁用测试发送。
    deliveryReady: Boolean(mailer.from),
    // C3：只回显显式 SMTP_FROM。兜底值就是 SMTP_USER，回显它等于泄漏凭证
    // 的一半（MAIL-01）。`deliveryReady: true` + `from: null` 是合法组合。
    from: mailer.displayFrom ?? null,
    authConfigured: Boolean(mailer.user && mailer.pass),
    configuredVia: 'environment',
  }
}

export function classifyMailTestFailure(err: unknown): MailTestFailureCode {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && (FAILURE_CODE_WHITELIST as readonly string[]).includes(code)) {
    return code as MailTestFailureCode
  }
  return 'UNKNOWN'
}

/** 能解析出邮箱形态才脱敏，否则记占位符——绝不把畸形原文写进审计。 */
export function maskRecipientForAudit(email: unknown): string {
  if (typeof email !== 'string') return MAIL_TEST_INVALID_RECIPIENT
  const trimmed = email.trim()
  const at = trimmed.indexOf('@')
  if (at <= 0 || at === trimmed.length - 1 || trimmed.includes(' ')) {
    return MAIL_TEST_INVALID_RECIPIENT
  }
  return maskEmail(trimmed.toLowerCase())
}

export async function writeMailTestAudit(input: MailTestAuditInput) {
  await prisma.adminLog.create({
    data: {
      adminUserId: input.adminUserId,
      action: MAIL_TEST_ADMIN_LOG_ACTION,
      targetType: MAIL_TEST_ADMIN_LOG_TARGET_TYPE,
      // detail 是自由文本列，集中在这里序列化，保证任何写入点都只有脱敏字段。
      detail: JSON.stringify({
        phase: input.phase,
        recipient: input.recipientMasked,
        correlationId: input.correlationId,
        ...(input.failure ? { failure: input.failure } : {}),
      }),
    },
  })
}

/**
 * 发送一封受限测试邮件。
 *
 * C7 —— SMTP 与审计无法原子化，取"出网前先落 attempt 行"的顺序：
 *   1. attempt 写失败 → 直接抛出，**不发信**（宁可不发，也不留下无审计的外发）
 *   2. 发送
 *   3. 终态行写失败 → 500（调用方重试可能造成重复投递，见 runbook）
 * 全程不自动重试，两条行用同一 correlationId 关联。
 */
export async function sendMailDeliveryTest(params: { adminUserId: number; email: string }) {
  const { adminUserId, email } = params
  const status = getMailDeliveryStatus()
  const recipientMasked = maskRecipientForAudit(email)
  const correlationId = crypto.randomUUID()

  if (status.mode === 'console') {
    await writeMailTestAudit({ adminUserId, phase: 'rejected', recipientMasked, correlationId })
    throw mailerNotConfigured()
  }

  await writeMailTestAudit({ adminUserId, phase: 'attempt', recipientMasked, correlationId })

  const mailer = await getMailer()
  try {
    await mailer.send(
      renderMail('mail_delivery_test', {
        to: email,
        triggeredAtIso: new Date().toISOString(),
      }),
    )
  } catch (err) {
    const failure = classifyMailTestFailure(err)
    // 诊断只留分类与关联 id：原始报文可能含认证头/凭证（C10）。
    logger.warn({ correlationId, failure }, 'admin mail delivery test failed')
    await writeMailTestAudit({ adminUserId, phase: 'failed', recipientMasked, correlationId, failure })
    throw new HttpError(500, 'INTERNAL_SERVER_ERROR', `测试邮件发送失败（分类：${failure}）`)
  }

  await writeMailTestAudit({ adminUserId, phase: 'sent', recipientMasked, correlationId })
  return { message: '测试邮件已提交发送' }
}
