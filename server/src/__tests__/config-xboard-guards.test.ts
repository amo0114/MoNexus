import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const base = { PATH: process.env.PATH ?? '', DOTENV_CONFIG_PATH: '/dev/null', NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost/test', JWT_SECRET: 'test-only-secret-at-least-thirty-two-characters',
  FRONTEND_ORIGIN: 'http://localhost:5173', COOKIE_SECURE: 'false', XBOARD_ACCOUNT_QUERY_ENABLED: '',
  XBOARD_INSTANCE_ID: '', FAKA_BRIDGE_URL: '', FAKA_BRIDGE_SECRET: '', BOT_SHARED_SECRET: '', REDIS_ENABLED: 'false' }
const enabled = { XBOARD_ACCOUNT_QUERY_ENABLED: 'true', XBOARD_INSTANCE_ID: 'stable-panel',
  FAKA_BRIDGE_URL: 'https://xboard.test/plugin/faka-bridge/order-paid', FAKA_BRIDGE_SECRET: 'test-only-bridge-secret',
  BOT_SHARED_SECRET: 'test-only-bot-secret', REDIS_ENABLED: 'true' }
function load(overrides: Record<string, string>) {
  return spawnSync(process.execPath, ['--import', 'tsx', '-e',
    "import('./src/config/index.js').then(m=>{console.log('XBOARD='+JSON.stringify(m.config.xboardAccounts));process.exit(0)})"], {
    cwd: path.resolve(__dirname, '../..'), env: { ...base, ...overrides }, encoding: 'utf8', timeout: 10000,
  })
}
describe('Xboard query boot gates', () => {
  it('requires stable bridge credentials for paid checkout independently of QQ/Redis/free reset switches', () => {
    const flag = { XBOARD_PAID_RESET_TARGET_V2_ENABLED: 'true' }
    expect(load(flag).status).toBe(1)
    expect(load({ ...flag, XBOARD_INSTANCE_ID: 'stable-panel', FAKA_BRIDGE_URL: enabled.FAKA_BRIDGE_URL,
      FAKA_BRIDGE_SECRET: enabled.FAKA_BRIDGE_SECRET }).status).toBe(0)
    expect(load({ ...enabled, XBOARD_PAID_RESET_TARGET_V2_ENABLED: 'TRUE' }).status).toBe(1)
  })
  it('defaults to disabled and enables only with all dependencies', () => {
    const defaults = load({})
    expect(defaults.status, defaults.stderr).toBe(0)
    expect(defaults.stdout).toContain('"enabled":false')
    const result = load(enabled)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('"instanceId":"stable-panel"')
  })
  it.each(['XBOARD_INSTANCE_ID', 'FAKA_BRIDGE_URL', 'FAKA_BRIDGE_SECRET', 'BOT_SHARED_SECRET', 'REDIS_ENABLED'])('requires %s when enabled', key => {
    expect(load({ ...enabled, [key]: key === 'REDIS_ENABLED' ? 'false' : '' }).status).toBe(1)
  })
  it.each(['1', 'TRUE', 'yes'])('rejects ambiguous flag %s', flag => {
    expect(load({ ...enabled, XBOARD_ACCOUNT_QUERY_ENABLED: flag }).status).toBe(1)
  })
  it('rejects an unstable instance identifier', () => {
    expect(load({ ...enabled, XBOARD_INSTANCE_ID: 'https://user-input.test' }).status).toBe(1)
  })
  it('requires queries and a dedicated confirmation key for new reset requests', () => {
    expect(load({ ...enabled, TRAFFIC_RESET_REQUESTS_ENABLED: 'true' }).status).toBe(1)
    expect(load({ ...enabled, TRAFFIC_RESET_REQUESTS_ENABLED: 'true', TRAFFIC_RESET_CONFIRM_SECRET: 'short' }).status).toBe(1)
    expect(load({ ...enabled, TRAFFIC_RESET_REQUESTS_ENABLED: 'true', TRAFFIC_RESET_CONFIRM_SECRET: 'test-only-confirm-secret-at-least-32-chars' }).status).toBe(0)
  })
  it.each(['TRAFFIC_RESET_GRANT_ENABLED','TRAFFIC_RESET_DISPATCH_ENABLED'])('requires stable bridge configuration for %s', flag => {
    expect(load({ [flag]: 'true' }).status).toBe(1)
    expect(load({ ...enabled, [flag]: 'true' }).status).toBe(0)
    expect(load({ ...enabled, [flag]: 'TRUE' }).status).toBe(1)
  })

})
