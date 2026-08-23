import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'

const ADMIN_URL = 'postgresql://monexus:monexus_dev_2026@localhost:5432/postgres'
const EMPTY_DB = 'monexus_test_recharge_a_empty'
const UPGRADE_DB = 'monexus_test_recharge_a_upgrade'
const FOUNDATION_MIGRATION = '20260819120000_recharge_payment_foundation'
const ADMIN_SANDBOX_MIGRATION = '20260823183000_admin_sandbox_payment'
const NEW_MIGRATIONS = [FOUNDATION_MIGRATION, ADMIN_SANDBOX_MIGRATION] as const
const SERVER_ROOT = path.resolve(__dirname, '../..')
const created: string[] = []

function dbUrl(name: string) {
  return `postgresql://monexus:monexus_dev_2026@localhost:5432/${name}?schema=public`
}

async function recreateDatabase(name: string) {
  const admin = new Client({ connectionString: ADMIN_URL })
  await admin.connect()
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name])
  await admin.query(`DROP DATABASE IF EXISTS ${name}`)
  await admin.query(`CREATE DATABASE ${name} OWNER monexus`)
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

function copyPrisma(excludeNew: boolean) {
  const dir = path.join(tmpdir(), `recharge-migrate-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  cpSync(path.join(SERVER_ROOT, 'prisma'), path.join(dir, 'prisma'), { recursive: true })
  if (excludeNew) {
    for (const migration of NEW_MIGRATIONS) {
      rmSync(path.join(dir, 'prisma', 'migrations', migration), { recursive: true, force: true })
    }
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
})

describe('recharge foundation migration replay', () => {
  it('replays every migration including the foundation on an empty database', async () => {
    await recreateDatabase(EMPTY_DB)
    const schemaPath = copyPrisma(false)
    const result = migrateDeploy(dbUrl(EMPTY_DB), schemaPath)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout + result.stderr).toMatch(new RegExp(FOUNDATION_MIGRATION))
    expect(result.stdout + result.stderr).toMatch(new RegExp(ADMIN_SANDBOX_MIGRATION))

    const client = new Client({ connectionString: dbUrl(EMPTY_DB) })
    await client.connect()
    const tables = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'RechargeOrder'`,
    )
    const check = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'point_account_hard_cap_2000000000'`,
    )
    await client.end()
    expect(tables.rowCount).toBe(1)
    expect(check.rowCount).toBe(1)
  }, 180_000)

  it('applies the foundation migration on top of the latest develop schema', async () => {
    await recreateDatabase(UPGRADE_DB)
    const historicalSchema = copyPrisma(true)
    const historical = migrateDeploy(dbUrl(UPGRADE_DB), historicalSchema)
    expect(historical.status, historical.stdout + historical.stderr).toBe(0)
    expect(historical.stdout + historical.stderr).not.toMatch(new RegExp(FOUNDATION_MIGRATION))
    expect(historical.stdout + historical.stderr).not.toMatch(new RegExp(ADMIN_SANDBOX_MIGRATION))

    const clientBefore = new Client({ connectionString: dbUrl(UPGRADE_DB) })
    await clientBefore.connect()
    const before = await clientBefore.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'RechargeOrder'`,
    )
    expect(before.rowCount).toBe(0)
    await clientBefore.end()

    const fullSchema = copyPrisma(false)
    const upgraded = migrateDeploy(dbUrl(UPGRADE_DB), fullSchema)
    expect(upgraded.status, upgraded.stdout + upgraded.stderr).toBe(0)
    expect(upgraded.stdout + upgraded.stderr).toMatch(new RegExp(FOUNDATION_MIGRATION))
    expect(upgraded.stdout + upgraded.stderr).toMatch(new RegExp(ADMIN_SANDBOX_MIGRATION))

    const client = new Client({ connectionString: dbUrl(UPGRADE_DB) })
    await client.connect()
    const after = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'PaymentEvent'`,
    )
    const check = await client.query(
      `SELECT conname FROM pg_constraint WHERE conname = 'point_account_hard_cap_2000000000'`,
    )
    await client.end()
    expect(after.rowCount).toBe(1)
    expect(check.rowCount).toBe(1)
  }, 180_000)
})
