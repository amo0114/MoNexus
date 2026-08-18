import { writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSyntheticSmallInput } from './__fixtures__/syntheticSmall.js'
import { parseCliArgs } from './cli.js'
import { BACKTEST_ERROR_CODES, BacktestError } from './errors.js'
import { testRuntime } from './__fixtures__/runtime.js'
import { runValuePolicyBacktestCli } from '../../scripts/valuePolicyBacktest.js'
import { DEFAULT_ANALYSIS_CANDIDATES } from './thresholds.js'

describe('CLI parsing', () => {
  it('requires input and output', () => {
    expect(() => parseCliArgs([])).toThrow(BacktestError)
    try {
      parseCliArgs(['--output', '/tmp/out'])
    } catch (error) {
      expect((error as BacktestError).code).toBe(BACKTEST_ERROR_CODES.INVALID_CLI)
    }
  })

  it('parses the documented flag set', () => {
    const parsed = parseCliArgs([
      '--input',
      '/tmp/in.json',
      '--output',
      '/tmp/out',
      '--candidates',
      '50,100,200,500',
      '--reference-asset',
      'CNY',
      '--overwrite',
    ])
    expect(parsed.candidates).toEqual([50, 100, 200, 500])
    expect(parsed.referenceAsset).toBe('CNY')
    expect(parsed.overwrite).toBe(true)
    expect(parsed.allowUnverifiableSource).toBe(false)
  })

  it('uses the documented analysis set when candidates are omitted', () => {
    const parsed = parseCliArgs(['--input', '/tmp/in.json', '--output', '/tmp/out'])
    expect(parsed.candidates).toBeNull()
    expect([...DEFAULT_ANALYSIS_CANDIDATES]).toEqual([50, 100, 200, 500])
  })
})

describe('CLI runner', () => {
  it('writes both reports and never logs identity refs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'd02-cli-'))
    const inputPath = join(directory, 'input.json')
    const outputDir = join(directory, 'out')
    const input = buildSyntheticSmallInput()
    writeFileSync(inputPath, `${JSON.stringify(input)}\n`)
    const result = runValuePolicyBacktestCli([
      '--input',
      inputPath,
      '--output',
      outputDir,
      '--candidates',
      '50,100,200,500',
      '--reference-asset',
      'CNY',
    ], testRuntime())
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('D-02 STATUS: NOT APPROVED')
    expect(result.stdout).not.toContain(input.accounts[0].accountRef)
    expect(result.stdout).not.toContain(input.orders[0].orderRef)
    expect(result.stderr).toBe('')
  })

  it('rejects a non-CNY reference asset', () => {
    const directory = mkdtempSync(join(tmpdir(), 'd02-cli-usd-'))
    const inputPath = join(directory, 'input.json')
    writeFileSync(inputPath, `${JSON.stringify(buildSyntheticSmallInput())}\n`)
    const result = runValuePolicyBacktestCli([
      '--input',
      inputPath,
      '--output',
      join(directory, 'out'),
      '--reference-asset',
      'USD',
    ], testRuntime())
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('UNSUPPORTED_REFERENCE_ASSET')
    expect(result.stderr).not.toContain(inputPath)
  })

  it('prints help without requiring files', () => {
    const result = runValuePolicyBacktestCli(['--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('D-02 STATUS: NOT APPROVED')
    expect(result.stdout).toContain('--input')
  })
})
