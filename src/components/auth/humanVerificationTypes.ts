export type HumanVerificationAction = 'register' | 'forgot_password'

export type HumanVerificationDescriptor =
  | { provider: 'altcha'; challengeUrl: string }
  | { provider: 'turnstile'; siteKey: string }

export type HumanVerificationProof = {
  provider: 'altcha' | 'turnstile'
  payload: string
}

export type HumanVerificationHandle = {
  requestProof: () => Promise<HumanVerificationProof>
  reset: () => void
}

export type HumanVerificationWidgetProps = {
  descriptor: HumanVerificationDescriptor
  action: HumanVerificationAction
  onReadyChange?: (ready: boolean) => void
}

export const HUMAN_VERIFICATION_SOLVE_TIMEOUT_MS = 20_000
export const HUMAN_CHALLENGE_PATH = '/api/auth/human-challenge'

export function supportsAltchaRuntime() {
  return typeof window !== 'undefined'
    && typeof Worker === 'function'
    && typeof crypto !== 'undefined'
    && typeof crypto.subtle?.digest === 'function'
}
