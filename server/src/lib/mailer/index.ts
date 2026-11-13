import { ConsoleMailer } from './console.js'
import type { Mailer } from './types.js'
import { getMailRuntimeConfig } from './runtimeConfig.js'

let overrideMailer: Mailer | null = null

// Lazy factory: nodemailer + SmtpMailer are only imported when SMTP is
// actually configured, keeping the test boot time fast.
export async function getMailer(runtime?: Awaited<ReturnType<typeof getMailRuntimeConfig>>): Promise<Mailer> {
  if (overrideMailer) return overrideMailer
  const { mailer: settings } = runtime ?? await getMailRuntimeConfig()

  let mailer: Mailer
  if (settings.kind === 'console') {
    mailer = new ConsoleMailer()
  } else {
    const { SmtpMailer } = await import('./smtp.js')
    mailer = new SmtpMailer(settings)
  }
  return mailer
}

// Test-only: swap the mailer with a CaptureMailer to assert sent mail.
export function __setMailerForTesting(mailer: Mailer | null) {
  overrideMailer = mailer
}

export type { Mailer, MailMessage } from './types.js'
