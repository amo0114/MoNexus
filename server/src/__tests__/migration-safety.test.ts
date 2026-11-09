import { it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { prisma } from '../lib/prisma.js'

it('R2-06: the actual Prisma migration process receives a 5s lock timeout, preserving concurrent-index support', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'monexus-migrate-'))
  const schema = `migration_probe_${randomUUID().replaceAll('-', '')}`
  const url = new URL(process.env.TEST_DATABASE_URL!)
  url.searchParams.set('schema', schema)
  const wrapper = resolve('scripts/migrate-deploy.mjs')
  try {
    mkdirSync(join(dir, 'prisma/migrations/202611090001_probe'), { recursive: true })
    mkdirSync(join(dir, 'prisma/migrations/202611090002_index'), { recursive: true })
    writeFileSync(join(dir, 'prisma/schema.prisma'), 'datasource db {\n provider = "postgresql"\n url = env("DATABASE_URL")\n}\n')
    writeFileSync(join(dir, 'prisma/migrations/migration_lock.toml'), 'provider = "postgresql"\n')
    writeFileSync(join(dir, 'prisma/migrations/202611090001_probe/migration.sql'), `
      DO $$ BEGIN IF current_setting('lock_timeout') != '5s' THEN RAISE EXCEPTION 'missing lock timeout'; END IF; END $$;
      CREATE TABLE "TimeoutProbe" (id int);
    `)
    writeFileSync(join(dir, 'prisma/migrations/202611090002_index/migration.sql'), 'CREATE INDEX CONCURRENTLY "TimeoutProbe_id_idx" ON "TimeoutProbe" (id);')
    await promisify(execFile)(process.execPath, [wrapper], { cwd: dir,
      env: { ...process.env, DATABASE_URL: url.toString(), DIRECT_URL: url.toString() }, timeout: 25_000 })
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`SELECT indexname FROM pg_indexes WHERE schemaname = ${schema}`
    expect(indexes.some(row => row.indexname === 'TimeoutProbe_id_idx')).toBe(true)
  } finally {
    // Schema name is generated locally from hex only; never accepts request input.
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    rmSync(dir, { recursive: true, force: true })
  }
})
