import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import pg from 'pg'
import 'dotenv/config'

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL
if (!url) throw new Error('Database URL required')
const migrations = new URL('../prisma/faka-migrations/', import.meta.url)
const names = (await readdir(migrations)).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort()
if (names[0] !== '0001_initial.sql') throw new Error('Plugin baseline migration missing')
const client = new pg.Client({ connectionString: url })
try {
  await client.connect()
  await client.query('BEGIN')
  await client.query("SET LOCAL lock_timeout = '5s'")
  await client.query("SET LOCAL statement_timeout = '15min'")
  await client.query("SELECT pg_advisory_xact_lock(hashtext('monexus:integration:faka_bridge'))")
  const { rows: [state] } = await client.query(`
    SELECT to_regprocedure('monexus_bind_legacy_fulfillment_provider()') IS NOT NULL AS core_ready
  `)
  if (!state.core_ready) throw new Error('Apply the compatible core migrations first')
  const { rows: [profile] } = await client.query(`
    SELECT EXISTS (SELECT 1 FROM "_prisma_migrations"
      WHERE migration_name = '20260729150000_external_offer_binding'
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS standalone
  `)
  if (!profile.standalone) throw new Error('Legacy installations use the Prisma migration profile')
  await client.query(`
    CREATE TABLE IF NOT EXISTS "FakaBridgeSchemaMigration" (
      "name" TEXT PRIMARY KEY, "checksum" TEXT NOT NULL
    )
  `)
  for (const name of names) {
    const sql = await readFile(new URL(name, migrations), 'utf8')
    const checksum = createHash('sha256').update(sql).digest('hex')
    const { rows: [previous] } = await client.query('SELECT "checksum" FROM "FakaBridgeSchemaMigration" WHERE "name" = $1', [name])
    if (previous) {
      if (previous.checksum !== checksum) throw new Error('Applied plugin migration differs from release')
      continue
    }
    await client.query(sql)
    await client.query('INSERT INTO "FakaBridgeSchemaMigration" ("name", "checksum") VALUES ($1, $2)', [name, checksum])
  }
  await client.query(`
    INSERT INTO "IntegrationConfig" ("key", "enabled", "version", "updatedAt")
    VALUES ('plugin:faka_bridge', false, 1, NOW())
    ON CONFLICT ("key") DO NOTHING
  `)
  await client.query('COMMIT')
  console.log('FakaBridge schema ready.')
} catch {
  await client.query('ROLLBACK').catch(() => {})
  console.error('FakaBridge schema installation failed. Confirm the database migration profile and retry.')
  process.exitCode = 1
} finally {
  await client.end()
}
