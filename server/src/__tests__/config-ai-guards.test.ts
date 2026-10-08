import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

// SPEC-AI-001 §15 config guards. config/index.ts exits at import time, so each
// case runs in a child process (same convention as config-realtime-guards).

const SERVER_ROOT = path.resolve(__dirname, '..', '..')

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  AI_CREDENTIALS_ENC_KEY: '',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
  JWT_SECRET: 'a-sufficiently-long-test-secret-32chars!!',
  FRONTEND_ORIGIN: 'http://localhost:5173',
  COOKIE_SECURE: 'false',
}

function loadAiConfig(overrides: Record<string, string>) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', ...BASE_ENV, ...overrides }
  const result = spawnSync(
    'npx',
    ['tsx', '-e', "import('./src/config/index.js').then((m) => { console.log('AI=' + JSON.stringify({ ...m.config.ai, openaiApiKey: m.config.ai.openaiApiKey ? 'set' : null })); process.exit(0) })"],
    { cwd: SERVER_ROOT, env, encoding: 'utf8', timeout: 60_000 },
  )
  const output = result.stdout + result.stderr
  const line = output.split('\n').find(item => item.startsWith('AI='))
  return { status: result.status, output, ai: line ? JSON.parse(line.slice(3)) : null }
}

describe('AI config guards (SPEC-AI-001 §15)', () => {
  it('defaults to everything off with a 40s timeout', () => {
    const result = loadAiConfig({})
    expect(result.status).toBe(0)
    expect(result.ai).toEqual({ enabled: false, productCopilotEnabled: false, openaiApiKey: null, credentialsEncKey: null, timeoutMs: 40_000 })
  })

  it('requires AI_ENABLED for the product copilot flag', () => {
    const result = loadAiConfig({ AI_PRODUCT_COPILOT_ENABLED: 'true' })
    expect(result.status).toBe(1)
    expect(result.output).toContain('AI_PRODUCT_COPILOT_ENABLED=true requires AI_ENABLED=true')
  })

  it('requires an OpenAI key when AI is enabled', () => {
    const result = loadAiConfig({ AI_ENABLED: 'true' })
    expect(result.status).toBe(1)
    expect(result.output).toContain('AI_ENABLED=true requires OPENAI_API_KEY')
  })

  it('keeps the timeout under the 60s proxy read timeout', () => {
    expect(loadAiConfig({ AI_TIMEOUT_MS: '60000' }).status).toBe(1)
    expect(loadAiConfig({ AI_TIMEOUT_MS: '1000' }).status).toBe(1)
    const ok = loadAiConfig({ AI_ENABLED: 'true', AI_PRODUCT_COPILOT_ENABLED: 'true', OPENAI_API_KEY: 'sk-test', AI_TIMEOUT_MS: '50000' })
    expect(ok.status).toBe(0)
    expect(ok.ai).toEqual({ enabled: true, productCopilotEnabled: true, openaiApiKey: 'set', credentialsEncKey: null, timeoutMs: 50_000 })
  })

  it('rejects malformed credential master keys without echoing them', () => {
    const malformed = 'MASTER_KEY_SENTINEL-not-hex'
    const result = loadAiConfig({ AI_CREDENTIALS_ENC_KEY: malformed })
    expect(result.status).toBe(1)
    expect(result.output).toContain('AI_CREDENTIALS_ENC_KEY')
    expect(result.output).not.toContain(malformed)
  })
})
