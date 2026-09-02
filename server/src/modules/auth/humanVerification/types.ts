/**
 * Server-side expected `action` values. Each protected flow renders its widget
 * with the matching action, so a proof minted for one flow can never be
 * replayed against another.
 */
export type HumanVerificationAction = 'register' | 'forgot_password'

export type HumanVerificationProvider = 'off' | 'altcha' | 'turnstile'

export type HumanVerificationResult =
  | { kind: 'verified' }
  | { kind: 'rejected' }
  | { kind: 'unavailable' }

export interface HumanVerifier {
  verify(input: {
    payload: string
    ip: string | undefined
    action: HumanVerificationAction
  }): Promise<HumanVerificationResult>
}

export const HUMAN_VERIFICATION_PAYLOAD_MAX_BYTES = 16 * 1024
export const ALTCHA_PROTOCOL_VERSION = '1'
export const ALTCHA_CHALLENGE_URL = '/api/auth/human-challenge'

export const VERIFIED: HumanVerificationResult = { kind: 'verified' }
export const REJECTED: HumanVerificationResult = { kind: 'rejected' }
export const UNAVAILABLE: HumanVerificationResult = { kind: 'unavailable' }
