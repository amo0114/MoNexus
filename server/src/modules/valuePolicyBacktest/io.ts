import { mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { BacktestError, BACKTEST_ERROR_CODES } from './errors.js'

export const REPORT_JSON_NAME = 'd02-backtest-report.json'
export const REPORT_MARKDOWN_NAME = 'd02-backtest-report.md'

export function reportPaths(outputDir: string) {
  const directory = resolve(outputDir)
  return {
    directory,
    json: join(directory, REPORT_JSON_NAME),
    markdown: join(directory, REPORT_MARKDOWN_NAME),
  }
}

function existsAsFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function existsAnything(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

export function assertOutputWritable(outputDir: string, overwrite: boolean): ReturnType<typeof reportPaths> {
  const paths = reportPaths(outputDir)
  for (const path of [paths.json, paths.markdown]) {
    if (!existsAnything(path)) {
      continue
    }
    if (!existsAsFile(path)) {
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

function atomicWriteFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tempPath = `${path}.tmp-${process.pid}-${Date.now().toString(10)}`
  try {
    writeFileSync(tempPath, content, { encoding: 'utf8' })
    renameSync(tempPath, path)
  } catch (error) {
    try {
      unlinkSync(tempPath)
    } catch {
      // The temp file is best-effort cleanup only.
    }
    throw error
  }
}

export function writeReports(outputDir: string, json: string, markdown: string, overwrite: boolean): {
  json: string
  markdown: string
} {
  const paths = assertOutputWritable(outputDir, overwrite)
  atomicWriteFile(paths.json, json)
  atomicWriteFile(paths.markdown, markdown)
  return { json: paths.json, markdown: paths.markdown }
}
