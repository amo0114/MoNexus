import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../lib/prisma.js'

// Two persistent Node processes with independent provider caches share only
// PostgreSQL. The fake PayPal configuration is validated locally; no network
// request, payment or provider credential is involved.
const program = `
  import { createInterface } from 'node:readline';
  import { prisma } from './src/lib/prisma.ts';
  import { paymentSettingsDefinition } from './src/modules/admin/paymentSettings.ts';
  import { runtimePaymentSelection, paymentRevision } from './src/modules/payment/providers/runtime.ts';
  globalThis.fetch = async () => { throw new Error('Unexpected external request'); };
  const api = paymentSettingsDefinition('paypal').api;
  let pinned = null;
  for await (const line of createInterface({ input: process.stdin })) {
    const input = JSON.parse(line);
    try {
      let result;
      if (input.action === 'activate') {
        const before = await api.get();
        const saved = await api.save(input.actor, { expectedVersion: before.version,
          settings: { provider: 'paypal', mode: 'sandbox', merchantId: input.account, clientId: 'fixture-' + input.account },
          credentials: { provider: 'paypal', clientSecret: 'fixture-client-secret', webhookId: 'fixture-webhook' } });
        await api.test(input.actor, saved.version);
        result = await api.activate(input.actor, saved.version);
      } else if (input.action === 'disable') {
        result = await api.enabled(input.actor, (await api.get()).version, false);
      } else if (input.action === 'rollback') {
        result = await api.rollback(input.actor, (await api.get()).version);
      } else {
        let selected = null, unavailable = false;
        try { selected = await runtimePaymentSelection('paypal'); }
        catch (error) { if (error.code !== 'PAYMENT_PROVIDER_UNAVAILABLE') throw error; unavailable = true; }
        if (input.action === 'pin') pinned = selected?.revisionId ?? null;
        const historical = pinned ? await paymentRevision('paypal', pinned) : null;
        result = { pid: process.pid, unavailable, revisionId: selected?.revisionId ?? null,
          account: selected?.providerAccountKey ?? null, historicalRevisionId: historical?.revisionId ?? null,
          historicalAccount: historical?.providerAccountKey ?? null };
      }
      // Only public DTOs and identifiers cross stdout, never credential material.
      process.stdout.write(JSON.stringify({ ok: true, result }) + '\\n');
    } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? error.name }) + '\\n'); }
  }
  await prisma.$disconnect();
`

const children: ChildProcessWithoutNullStreams[] = []
function instance() {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], {
    cwd: process.cwd(), stdio: 'pipe', env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL!,
      INTEGRATION_CREDENTIALS_ENC_KEY: 'ab'.repeat(32), INTEGRATION_CREDENTIALS_ENC_KEY_PREVIOUS: '',
      RECHARGE_MODE: 'sandbox', PAYMENT_WEBHOOK_PUBLIC_BASE_URL: 'https://app.example.test',
      PAYMENT_ENABLED_PROVIDERS: '', PAYMENT_REGISTERED_PROVIDERS: '' },
  })
  children.push(child)
  // Capture neither stderr nor request payloads in assertion output.
  child.stderr.resume()
  const lines = createInterface({ input: child.stdout })
  return (input: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
    const finish = () => { clearTimeout(timer); lines.off('line', onLine); child.off('exit', onExit); child.off('error', onError) }
    const onLine = (line: string) => {
      finish()
      try {
        const message = JSON.parse(line)
        if (!message.ok) reject(new Error('Runtime instance failed: ' + message.code))
        else resolve(message.result)
      } catch { reject(new Error('Invalid runtime instance response')) }
    }
    const onExit = () => { finish(); reject(new Error('Runtime instance exited before responding')) }
    const onError = () => { finish(); reject(new Error('Runtime instance could not start')) }
    const timer = setTimeout(() => { finish(); reject(new Error('Runtime instance timed out')) }, 20_000)
    lines.once('line', onLine); child.once('exit', onExit); child.once('error', onError)
    child.stdin.write(JSON.stringify(input) + '\n')
  })
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null) return resolve()
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.stdin.end()
  })))
})

describe('runtime settings across independent instances', () => {
  it('publishes activations, disable and rollback to a warm peer while retaining its pinned account', async () => {
    const actor = await prisma.user.create({ data: { email: 'runtime-instances@test.local', password: 'fixture-only', role: 'admin' } })
    const a = instance(), b = instance()
    const initialA = await a({ action: 'read' }), initialB = await b({ action: 'read' })
    expect(initialA.pid).not.toBe(initialB.pid)
    expect(initialB.revisionId).toBeNull()
    const first = await a({ action: 'activate', actor: actor.id, account: 'merchantA' })
    expect(await b({ action: 'pin' })).toMatchObject({ revisionId: first.activeRevisionId, account: 'paypal:sandbox:merchantA' })
    const second = await a({ action: 'activate', actor: actor.id, account: 'merchantB' })
    expect(await b({ action: 'read' })).toMatchObject({ revisionId: second.activeRevisionId, account: 'paypal:sandbox:merchantB',
      historicalRevisionId: first.activeRevisionId, historicalAccount: 'paypal:sandbox:merchantA' })
    await a({ action: 'disable', actor: actor.id })
    expect(await b({ action: 'read' })).toMatchObject({ unavailable: true, historicalRevisionId: first.activeRevisionId })
    await a({ action: 'rollback', actor: actor.id })
    expect(await b({ action: 'read' })).toMatchObject({ unavailable: false, revisionId: first.activeRevisionId,
      historicalRevisionId: first.activeRevisionId, account: 'paypal:sandbox:merchantA' })
  }, 90_000)
})
