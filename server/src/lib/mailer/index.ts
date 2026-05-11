import { config } from '../../config/index.js'
import { ConsoleMailer } from './console.js'
import type { Mailer } from './types.js'

let cached: Mailer | null = null

// Lazy factory: nodemailer + SmtpMailer are only imported when SMTP is
// actually configured, keeping the test boot time fast.
export async function getMailer(): Promise<Mailer> {
  if (cached) return cached

  let mailer: Mailer
  if (config.mailer.kind === 'console') {
    mailer = new ConsoleMailer()
  } else {
    const { SmtpMailer } = await import('./smtp.js')
    mailer = new SmtpMailer(config.mailer)
  }
  cached = mailer
  return mailer
}

// Test-only: swap the mailer with a CaptureMailer to assert sent mail.
export function __setMailerForTesting(mailer: Mailer | null) {
  cached = mailer
}

export type { Mailer, MailMessage } from './types.js'
