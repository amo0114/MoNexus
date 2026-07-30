import { badRequest } from '../httpError.js'

/**
 * Purchase-form keys accepted as the Xboard account email.
 * Merchants should expose one of these on FakaBridge products so buyers can
 * open onto an existing panel account that differs from MoNexus login email.
 */
export const FAKA_PROVISION_EMAIL_KEYS = ['xboardEmail', 'xboard_email', 'email'] as const

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Resolve the email sent to Xboard FakaBridge.
 * Priority: purchase-form answer (first matching key) → MoNexus account email.
 */
export function resolveFakaProvisionEmail(
  formAnswers: Record<string, string> | null | undefined,
  accountEmail: string
): string {
  if (formAnswers) {
    for (const key of FAKA_PROVISION_EMAIL_KEYS) {
      const raw = formAnswers[key]
      if (raw == null) continue
      const email = String(raw).trim().toLowerCase()
      if (!email) continue
      if (!EMAIL_RE.test(email) || email.length > 255) {
        throw badRequest('Xboard 邮箱格式无效')
      }
      return email
    }
  }

  const fallback = accountEmail.trim().toLowerCase()
  if (!fallback || !EMAIL_RE.test(fallback)) {
    throw badRequest('账号邮箱无效，请填写要开通的 Xboard 邮箱')
  }
  return fallback
}
