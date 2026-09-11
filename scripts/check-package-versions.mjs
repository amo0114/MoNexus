#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const rootPkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const serverPkg = JSON.parse(await readFile(resolve(root, 'server/package.json'), 'utf8'))

const rootVersion = rootPkg.version
const serverVersion = serverPkg.version

if (typeof rootVersion !== 'string' || rootVersion.length === 0) {
  console.error('[check:package-versions] root package.json.version is missing')
  process.exit(1)
}

if (rootVersion !== serverVersion) {
  console.error(
    `[check:package-versions] version mismatch: root package.json.version=${rootVersion} server/package.json.version=${serverVersion}`,
  )
  process.exit(1)
}

console.log(`[check:package-versions] ${rootVersion}`)
