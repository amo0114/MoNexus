import nodemailer, { Transporter } from 'nodemailer'
import { Mailer, MailMessage } from './types.js'

export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  from: string
}

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter

  constructor(private readonly cfg: SmtpConfig) {
    this.transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
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
