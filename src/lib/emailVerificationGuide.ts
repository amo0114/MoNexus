export const EMAIL_VERIFICATION_REQUIRED_EVENT = 'monexus:email-verification-required'

/**
 * Opens the shared recovery UI after the server—not the browser—has decided
 * that a value-creating action requires a verified email. Keeping this as a
 * DOM event lets API callers remain framework-agnostic and preserves the
 * server's rollout switch as the sole authorization decision.
 */
export function showEmailVerificationGuide() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(EMAIL_VERIFICATION_REQUIRED_EVENT))
}
