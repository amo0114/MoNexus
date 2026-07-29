import nodemailer, { Transporter } from 'nodemailer'
import { Mailer, MailMessage } from './types.js'

export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user?: string
  pass?: string
  from?: string
}

// 复审 R3:SMTP 硬超时——慢/挂起的 SMTP 服务不得无限占用调用方(尤其是
// 后台任务的通知租约窗口)。三段之和必须 **小于** provisionCron 的
// NOTIFY_LEASE_MS(有静态断言回归),否则租约到期重发会与在途发送重叠。
export const SMTP_CONNECTION_TIMEOUT_MS = 10_000
export const SMTP_GREETING_TIMEOUT_MS = 10_000
export const SMTP_SOCKET_TIMEOUT_MS = 15_000

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter

  constructor(private readonly cfg: SmtpConfig) {
    this.transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
      socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
      ...(cfg.user && cfg.pass ? { auth: { user: cfg.user, pass: cfg.pass } } : {}),
    })
  }

  async send(msg: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.cfg.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    })
  }
}
