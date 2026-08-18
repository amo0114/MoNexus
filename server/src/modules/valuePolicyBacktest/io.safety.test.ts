import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { testRuntime } from './__fixtures__/runtime.js'
import { BACKTEST_ERROR_CODES, BacktestError } from './errors.js'
import { leftoverPublishFiles, writeReports, type PublishIo } from './io.js'
import { readFromSyncReader } from './parse.js'
import { DEFAULT_GATE_THRESHOLDS, INPUT_LIMITS } from './thresholds.js'
import { assertVerifiableSource, executeBacktest } from './run.js'
import { buildSyntheticSmallInput } from './__fixtures__/syntheticSmall.js'
import type { GitIdentity, RunOptions } from './types.js'

const defaultIo: PublishIo = {
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  statSync,
  readdirSync,
}

function options(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    inputPath: 'memory.json',
    outputDir: '/tmp/unused',
    candidates: [100],
    candidatesSource: 'explicit_cli',
    referenceAsset: 'CNY',
    overwrite: false,
    thresholds: { ...DEFAULT_GATE_THRESHOLDS },
    gatesConfigSource: 'documented_defaults',
    legacyCommissionBps: null,
    allowUnverifiableSource: false,
    runtime: testRuntime(),
    ...overrides,
  }
}

describe('input size cap', () => {
  it('accepts a stream of exactly the documented limit and rejects growth past it', () => {
    const exact = Buffer.alloc(INPUT_LIMITS.maxFileBytes, 97)
    let offset = 0
    const exactRead = readFromSyncReader((buffer) => {
      if (offset >= exact.length) {
        return 0
      }
      const next = exact.subarray(offset, offset + buffer.length)
      next.copy(buffer)
      offset += next.length
      return next.length
    }, INPUT_LIMITS.maxFileBytes)
    expect(exactRead.byteLength).toBe(INPUT_LIMITS.maxFileBytes)

    offset = 0
    const oversized = Buffer.alloc(INPUT_LIMITS.maxFileBytes + 1, 97)
    try {
      readFromSyncReader((buffer) => {
        if (offset >= oversized.length) {
          return 0
        }
        const next = oversized.subarray(offset, offset + buffer.length)
        next.copy(buffer)
        offset += next.length
        return next.length
      }, INPUT_LIMITS.maxFileBytes)
      throw new Error('expected size rejection')
    } catch (error) {
      expect((error as BacktestError).code).toBe(BACKTEST_ERROR_CODES.FILE_TOO_LARGE)
    }
  })
})

describe('atomic dual-report publish', () => {
  it('rolls back the first report when the second publish fails and leaves no temps', () => {
    const directory = mkdtempSync(join(tmpdir(), 'd02-io-new-'))
    let markdownRenames = 0
    const io: PublishIo = {
      ...defaultIo,
      renameSync: (from, to) => {
        if (String(to).endsWith('d02-backtest-report.md')) {
          markdownRenames += 1
          throw new Error('forced markdown publish failure')
        }
        return renameSync(from, to)
      },
    }
    try {
      writeReports(directory, '{"ok":true}\n', '# md\n', false, io)
      throw new Error('expected publish failure')
    } catch (error) {
      expect(String(error)).toMatch(/forced markdown publish failure/)
    }
    expect(() => statSync(join(directory, 'd02-backtest-report.json'))).toThrow()
    expect(() => statSync(join(directory, 'd02-backtest-report.md'))).toThrow()
    expect(leftoverPublishFiles(directory)).toEqual([])
    expect(markdownRenames).toBe(1)
  })

  it('keeps the original pair when overwrite publish fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'd02-io-over-'))
    writeReports(directory, '{"v":1}\n', '# one\n', false)
    const io: PublishIo = {
      ...defaultIo,
      renameSync: (from, to) => {
        if (String(from).endsWith('.tmp') && String(to).endsWith('d02-backtest-report.md')) {
          throw new Error('forced overwrite failure')
        }
        return renameSync(from, to)
      },
    }
    try {
      writeReports(directory, '{"v":2}\n', '# two\n', true, io)
      throw new Error('expected overwrite failure')
    } catch (error) {
      expect(String(error)).toMatch(/forced overwrite failure/)
    }
    expect(readFileSync(join(directory, 'd02-backtest-report.json'), 'utf8')).toBe('{"v":1}\n')
    expect(readFileSync(join(directory, 'd02-backtest-report.md'), 'utf8')).toBe('# one\n')
    expect(leftoverPublishFiles(directory)).toEqual([])
  })
})

describe('git source identity', () => {
  it('fails closed on a dirty tree unless explicitly overridden', () => {
    const dirty = options({ runtime: testRuntime('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'dirty') })
    try {
      assertVerifiableSource(dirty)
      throw new Error('expected dirty rejection')
    } catch (error) {
      expect((error as BacktestError).code).toBe(BACKTEST_ERROR_CODES.UNVERIFIABLE_SOURCE)
    }
    expect(() => assertVerifiableSource({ ...dirty, allowUnverifiableSource: true })).not.toThrow()
  })

  it('fails closed when git is unavailable', () => {
    const missing = options({ runtime: testRuntime('UNAVAILABLE', 'unavailable') })
    try {
      assertVerifiableSource(missing)
      throw new Error('expected unavailable rejection')
    } catch (error) {
      expect((error as BacktestError).code).toBe(BACKTEST_ERROR_CODES.UNVERIFIABLE_SOURCE)
    }
  })

  it('freezes a single GitIdentity so a later dirty read cannot bypass fail-closed', () => {
    const states: GitIdentity['treeState'][] = ['clean', 'dirty']
    let calls = 0
    const directory = mkdtempSync(join(tmpdir(), 'd02-git-seq-'))
    const inputPath = join(directory, 'input.json')
    writeFileSync(inputPath, `${JSON.stringify(buildSyntheticSmallInput())}\n`)
    const result = executeBacktest(options({
      inputPath,
      outputDir: join(directory, 'out'),
      allowUnverifiableSource: false,
      runtime: {
        now: () => new Date('2026-08-18T00:00:00.000Z'),
        gitIdentity: () => {
          const treeState = states[Math.min(calls, states.length - 1)]
          calls += 1
          return { commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', treeState }
        },
      },
    }))
    expect(calls).toBe(1)
    expect(result.report.metadata.gitTreeState).toBe('clean')
    expect(result.report.metadata.sourceVerifiable).toBe(true)
  })
})
