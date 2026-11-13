import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { prepareStagingRuntime } from './prepare-staging-runtime.mjs'

const base = 'FRONTEND_ORIGIN=https://staging.monexus.oai-o.com\nTRUST_PROXY=2\nTURNSTILE_SITE_KEY=staging-fixture\nTURNSTILE_SECRET_KEY=staging-fixture-secret\n'

test('prepares only missing staging fields, preserving existing credentials and choices', () => {
  const result = prepareStagingRuntime(base + 'MAIL_CREDENTIALS_ENC_KEY=\n')
  assert.deepEqual(result.keys, ['DEPLOY_TOPOLOGY', 'HUMAN_VERIFICATION_PROVIDER', 'MAIL_CREDENTIALS_ENC_KEY', 'INTEGRATION_CREDENTIALS_ENC_KEY'])
  const keys = result.text.match(/(?:MAIL|INTEGRATION)_CREDENTIALS_ENC_KEY=([a-f0-9]{64})/g)
  assert.equal(keys.length, 2)
  assert.notEqual(keys[0].split('=')[1], keys[1].split('=')[1])
  assert.ok(result.text.includes('TURNSTILE_SECRET_KEY=staging-fixture-secret'))
  const repeated = prepareStagingRuntime(result.text)
  assert.deepEqual(repeated.keys, [])
  assert.ok(repeated.text.includes(keys[0]))
  assert.ok(repeated.text.includes(keys[1]))
  assert.deepEqual(prepareStagingRuntime(result.text.replace('PROVIDER=turnstile', 'PROVIDER=altcha')).keys, [])
})

test('rejects another origin, incompatible topology, duplicate assignments and malformed keys without exposing values', () => {
  for (const text of [base.replace('https://staging.monexus.oai-o.com', 'https://monexus.oai-o.com'), base.replace('TRUST_PROXY=2', 'TRUST_PROXY=1'), base + 'DEPLOY_TOPOLOGY=nginx', base + 'TRUST_PROXY=2', base + 'MAIL_CREDENTIALS_ENC_KEY=secret-sentinel']) {
    assert.throws(() => prepareStagingRuntime(text), error => !error.message.includes('secret-sentinel'))
  }
})

test('uses Docker Node 22 when a legacy host Node is installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'monexus-staging-node-'))
  try {
    const envFile = join(dir, '.env')
    const calls = join(dir, 'calls')
    writeFileSync(envFile, '')
    writeFileSync(join(dir, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    writeFileSync(join(dir, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$STAGING_TEST_CALLS"\nexit 0\n', { mode: 0o755 })
    const result = spawnSync('bash', ['scripts/staging-compose.sh', 'config'], {
      cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8',
      env: { ...process.env, PATH: dir + ':' + process.env.PATH, ENV_FILE: envFile, STAGING_TEST_CALLS: calls },
    })
    assert.equal(result.status, 0, result.stderr)
    const invoked = readFileSync(calls, 'utf8')
    assert.match(invoked, /run --rm --network none .*node:22-bookworm-slim/)
    assert.match(invoked, /config --no-interpolate/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
