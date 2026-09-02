import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const CLOUDFLARE_TURNSTILE = /challenges\.cloudflare\.com|turnstile\/v0\/api\.js/

describe('ALTCHA default path bundle guard', () => {
  it('does not statically reference the Cloudflare Turnstile script on the ALTCHA widget path', () => {
    const widget = readFileSync('src/components/auth/HumanVerificationWidget.tsx', 'utf8')
    const login = readFileSync('src/pages/LoginPage.tsx', 'utf8')
    const forgot = readFileSync('src/pages/ForgotPasswordPage.tsx', 'utf8')
    const indexHtml = readFileSync('index.html', 'utf8')

    for (const source of [widget, login, forgot, indexHtml]) {
      expect(source).not.toMatch(CLOUDFLARE_TURNSTILE)
    }

    expect(widget).toContain("lazy(() => import('./TurnstileHumanVerification'))")
  })

  it('keeps Cloudflare Turnstile out of default production chunks when dist exists', () => {
    const distHtml = 'dist/index.html'
    const distAssets = 'dist/assets'
    if (!existsSync(distHtml) || !existsSync(distAssets)) return

    expect(readFileSync(distHtml, 'utf8')).not.toMatch(CLOUDFLARE_TURNSTILE)

    const defaultChunks = readdirSync(distAssets).filter(file => (
      file.endsWith('.js')
      && (file.startsWith('index-') || file.startsWith('altcha-'))
    ))
    expect(defaultChunks.length).toBeGreaterThan(0)
    for (const file of defaultChunks) {
      expect(readFileSync(path.join(distAssets, file), 'utf8'), file).not.toMatch(CLOUDFLARE_TURNSTILE)
    }
  })
})
