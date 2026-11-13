import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from 'pg'
import { PrismaClient } from '@prisma/client'
import { afterAll, describe, expect, it } from 'vitest'

const testUrl = new URL(process.env.TEST_DATABASE_URL!)
const adminUrl = new URL(testUrl)
adminUrl.pathname = '/postgres'
const ADMIN_URL = adminUrl.toString()
const EMPTY_DB = 'monexus_test_recharge_a_empty'
const UPGRADE_DB = 'monexus_test_recharge_a_upgrade'
const FOUNDATION_MIGRATION = '20260819120000_recharge_payment_foundation'
const ADMIN_SANDBOX_MIGRATION = '20260823183000_admin_sandbox_payment'
const ADMIN_SANDBOX_POLICY_MIGRATION = '20260823204000_admin_sandbox_price_policy'
const EXPECTED_PROVIDER_AMOUNT_MIGRATION = '20260901120000_payment_attempt_expected_provider_amount'
const QUOTED_AMOUNT_MIGRATION = '20260901121000_reconciliation_item_quoted_amount'
const RECOVERY_POINT_LOGS_MIGRATION = '20261024120000_payment_recovery_point_logs'
const RECOVERY_CREDIT_INDEX_MIGRATION = '20261109220000_recovery_credit_idx'
// Backfills growth eligibility from RechargeCredit and extends ReconciliationRun.
const WALLET_FINANCE_MIGRATION = '20261110120000_wallet_finance_after_sales'
// Governance depends on the payment and finance tables omitted by the historical replay.
const GOVERNANCE_MIGRATION = '20261112120000_backend_governance'
const RUNTIME_MIGRATIONS = [
  '20261113120000_mail_runtime_config',
  '20261113130000_integration_runtime_settings',
  '20261113140000_faka_runtime_binding',
  '20261113150000_payment_runtime_binding',
  '20261113150100_payment_revision_account_index',
] as const
const NEW_MIGRATIONS = [
  FOUNDATION_MIGRATION,
  ADMIN_SANDBOX_MIGRATION,
  ADMIN_SANDBOX_POLICY_MIGRATION,
  EXPECTED_PROVIDER_AMOUNT_MIGRATION,
  QUOTED_AMOUNT_MIGRATION,
  RECOVERY_POINT_LOGS_MIGRATION,
  RECOVERY_CREDIT_INDEX_MIGRATION,
  WALLET_FINANCE_MIGRATION,
  GOVERNANCE_MIGRATION,
  ...RUNTIME_MIGRATIONS,
] as const
const SERVER_ROOT = path.resolve(__dirname, '../..')
const created: string[] = []
const copied: string[] = []

function dbUrl(name: string) {
  const url = new URL(testUrl)
  url.pathname = `/${name}`
  url.searchParams.set('schema', 'public')
  return url.toString()
}

async function recreateDatabase(name: string) {
  const admin = new Client({ connectionString: ADMIN_URL })
  await admin.connect()
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name])
  await admin.query(`DROP DATABASE IF EXISTS ${name}`)
  await admin.query(`CREATE DATABASE ${name}`)
  await admin.end()
  created.push(name)
}

function migrateDeploy(url: string, schemaPath: string) {
  return spawnSync(
    path.join(SERVER_ROOT, 'node_modules/.bin/prisma'),
    ['migrate', 'deploy', '--schema', schemaPath],
    {
      cwd: SERVER_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: url,
      },
      timeout: 180_000,
    },
  )
}

