import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'

// Prisma's PostgreSQL driver does not consume libpq PGOPTIONS. Set startup
// options in the migration-only connection URL; never print that URL.
export function migrationUrl(raw) {
  let url
  try { url = new URL(raw) }
  catch { throw new Error('Invalid migration database URL') }
  const options = url.searchParams.get('options') ?? ''
  url.searchParams.set('options', `${options} -c lock_timeout=5000`.trim())
  return url.toString()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = { ...process.env }
  for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
    if (env[key]) env[key] = migrationUrl(env[key])
  }
  const require = createRequire(import.meta.url)
  const result = spawnSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
    stdio: 'inherit', env,
  })
  if (result.error) { console.error('Failed to start Prisma migration process'); process.exit(1) }
  process.exit(result.status ?? 1)
}
