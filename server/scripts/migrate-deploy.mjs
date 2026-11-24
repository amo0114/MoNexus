import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'

// Prisma's PostgreSQL driver does not consume libpq PGOPTIONS. Set startup
// options in the migration-only connection URL; never print that URL.
export function migrationUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Invalid migration database URL')
  }
  const options = url.searchParams.get('options') ?? ''
  url.searchParams.set('options', `${options} -c lock_timeout=5000`.trim())
  return url.toString()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = { ...process.env }
  for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
    if (env[key]) env[key] = migrationUrl(env[key])
  }
  const profile = await readFile(new URL('../prisma/migration-profile', import.meta.url), 'utf8')
    .catch(error => {
      if (error.code === 'ENOENT') return 'legacy'
      throw error
    })
  const preflight = new pg.Client({ connectionString: env.DIRECT_URL ?? env.DATABASE_URL })
  try {
    await preflight.connect()
    const { rows: [state] } = await preflight.query(
      'SELECT to_regclass(\'public."_prisma_migrations"\') IS NOT NULL AS migrated',
    )
    if (state.migrated) {
      const disallowed = profile.trim() === 'core'
        ? '20260729150000_faka_bridge_foundation'
        : '20260729150000_external_offer_binding'
      const existing = await preflight.query(
        'SELECT 1 FROM "_prisma_migrations" WHERE migration_name=$1 AND rolled_back_at IS NULL',
        [disallowed],
      )
      if (existing.rowCount) {
        console.error('Database migration profile does not match this release artifact.')
        process.exitCode = 1
      }
    }
  } catch {
    console.error('Database migration profile preflight failed.')
    process.exitCode = 1
  } finally {
    await preflight.end()
  }
  if (process.exitCode) process.exit(process.exitCode)
  const require = createRequire(import.meta.url)
  const result = spawnSync(
    process.execPath,
    [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
    {
      stdio: 'inherit',
      env,
    },
  )
  if (result.error) {
    console.error('Failed to start Prisma migration process')
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
  const client = new pg.Client({ connectionString: env.DIRECT_URL ?? env.DATABASE_URL })
  try {
    await client.connect()
    await client.query("SET lock_timeout='5s'")
    await client.query("SET statement_timeout='15min'")
    const exists = await client.query('SELECT to_regclass(\'public."AdminAuthorization"\') present')
    if (exists.rows[0].present) {
      const sql = await readFile(
        new URL('../prisma/post-deploy/governance-v1-indexes.sql', import.meta.url),
        'utf8',
      )
      for (const statement of sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)) {
        const name = statement.match(/IF NOT EXISTS "([^"]+)"/)?.[1]
        const invalid = name
          ? await client.query(
              'SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname=$1',
              [name],
            )
          : null
        if (invalid?.rows[0]?.indisvalid === false)
          await client.query(`DROP INDEX CONCURRENTLY "${name}"`)
        await client.query(statement)
      }
      console.log('Governance indexes ready (concurrent post-deploy stage).')
    }
  } catch {
    console.error(
      'Governance concurrent index stage failed; do not enable the new backend. Re-run db:migrate:deploy.',
    )
    process.exitCode = 1
  } finally {
    await client.end()
  }
}
