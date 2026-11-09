import { readdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Applied migrations are immutable. Gate new files from this review onward.
export function migrationSafetyErrors(sql) {
  const clean = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
  const errors = []
  if (/\bCONCURRENTLY\b/i.test(clean) && clean.split(';').filter(s => s.trim()).length !== 1) {
    errors.push('CONCURRENTLY must be the only statement in its migration file')
  }
  for (const match of clean.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY\b)[\s\S]*?\bON\s+"([^"]+)"/gi)) {
    const table = match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!new RegExp(`CREATE\\s+TABLE\\s+"${table}"`, 'i').test(clean)) {
      errors.push('indexes on existing tables require a separate CREATE INDEX CONCURRENTLY migration')
    }
  }
  return errors
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../server/prisma/migrations/', import.meta.url)))
  const errors = []
  for (const name of readdirSync(root).filter(name => /^\d{14}_/.test(name) && name >= '20261109000000')) {
    for (const error of migrationSafetyErrors(readFileSync(join(root, name, 'migration.sql'), 'utf8'))) errors.push(`${name}: ${error}`)
  }
  if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
  console.log('New migration index safety passed; applied history preserved.')
}