function copyPrisma(excludedMigrations: readonly string[] = []) {
  const dir = path.join(tmpdir(), `recharge-migrate-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  cpSync(path.join(SERVER_ROOT, 'prisma'), path.join(dir, 'prisma'), { recursive: true })
  copied.push(dir)
  for (const migration of excludedMigrations) {
    rmSync(path.join(dir, 'prisma', 'migrations', migration), { recursive: true, force: true })
  }
  return path.join(dir, 'prisma', 'schema.prisma')
}

afterAll(async () => {
  const admin = new Client({ connectionString: ADMIN_URL })
  await admin.connect()
  for (const name of created) {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name])
    await admin.query(`DROP DATABASE IF EXISTS ${name}`)
  }
  await admin.end()
  for (const dir of copied) rmSync(dir, { recursive: true, force: true })
})

describe('recharge foundation migration replay', () => {
  it('replays every migration including the foundation on an empty database', async () => {
    await recreateDatabase(EMPTY_DB)
    const schemaPath = copyPrisma()
    const result = migrateDeploy(dbUrl(EMPTY_DB), schemaPath)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout + result.stderr).toMatch(new RegExp(FOUNDATION_MIGRATION))
    expect(result.stdout + result.stderr).toMatch(new RegExp(ADMIN_SANDBOX_MIGRATION))
    expect(result.stdout + result.stderr).toMatch(new RegExp(ADMIN_SANDBOX_POLICY_MIGRATION))
    expect(result.stdout + result.stderr).toMatch(new RegExp(EXPECTED_PROVIDER_AMOUNT_MIGRATION))
    expect(result.stdout + result.stderr).toMatch(new RegExp(QUOTED_AMOUNT_MIGRATION))
    expect(result.stdout + result.stderr).toMatch(new RegExp(RECOVERY_POINT_LOGS_MIGRATION))
    expect(result.stdout + result.stderr).toMatch(new RegExp(RECOVERY_CREDIT_INDEX_MIGRATION))
    expect(result.stdout + result.stderr).toMatch(new RegExp(GOVERNANCE_MIGRATION))

    const client = new Client({ connectionString: dbUrl(EMPTY_DB) })
    await client.connect()
    const tables = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'RechargeOrder'`,
    )
    const check = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'point_account_hard_cap_2000000000'`,
    )
    const expectedAmount = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'PaymentAttempt_expectedProviderAmountMinor_check'`,
    )
    const expectedCol = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'PaymentAttempt' AND column_name = 'expectedProviderAmountMinor'`,
    )
    await client.end()
    expect(tables.rowCount).toBe(1)
    expect(check.rowCount).toBe(1)
    expect(expectedAmount.rowCount).toBe(1)
    expect(expectedCol.rows[0]?.is_nullable).toBe('NO')
  }, 180_000)

  it('applies payment migrations after replaying the schema without payment tables', async () => {
    await recreateDatabase(UPGRADE_DB)
    const historicalSchema = copyPrisma(NEW_MIGRATIONS)
    const historical = migrateDeploy(dbUrl(UPGRADE_DB), historicalSchema)
    expect(historical.status, historical.stdout + historical.stderr).toBe(0)
    expect(historical.stdout + historical.stderr).not.toMatch(new RegExp(FOUNDATION_MIGRATION))
    expect(historical.stdout + historical.stderr).not.toMatch(new RegExp(ADMIN_SANDBOX_MIGRATION))
    expect(historical.stdout + historical.stderr).not.toMatch(new RegExp(ADMIN_SANDBOX_POLICY_MIGRATION))
    expect(historical.stdout + historical.stderr).not.toMatch(new RegExp(EXPECTED_PROVIDER_AMOUNT_MIGRATION))
    expect(historical.stdout + historical.stderr).not.toMatch(new RegExp(QUOTED_AMOUNT_MIGRATION))
    expect(historical.stdout + historical.stderr).not.toMatch(new RegExp(RECOVERY_POINT_LOGS_MIGRATION))
    expect(historical.stdout + historical.stderr).not.toMatch(new RegExp(RECOVERY_CREDIT_INDEX_MIGRATION))
    expect(historical.stdout + historical.stderr).not.toMatch(new RegExp(WALLET_FINANCE_MIGRATION))
    expect(historical.stdout + historical.stderr).not.toMatch(new RegExp(GOVERNANCE_MIGRATION))

    const clientBefore = new Client({ connectionString: dbUrl(UPGRADE_DB) })
    await clientBefore.connect()
    const before = await clientBefore.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'RechargeOrder'`,
    )
    expect(before.rowCount).toBe(0)
    await clientBefore.end()

    const fullSchema = copyPrisma()
    const upgraded = migrateDeploy(dbUrl(UPGRADE_DB), fullSchema)
    expect(upgraded.status, upgraded.stdout + upgraded.stderr).toBe(0)
    expect(upgraded.stdout + upgraded.stderr).toMatch(new RegExp(FOUNDATION_MIGRATION))
    expect(upgraded.stdout + upgraded.stderr).toMatch(new RegExp(ADMIN_SANDBOX_MIGRATION))
    expect(upgraded.stdout + upgraded.stderr).toMatch(new RegExp(ADMIN_SANDBOX_POLICY_MIGRATION))
    expect(upgraded.stdout + upgraded.stderr).toMatch(new RegExp(EXPECTED_PROVIDER_AMOUNT_MIGRATION))
    expect(upgraded.stdout + upgraded.stderr).toMatch(new RegExp(QUOTED_AMOUNT_MIGRATION))
    expect(upgraded.stdout + upgraded.stderr).toMatch(new RegExp(RECOVERY_POINT_LOGS_MIGRATION))
    expect(upgraded.stdout + upgraded.stderr).toMatch(new RegExp(RECOVERY_CREDIT_INDEX_MIGRATION))
    expect(upgraded.stdout + upgraded.stderr).toMatch(new RegExp(WALLET_FINANCE_MIGRATION))
    expect(upgraded.stdout + upgraded.stderr).toMatch(new RegExp(GOVERNANCE_MIGRATION))

    const client = new Client({ connectionString: dbUrl(UPGRADE_DB) })
    await client.connect()
    const after = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'PaymentEvent'`,
    )
    const check = await client.query(
      `SELECT conname FROM pg_constraint WHERE conname = 'point_account_hard_cap_2000000000'`,
    )
    const expectedAmount = await client.query(
      `SELECT conname FROM pg_constraint WHERE conname = 'PaymentAttempt_expectedProviderAmountMinor_check'`,
    )
    const expectedCol = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'PaymentAttempt' AND column_name = 'expectedProviderAmountMinor'`,
    )
    const recoveryIndex = await client.query(`SELECT indexname FROM pg_indexes WHERE indexname = 'PaymentRecoveryCase_rechargeCreditId_idx'`)
    const quotedCol = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'ReconciliationItem' AND column_name = 'quotedAmountMinor'`,
    )
    await client.end()
    expect(after.rowCount).toBe(1)
    expect(check.rowCount).toBe(1)
    expect(expectedAmount.rowCount).toBe(1)
    expect(expectedCol.rows[0]?.is_nullable).toBe('NO')
    expect(recoveryIndex.rowCount).toBe(1)
    expect(quotedCol.rowCount).toBe(1)
    expect(quotedCol.rows[0]?.is_nullable).toBe('YES')
  }, 180_000)

  it('upgrades populated pre-runtime tables without rewriting legacy accounts, tasks or links', async () => {
    const name = 'monexus_test_runtime_upgrade'
    await recreateDatabase(name)
    const historical = migrateDeploy(dbUrl(name), copyPrisma(RUNTIME_MIGRATIONS))
    expect(historical.status, historical.stdout + historical.stderr).toBe(0)
    const db = new PrismaClient({ datasourceUrl: dbUrl(name) })
    const client = new Client({ connectionString: dbUrl(name) })
    await client.connect()
    const tables = ['User', 'Product', 'Order', 'FakaBridgeTask', 'ProductShareLink',
      'RechargeQuote', 'RechargeOrder', 'PaymentIntent', 'PaymentAttempt', 'PaymentEvent', 'ReconciliationRun'] as const
    const snapshot = async () => {
      const result: Record<string, unknown> = {}
      for (const table of tables) result[table] = (await client.query(
        `SELECT to_jsonb(t) - 'configRevisionId' - 'providerCredentialRevisionId' AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`,
      )).rows
      return result
    }
    try {
      // Explicit selects let the current Prisma client seed the old schema,
      // where the new nullable binding columns do not exist yet.
      const user = await db.user.create({ data: { email: 'runtime-upgrade@test.local', password: 'fixture-only' }, select: { id: true } })
      const category = await db.productCategory.create({ data: { code: 'runtime-upgrade', label: 'runtime upgrade', normalizedLabel: 'runtime upgrade',
        createdByUserId: user.id, updatedByUserId: user.id }, select: { id: true } })
      const product = await db.product.create({ data: { name: 'legacy runtime product', type: '网络节点', price: 200,
        categoryId: category.id, deliveryMode: 'manual_service', stockMode: 'unlimited' }, select: { id: true } })
      const order = await db.order.create({ data: { userId: user.id, productId: product.id, price: 200,
        holdingPoints: 200, deliveryModeSnapshot: 'manual_service' }, select: { id: true } })
      await db.fakaBridgeTask.create({ data: { orderId: order.id, requestOrderNo: `MN-${order.id}`,
        emailSnapshot: user.id + '@test.local', skuSnapshot: 'legacy-monthly', xboardTradeNo: 'legacy-trade' }, select: { id: true } })
      await db.productShareLink.create({ data: { productId: product.id, status: 'ready', url: 'https://s.example.test/old',
        targetUrl: 'https://app.example.test/product/' + product.id }, select: { productId: true } })
      const policy = await db.rechargePricePolicy.create({ data: { code: 'runtime-upgrade', version: 1, currency: 'CNY', currencyScale: 2,
        pointsNumerator: 1n, pointsDenominator: 1n, minAmountMinor: 100n, maxAmountMinor: 100000n, amountStepMinor: 100n,
        dailyLimitMinor: 100000n, monthlyLimitMinor: 1000000n, limitTimeZone: 'UTC', status: 'active', effectiveAt: new Date() } })
      const common = { userId: user.id, pricePolicyId: policy.id, provider: 'stripe', paymentMethod: 'card',
        providerAccountKey: 'stripe:test:default', capabilityVersion: 'legacy', capabilityDigest: 'a'.repeat(64), currency: 'CNY',
        amountMinor: 1000n, effectiveMinAmountMinor: 100n, effectiveMaxAmountMinor: 100000n, basePoints: 1000n,
        bonusPoints: 0n, totalPoints: 1000n, amountSource: 'custom', expiresAt: new Date(Date.now() + 3600000) }
      const quote = await db.rechargeQuote.create({ data: common, select: { id: true } })
      const recharge = await db.rechargeOrder.create({ data: { ...common, quoteId: quote.id, pricePolicyCode: policy.code,
        pricePolicyVersion: 1, pointsNumerator: 1n, pointsDenominator: 1n, roundingMode: 'HALF_EVEN', currencyScale: 2,
        disclosureVersion: 'legacy', status: 'pending_payment' }, select: { id: true } })
      const intent = await db.paymentIntent.create({ data: { rechargeOrderId: recharge.id, amountMinor: 1000n,
        currency: 'CNY', status: 'processing', expiresAt: common.expiresAt }, select: { id: true } })
      const attempt = await db.paymentAttempt.create({ data: { paymentIntentId: intent.id, provider: common.provider,
        providerAccountKey: common.providerAccountKey, method: 'card', status: 'unknown', requestIdempotencyKey: 'legacy-request',
        actionType: 'none', expectedProviderAmountMinor: 1000n, providerPaymentId: 'pi_legacy' }, select: { id: true } })
      await db.paymentEvent.create({ data: { provider: common.provider, providerAccountKey: common.providerAccountKey,
        paymentAttemptId: attempt.id, source: 'webhook', verificationMethod: 'webhook_signature', dedupeKey: 'legacy-event',
        eventType: 'payment.succeeded', payloadSha256: 'b'.repeat(64), normalizedPayload: { fixture: true },
        signatureVerified: true, status: 'received', observedAt: new Date() }, select: { id: true } })
      await db.reconciliationRun.create({ data: { provider: common.provider, providerAccountKey: common.providerAccountKey,
        environment: 'sandbox', scopeType: 'manual', scopeKey: 'legacy-run', status: 'pending' }, select: { id: true } })
      const before = await snapshot()
      const upgraded = migrateDeploy(dbUrl(name), copyPrisma())
      expect(upgraded.status, upgraded.stdout + upgraded.stderr).toBe(0)
      for (const migration of RUNTIME_MIGRATIONS) expect(upgraded.stdout).toContain(migration)
      expect(await snapshot()).toEqual(before)
      for (const table of ['FakaBridgeTask', 'ProductShareLink', 'RechargeQuote', 'RechargeOrder', 'PaymentAttempt', 'PaymentEvent', 'ReconciliationRun']) {
        const field = table === 'FakaBridgeTask' || table === 'ProductShareLink' ? 'configRevisionId' : 'providerCredentialRevisionId'
        expect((await client.query(`SELECT "${field}" FROM "${table}"`)).rows).toEqual([{ [field]: null }])
      }
      expect(await db.integrationConfig.count()).toBe(0)
      expect(await db.integrationConfigRevision.count()).toBe(0)
      expect(await db.paymentRuntimeAccount.count()).toBe(0)
      expect((await client.query(`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'IntegrationConfigRevision_paymentAccountId_createdAt_idx'`)).rows).toEqual([{ indisvalid: true }])
    } finally {
      await db.$disconnect()
      await client.end()
    }
  }, 180_000)
})
