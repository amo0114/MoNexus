export interface MailMessage {
  to: string
  subject: string
  text: string
  html?: string
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>
}
