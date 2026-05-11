import { Mailer, MailMessage } from './types.js'

// Dev/test fallback. Logs the email to stdout so a developer can grab
// reset-password links from the terminal during local dev without a
// real SMTP server. NEVER selected when NODE_ENV=production (the
// config validator forces SMTP env vars in production).
export class ConsoleMailer implements Mailer {
  async send(msg: MailMessage): Promise<void> {
    console.log(
      `\n[mailer] to: ${msg.to}\n[mailer] subject: ${msg.subject}\n[mailer] ----- text -----\n${msg.text}\n[mailer] ----- end -----\n`
    )
  }
}
