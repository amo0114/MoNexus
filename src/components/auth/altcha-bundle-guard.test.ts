import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ALTCHA default path bundle guard', () => {
  it('does not statically reference the Cloudflare Turnstile script on the ALTCHA widget path', () => {
    const widget = readFileSync('src/components/auth/HumanVerificationWidget.tsx', 'utf8')
    const login = readFileSync('src/pages/LoginPage.tsx', 'utf8')
    const forgot = readFileSync('src/pages/ForgotPasswordPage.tsx', 'utf8')
    const indexHtml = readFileSync('index.html', 'utf8')

    for (const source of [widget, login, forgot, indexHtml]) {
      expect(source).not.toContain('challenges.cloudflare.com')
      expect(source).not.toContain('turnstile/v0/api.js')
    }

    expect(widget).toContain("lazy(() => import('./TurnstileHumanVerification'))")
  })
})
