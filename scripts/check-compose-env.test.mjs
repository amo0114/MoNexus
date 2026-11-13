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
