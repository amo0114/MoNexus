import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const server = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dist = join(server, 'dist')
const destination = resolve(process.argv[2] ?? join(server, 'release'))
const core = join(destination, 'core')
const plugin = join(destination, 'faka-bridge')
const optionalEntry = 'plugins/fakaBridge/entry.js'
const foundation = '20260729150000_faka_bridge_foundation'
const sharedFoundation = '20260729150000_external_offer_binding'
const optionalMigrations = new Set([
  '20260729180000_faka_provision_email_proof',
  '20260729190000_faka_bridge_lifecycle',
  '20260729193000_faka_cancel_requested',
  '20260729200000_faka_needs_reconcile_status',
  '20260730100000_faka_provision_email_send_budget',
  '20260901141000_external_catalog_sync_idempotency',
  '20261025120000_xboard_account_links',
  '20261025140000_traffic_reset_benefits',
  '20261025180000_paid_reset_tasks',
  '20261113140000_faka_runtime_binding',
])

async function localDependencies(path) {
  if (!path.endsWith('.js')) return []
  const source = ts.createSourceFile(path, await readFile(join(dist, path), 'utf8'), ts.ScriptTarget.ESNext)
  const dependencies = []
  function visit(node) {
    let specifier
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      specifier = node.arguments[0]
      // This is the single deployment-selected entry, resolved when mounted.
      if (specifier && ts.isStringLiteral(specifier) && path === 'bootstrap/optionalFulfillment.js'
        && specifier.text === '../plugins/fakaBridge/entry.js') return
    }
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
      dependencies.push(relative(dist, resolve(dist, dirname(path), specifier.text)).split(sep).join('/'))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return dependencies
}

async function closure(entries) {
  const seen = new Set(entries)
  for (const path of seen) for (const dep of await localDependencies(path)) seen.add(dep)
  return seen
}

async function copyFile(from, to) {
  await mkdir(dirname(to), { recursive: true })
  await cp(from, to, { errorOnExist: true, force: false })
}

await mkdir(destination, { recursive: true })
for (const location of [core, plugin]) await mkdir(location, { recursive: false }).catch(error => {
  throw new Error(`Choose an empty release output directory (${error.code})`)
})

const coreFiles = await closure(['main.js', 'prisma/seed.js', 'scripts/governanceMigrate.js'])
const pluginFiles = await closure([optionalEntry, 'scripts/backfillFakaPayments.js', 'scripts/backfillXboardAccounts.js', 'scripts/reconcileTrafficReset.js'])
for (const path of coreFiles) {
  if (/^(?:plugins\/fakaBridge\/|modules\/(?:fakaBridge|xboardAccounts|trafficReset)\/|lib\/fakaBridge\/)/.test(path)
    || path === 'lib/runtimeSettings/fakaBridge.js') throw new Error(`Core still imports a plugin implementation: ${path}`)
  await copyFile(join(dist, path), join(core, 'dist', path))
}
for (const path of pluginFiles) {
  if (!coreFiles.has(path)) await copyFile(join(dist, path), join(plugin, 'dist', path))
}

const migrations = join(server, 'prisma/migrations')
await mkdir(join(core, 'prisma/migrations'), { recursive: true })
await cp(join(server, 'prisma/post-deploy'), join(core, 'prisma/post-deploy'), { recursive: true })
await copyFile(join(server, 'prisma/schema.prisma'), join(core, 'prisma/schema.prisma'))
await copyFile(join(migrations, 'migration_lock.toml'), join(core, 'prisma/migrations/migration_lock.toml'))
const fullFoundation = await readFile(join(migrations, foundation, 'migration.sql'), 'utf8')
const split = fullFoundation.indexOf('CREATE TABLE "FakaBridgeTask"')
if (split < 0) throw new Error('Missing FakaBridge storage boundary in historical migration')
const sharedSql = fullFoundation.slice(fullFoundation.indexOf('ALTER TABLE "Offer"'), split)
  .replace('-- CreateTable\n', '')
const sharedPath = join(core, 'prisma/migrations', sharedFoundation)
await mkdir(sharedPath)
await writeFile(join(sharedPath, 'migration.sql'), sharedSql)

const pluginSql = [fullFoundation.slice(split)]
for (const name of (await readdir(migrations, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) {
  if (name === foundation) continue
  const source = join(migrations, name, 'migration.sql')
  if (optionalMigrations.has(name)) pluginSql.push(await readFile(source, 'utf8'))
  else await copyFile(source, join(core, 'prisma/migrations', name, 'migration.sql'))
}
pluginSql.push(`
CREATE TRIGGER bind_legacy_fulfillment_provider AFTER INSERT ON "FakaBridgeTask"
FOR EACH ROW EXECUTE FUNCTION monexus_bind_legacy_fulfillment_provider();
`)
await mkdir(join(plugin, 'prisma/faka-migrations'), { recursive: true })
await writeFile(join(plugin, 'prisma/faka-migrations/0001_initial.sql'), pluginSql.join('\n'))
await writeFile(join(core, 'prisma/migration-profile'), 'core\n')
for (const path of ['package-lock.json', 'scripts/migrate-deploy.mjs']) {
  await copyFile(join(server, path), join(core, path))
}
const manifest = JSON.parse(await readFile(join(server, 'package.json'), 'utf8'))
manifest.scripts['check:runtime'] = 'node scripts/check-runtime.mjs'
manifest.scripts['db:seed'] = 'node dist/prisma/seed.js'
manifest.scripts['db:seed:force'] = 'node dist/prisma/seed.js --force-reset'
await writeFile(join(core, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
await copyFile(join(server, '../scripts/check-runtime.mjs'), join(core, 'scripts/check-runtime.mjs'))
await copyFile(join(server, 'scripts/install-faka-schema.mjs'), join(plugin, 'scripts/install-faka-schema.mjs'))

console.log('Packed independent core and optional FakaBridge artifacts.')
