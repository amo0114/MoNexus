import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/** Check the container boundary without rendering configuration or secrets. */
export function missingComposeEnvironment(configSource, providerSources, composeSource) {
  const required = new Set()
  const ast = ts.createSourceFile('config.ts', configSource, ts.ScriptTarget.Latest, true)
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'envSchema'
      && node.initializer && ts.isCallExpression(node.initializer)) {
      const object = node.initializer.arguments[0]
      if (object && ts.isObjectLiteralExpression(object)) {
        for (const field of object.properties) if (field.name) required.add(field.name.getText(ast))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  if (!required.size) throw new Error('Could not locate the environment schema')
  for (const source of providerSources) {
    for (const match of source.matchAll(/\b(?:env|process\.env)\.([A-Z][A-Z0-9_]*)\b|\breadOptional\(['"]([A-Z][A-Z0-9_]*)['"]\)/g)) {
      required.add(match[1] ?? match[2])
    }
  }
  // Test-only simulator authentication must never enter production containers.
  required.delete('PAYMENT_SIMULATOR_TEST_TOKEN')
  const server = serviceEnvironment(composeSource, 'server')
  if (!server) throw new Error('Could not locate the production server service')
  const missing = [...required].filter(key => !server.has(key)).sort()
  // The background role runs the same code, so it needs the same environment.
  const worker = serviceEnvironment(composeSource, 'server-worker')
  if (worker) missing.push(...[...required].filter(key => !worker.has(key)).sort().map(key => `server-worker:${key}`))
  return missing
}

/** Keys a service maps directly or through a `<<: *anchor` merge of another service's `environment: &anchor`. */
function serviceEnvironment(composeSource, name) {
  const block = composeSource.split(new RegExp(`^  ${name}:\\s*$`, 'm'))[1]?.split(/^  [a-z][a-z0-9_-]*:\s*$/m)[0]
  if (!block) return null
  const keys = new Set([...block.matchAll(/^      ([A-Z][A-Z0-9_]*):/gm)].map(match => match[1]))
  for (const [, anchor] of block.matchAll(/^      <<: \*([\w-]+)\s*$/gm)) {
    const shared = composeSource.split(new RegExp(`^    environment: &${anchor}\\s*$`, 'm'))[1]?.split(/^ {0,4}\S/m)[0] ?? ''
    for (const [, key] of shared.matchAll(/^      ([A-Z][A-Z0-9_]*):/gm)) keys.add(key)
  }
  return keys
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  function* sources(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) yield* sources(path)
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) yield readFileSync(path, 'utf8')
    }
  }
  const missing = missingComposeEnvironment(
    readFileSync(resolve(root, 'server/src/config/index.ts'), 'utf8'),
    [...sources(resolve(root, 'server/src/modules/payment/providers'))],
    readFileSync(resolve(root, 'docker-compose.prod.yml'), 'utf8'),
  )
  if (missing.length) {
    console.error(`Production server does not receive these environment variables: ${missing.join(', ')}`)
    process.exitCode = 1
  } else console.log('Production Compose environment coverage passed (names only; no secrets rendered).')
}
