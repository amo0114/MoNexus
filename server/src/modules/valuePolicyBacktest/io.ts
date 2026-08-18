import { randomBytes } from 'node:crypto'
import {
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { BacktestError, BACKTEST_ERROR_CODES } from './errors.js'

export const REPORT_JSON_NAME = 'd02-backtest-report.json'
export const REPORT_MARKDOWN_NAME = 'd02-backtest-report.md'

export type PublishIo = {
  mkdirSync: typeof mkdirSync
  writeFileSync: typeof writeFileSync
  renameSync: typeof renameSync
  unlinkSync: typeof unlinkSync
  statSync: typeof statSync
  readdirSync: typeof readdirSync
}

const defaultIo: PublishIo = {
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  statSync,
  readdirSync,
}

export function reportPaths(outputDir: string) {
  const directory = resolve(outputDir)
  return {
    directory,
    json: join(directory, REPORT_JSON_NAME),
    markdown: join(directory, REPORT_MARKDOWN_NAME),
  }
}

function existsAsFile(path: string, io: PublishIo): boolean {
  try {
    return io.statSync(path).isFile()
  } catch {
    return false
  }
}

function existsAnything(path: string, io: PublishIo): boolean {
  try {
    io.statSync(path)
    return true
  } catch {
    return false
  }
}

export function assertOutputWritable(outputDir: string, overwrite: boolean, io: PublishIo = defaultIo): ReturnType<typeof reportPaths> {
  const paths = reportPaths(outputDir)
  for (const path of [paths.json, paths.markdown]) {
    if (!existsAnything(path, io)) {
      continue
    }
    if (!existsAsFile(path, io)) {
      throw new BacktestError(
        BACKTEST_ERROR_CODES.OUTPUT_EXISTS,
        'refusing to replace a non-file output path',
        { pathKind: 'not_a_file' },
      )
    }
    if (!overwrite) {
      throw new BacktestError(
        BACKTEST_ERROR_CODES.OUTPUT_EXISTS,
        'output report already exists; pass --overwrite to replace the report files only',
      )
    }
  }
  return paths
}

function unlinkIfExists(path: string, io: PublishIo): void {
  try {
    io.unlinkSync(path)
  } catch {
    // Best-effort cleanup.
  }
}

export function leftoverPublishFiles(directory: string, io: PublishIo = defaultIo): string[] {
  try {
    return io.readdirSync(directory).filter(name => name.startsWith('.d02-') && (name.endsWith('.tmp') || name.endsWith('.bak')))
  } catch {
    return []
  }
}

export function writeReports(
  outputDir: string,
  json: string,
  markdown: string,
  overwrite: boolean,
  io: PublishIo = defaultIo,
): {
  json: string
  markdown: string
} {
  const paths = assertOutputWritable(outputDir, overwrite, io)
  io.mkdirSync(paths.directory, { recursive: true })
  const stamp = randomBytes(16).toString('hex')
  const jsonTmp = join(paths.directory, `.d02-${stamp}-report.json.tmp`)
  const markdownTmp = join(paths.directory, `.d02-${stamp}-report.md.tmp`)
  const jsonBak = join(paths.directory, `.d02-${stamp}-report.json.bak`)
  const markdownBak = join(paths.directory, `.d02-${stamp}-report.md.bak`)
  const jsonExisted = existsAsFile(paths.json, io)
  const markdownExisted = existsAsFile(paths.markdown, io)
  let jsonBacked = false
  let markdownBacked = false
  let jsonPublished = false
  let markdownPublished = false

  const rollback = () => {
    if (jsonPublished) {
      unlinkIfExists(paths.json, io)
    }
    if (markdownPublished) {
      unlinkIfExists(paths.markdown, io)
    }
    if (jsonBacked) {
      io.renameSync(jsonBak, paths.json)
    }
    if (markdownBacked) {
      io.renameSync(markdownBak, paths.markdown)
    }
    unlinkIfExists(jsonTmp, io)
    unlinkIfExists(markdownTmp, io)
    unlinkIfExists(jsonBak, io)
    unlinkIfExists(markdownBak, io)
  }

  try {
    io.writeFileSync(jsonTmp, json, { encoding: 'utf8', flag: 'wx' })
    io.writeFileSync(markdownTmp, markdown, { encoding: 'utf8', flag: 'wx' })
    if (jsonExisted) {
      io.renameSync(paths.json, jsonBak)
      jsonBacked = true
    }
    if (markdownExisted) {
      io.renameSync(paths.markdown, markdownBak)
      markdownBacked = true
    }
    io.renameSync(jsonTmp, paths.json)
    jsonPublished = true
    io.renameSync(markdownTmp, paths.markdown)
    markdownPublished = true
    unlinkIfExists(jsonBak, io)
    unlinkIfExists(markdownBak, io)
  } catch (error) {
    rollback()
    throw error
  }
  return { json: paths.json, markdown: paths.markdown }
}
