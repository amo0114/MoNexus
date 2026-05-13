import { Mailer, MailMessage } from './types.js'

// Dev/test fallback. Logs only delivery metadata so local runs make the
// send path visible without exposing reset tokens or SMTP credentials.
export class ConsoleMailer implements Mailer {
  async send(msg: MailMessage): Promise<void> {
    console.log(
      `\n[mailer] console fallback\n[mailer] to: ${msg.to}\n[mailer] subject: ${msg.subject}\n[mailer] text_bytes: ${Buffer.byteLength(msg.text, 'utf8')}\n[mailer] html: ${msg.html ? 'yes' : 'no'}\n`
    )
  }
}
