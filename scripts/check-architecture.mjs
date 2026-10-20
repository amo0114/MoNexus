import { checkBoundaries } from './architecture-rules.mjs'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('__')) continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(path)
    else if (/\.tsx?$/.test(path) && !/\.(test|spec)\.tsx?$/.test(path)) yield path
  }
}

const sources = new Map([...sourceFiles(resolve(root, 'server/src'))].map(file => [
  relative(root, file).split(sep).join('/'), readFileSync(file, 'utf8'),
]))
failures.push(...checkBoundaries(sources))

const spec = JSON.parse(readFileSync(resolve(root, 'docs/superpowers/specs/monexus-api-openapi.json'), 'utf8'))
function checkReferences(value) {
  if (!value || typeof value !== 'object') return
  if (typeof value.$ref === 'string' && value.$ref.startsWith('#/')) {
    const target = value.$ref.slice(2).split('/').reduce((node, key) => node?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], spec)
    if (!target) failures.push(`Unresolved OpenAPI reference: ${value.$ref}`)
  }
  for (const child of Object.values(value)) checkReferences(child)
}
checkReferences(spec)
if (!spec.paths['/api/product-templates']?.get?.responses?.['200']) {
  failures.push('OpenAPI must document GET /api/product-templates')
}

if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else {
  console.log('Architecture boundaries and OpenAPI references passed.')
}
