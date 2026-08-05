import type { MailMessage } from '../types.js'
import {
  renderBookingReminder,
  type BookingReminderVars,
} from './kinds/bookingReminder.js'
import {
  renderEmailVerification,
  type EmailVerificationVars,
} from './kinds/emailVerification.js'
import {
  renderLowStock,
  type LowStockVars,
} from './kinds/lowStock.js'
import {
  renderMailTest,
  type MailTestVars,
} from './kinds/mailTest.js'
import {
  renderPasswordReset,
  type PasswordResetVars,
} from './kinds/passwordReset.js'
import {
  renderProvisionDegraded,
  type ProvisionDegradedVars,
} from './kinds/provisionDegraded.js'
import {
  renderProvisionOtp,
  type ProvisionOtpVars,
} from './kinds/provisionOtp.js'
import {
  renderSlaOverdue,
  type SlaOverdueVars,
} from './kinds/slaOverdue.js'
import {
  renderSubscriptionExpired,
  renderSubscriptionExpiring,
  type SubscriptionMailVars,
} from './kinds/subscription.js'

export type MailTemplateKind =
  | 'email_verification'
  | 'password_reset'
  | 'provision_email_otp'
  | 'mail_delivery_test'
  | 'low_stock'
  | 'sla_overdue'
  | 'booking_reminder'
  | 'subscription_expiring'
  | 'subscription_expired'
  | 'provision_degraded'

export type MailTemplateVarsMap = {
  email_verification: EmailVerificationVars
  password_reset: PasswordResetVars
  provision_email_otp: ProvisionOtpVars
  mail_delivery_test: MailTestVars
  low_stock: LowStockVars
  sla_overdue: SlaOverdueVars
  booking_reminder: BookingReminderVars
  subscription_expiring: SubscriptionMailVars
  subscription_expired: SubscriptionMailVars
  provision_degraded: ProvisionDegradedVars
}

/**
 * Render a branded transactional mail payload. Pure function: no I/O.
 * Callers still own rate limits, token minting, and transport.
 */
export function renderMail<K extends MailTemplateKind>(
  kind: K,
  vars: MailTemplateVarsMap[K],
): MailMessage {
  switch (kind) {
    case 'email_verification':
      return renderEmailVerification(vars as EmailVerificationVars)
    case 'password_reset':
      return renderPasswordReset(vars as PasswordResetVars)
    case 'provision_email_otp':
      return renderProvisionOtp(vars as ProvisionOtpVars)
    case 'mail_delivery_test':
      return renderMailTest(vars as MailTestVars)
    case 'low_stock':
      return renderLowStock(vars as LowStockVars)
    case 'sla_overdue':
      return renderSlaOverdue(vars as SlaOverdueVars)
    case 'booking_reminder':
      return renderBookingReminder(vars as BookingReminderVars)
    case 'subscription_expiring':
      return renderSubscriptionExpiring(vars as SubscriptionMailVars)
    case 'subscription_expired':
      return renderSubscriptionExpired(vars as SubscriptionMailVars)
    case 'provision_degraded':
      return renderProvisionDegraded(vars as ProvisionDegradedVars)
    default: {
      const _exhaustive: never = kind
      throw new Error(`Unknown mail template kind: ${String(_exhaustive)}`)
    }
  }
}
