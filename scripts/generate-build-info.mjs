#!/usr/bin/env node
/**
 * Build-time generator for server/build-info.json.
 * Runtime APIs must read that file; they must not call this script or git.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENVIRONMENTS = new Set(['production', 'staging', 'development', 'test'])
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`[generate:build-info] ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dev') {
      out.dev = true
      continue
    }
    if (!arg.startsWith('--')) fail(`unexpected argument: ${arg}`)
    const key = arg.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) fail(`missing value for --${key}`)
    out[key] = value
    i += 1
  }
  return out
}

function shortSha(commit) {
  return commit.slice(0, 7)
}

function resolveCommit(explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA.trim()) return process.env.GITHUB_SHA.trim()
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    fail('commit is required: pass --commit, set GITHUB_SHA, or run inside a git checkout')
  }
  return ''
}

function resolveReleaseTag(raw) {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') fail('release-tag must be a string')
  const tag = raw.trim()
  if (tag.length === 0 || tag === 'null') return null
  return tag
}

const args = parseArgs(process.argv.slice(2))
const rootPkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const serverPkg = JSON.parse(await readFile(resolve(root, 'server/package.json'), 'utf8'))
const baseVersion = rootPkg.version

if (typeof baseVersion !== 'string' || baseVersion.length === 0) {
  fail('root package.json.version is missing')
}
if (baseVersion !== serverPkg.version) {
  fail(`version mismatch: root=${baseVersion} server=${serverPkg.version}`)
}

const commit = resolveCommit(args.commit)
if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
  fail(`commit must be a git SHA, got ${commit}`)
}

const releaseTag = resolveReleaseTag(typeof args['release-tag'] === 'string' ? args['release-tag'] : undefined)
if (releaseTag !== null) {
  if (!/^v\d+\.\d+\.\d+$/.test(releaseTag)) {
    fail(`release-tag must be vMAJOR.MINOR.PATCH, got ${releaseTag}`)
  }
  if (releaseTag !== `v${baseVersion}`) {
    fail(`release tag ${releaseTag} does not match package.json version ${baseVersion}`)
  }
}

const useDev = args.dev === true
let version = baseVersion
if (useDev) {
  const runNumber = typeof args['run-number'] === 'string' ? args['run-number'].trim() : ''
  if (runNumber.length > 0) {
    if (!/^[1-9][0-9]*$/.test(runNumber)) fail(`run-number must be a positive integer, got ${runNumber}`)
    version = `${baseVersion}-dev.${runNumber}+sha.${shortSha(commit)}`
  } else {
    version = `${baseVersion}-dev+sha.${shortSha(commit)}`
  }
}

const environmentRaw = typeof args.environment === 'string' ? args.environment : useDev ? 'development' : 'production'
if (!ENVIRONMENTS.has(environmentRaw)) {
  fail(`environment must be one of ${[...ENVIRONMENTS].join('|')}, got ${environmentRaw}`)
}

let builtAt = typeof args['built-at'] === 'string' ? args['built-at'] : new Date().toISOString()
const builtAtMs = Date.parse(builtAt)
if (Number.isNaN(builtAtMs)) fail(`built-at must be an ISO UTC timestamp, got ${builtAt}`)
builtAt = new Date(builtAtMs).toISOString()

const artifact = {
  version,
  commit,
  builtAt,
  environment: environmentRaw,
  releaseTag,
  source: 'build_artifact',
}

const serialized = `${JSON.stringify(artifact, null, 2)}\n`
const output = typeof args.output === 'string' ? args.output : ''
if (output) {
  const outputPath = resolve(root, output)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, serialized, 'utf8')
  console.error(`[generate:build-info] wrote ${outputPath}`)
} else {
  process.stdout.write(serialized)
}
