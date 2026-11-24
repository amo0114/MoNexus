import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const [output] = process.argv.slice(2)
if (!output) throw new Error('Usage: node scripts/package-fulfillment-web.mjs <release-directory>')
const source = resolve('dist')
const target = resolve(output)
const manifest = JSON.parse(await readFile(join(source, '.vite/manifest.json'), 'utf8'))
const optional = new Set([
  'src/components/admin/AdminFakaSettingsPanel.tsx',
  'src/components/admin/AdminFakaTasksPanel.tsx',
  'src/components/admin/productPanel/ProductCapacityDialog.tsx',
  'src/components/catalog/AdminFakaImportPreview.tsx',
  'src/components/catalog/AdminFakaSyncDialog.tsx',
  'src/components/catalog/AdminSourceDescriptionDialog.tsx',
  'src/extensions/xboard/XboardPurchaseBoundary.tsx',
])
for (const key of optional) if (!manifest[key]?.isDynamicEntry) throw new Error(`Plugin entry is not independently loadable: ${key}`)

function assets(entries, includePlugin) {
  const seen = new Set(entries)
  const files = new Set()
  for (const key of seen) {
    const chunk = manifest[key]
    if (!chunk) throw new Error(`Missing Vite manifest entry: ${key}`)
    for (const file of [chunk.file, ...chunk.css ?? [], ...chunk.assets ?? []]) files.add(file)
    for (const dependency of chunk.imports ?? []) seen.add(dependency)
    for (const dependency of chunk.dynamicImports ?? []) {
      if (includePlugin || !optional.has(dependency)) seen.add(dependency)
    }
  }
  return files
}

const coreFiles = assets(Object.keys(manifest).filter(key => manifest[key].isEntry), false)
for (const key of optional) if (coreFiles.has(manifest[key].file)) throw new Error(`Core imports plugin entry: ${key}`)
const pluginFiles = new Set([...assets(optional, true)].filter(file => !coreFiles.has(file)))
const core = join(target, 'core/web')
const plugin = join(target, 'faka-bridge/web')
await mkdir(core, { recursive: true })
await mkdir(plugin, { recursive: true })
for (const f of await readdir(source, { recursive: true, withFileTypes: true })) {
  if (!f.isFile()) continue
  const prefix = f.parentPath.slice(source.length).replace(/^\//, '')
  const path = join(prefix, f.name)
  if (path === '.vite/manifest.json') continue
  const destination = join(pluginFiles.has(path) ? plugin : core, path)
  await mkdir(dirname(destination), { recursive: true })
  await cp(join(source, path), destination, { errorOnExist: true, force: false })
}
await writeFile(join(plugin, 'manifest.json'), JSON.stringify([...pluginFiles].sort(), null, 2) + '\n')
console.log(`Separated ${pluginFiles.size} optional web assets.`)
