import { test } from 'node:test'
import assert from 'node:assert/strict'
import { missingComposeEnvironment } from './check-compose-env.mjs'

test('checks both schema fields and adapter-owned credentials in the server service', () => {
  const config = 'const envSchema = z.object({ DATABASE_URL: z.string(), MAIL_CREDENTIALS_ENC_KEY: optional });'
  const provider = "const secret = env.PAYPAL_CLIENT_SECRET; const cert = readOptional('ALIPAY_APP_CERT')"
  const compose = 'services:\n  server:\n    environment:\n      DATABASE_URL: value\n  postgres:\n    environment:\n      MAIL_CREDENTIALS_ENC_KEY: wrong-service\n'
  assert.deepEqual(missingComposeEnvironment(config, [provider], compose), [
    'ALIPAY_APP_CERT', 'MAIL_CREDENTIALS_ENC_KEY', 'PAYPAL_CLIENT_SECRET',
  ])
  assert.deepEqual(missingComposeEnvironment(config, [provider], compose.replace('      DATABASE_URL: value',
    '      DATABASE_URL: value\n      MAIL_CREDENTIALS_ENC_KEY: value\n      PAYPAL_CLIENT_SECRET: value\n      ALIPAY_APP_CERT: value')), [])
})

test('follows the server environment anchor and requires the worker to receive the same environment', () => {
  const config = 'const envSchema = z.object({ DATABASE_URL: z.string(), JWT_SECRET: z.string() });'
  const compose = [
    'services:',
    '  server:', '    environment: &server-env', '      DATABASE_URL: value', '      JWT_SECRET: value',
    '      PROCESS_ROLE: api', '    networks:', '      - monexus',
    '  server-worker:', '    environment:', '      <<: *server-env', '      PROCESS_ROLE: worker',
    '  postgres:', '    image: postgres', '',
  ].join('\n')
  assert.deepEqual(missingComposeEnvironment(config, [], compose), [])
  assert.deepEqual(missingComposeEnvironment(config, [], compose.replace(
    '  server-worker:\n    environment:\n      <<: *server-env', '  server-worker:\n    environment:\n      DATABASE_URL: value')), [
    'server-worker:JWT_SECRET',
  ])
})
