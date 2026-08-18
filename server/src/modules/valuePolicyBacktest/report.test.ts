import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSyntheticSmallInput, syntheticRef } from './__fixtures__/syntheticSmall.js'
import { DEFAULT_GATE_THRESHOLDS } from './thresholds.js'
import { BACKTEST_ERROR_CODES, BacktestError } from './errors.js'
import { hashBufferSha256, parseBacktestInput } from './parse.js'
import { buildReport, businessContent, renderMarkdown, reportJson } from './report.js'
import { executeBacktest } from './run.js'
import type { RunOptions, ValidatedInput } from './types.js'

function parseFixture(): ValidatedInput {
  const raw = `${JSON.stringify(buildSyntheticSmallInput())}\n`
  return parseBacktestInput(raw, hashBufferSha256(Buffer.from(raw)), Buffer.byteLength(raw))
}

function options(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    inputPath: 'memory.json',
    outputDir: '/tmp/unused',
    candidates: [50, 100, 200, 500],
    candidatesSource: 'explicit_cli',
    referenceAsset: 'CNY',
    overwrite: false,
    thresholds: { ...DEFAULT_GATE_THRESHOLDS },
    gatesConfigSource: 'documented_defaults',
    legacyCommissionBps: null,
    runtime: {
      now: () => new Date('2026-08-18T00:00:00.000Z'),
      gitCommit: () => 'test-commit',
    },
    ...overrides,
  }
}

function walkStrings(value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string') {
    visit(value)
    return
  }
  if (Array.isArray(value)) {
    value.forEach(item => walkStrings(item, visit))
    return
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach(child => walkStrings(child, visit))
  }
}

describe('backtest report', () => {
  it('is deterministic for the same input, parameters, and code version', () => {
    const input = parseFixture()
    const first = buildReport(input, options())
    const second = buildReport(input, options({
      runtime: {
        now: () => new Date('2026-12-01T12:00:00.000Z'),
        gitCommit: () => 'test-commit',
      },
    }))
    expect(businessContent(first)).toEqual(businessContent(second))
    expect(first.metadata.inputSha256).toBe(input.rawSha256)
    expect(first.metadata.executedAt).not.toBe(second.metadata.executedAt)
  })

  it('always records D-02 as not approved and never picks a winner', () => {
    const report = buildReport(parseFixture(), options())
    expect(report.d02Status).toBe('NOT APPROVED')
    expect(report.conclusions).toContain('D-02 remains NOT APPROVED')
    expect(report.conclusions).toContain('this report is decision support only')
    expect(JSON.stringify(report)).not.toMatch(/best candidate|approved candidate|recommended face value/i)
    const markdown = renderMarkdown(report)
    expect(markdown).toContain('D-02 STATUS: NOT APPROVED')
  })

  it('does not leak account, order, or offer identifiers', () => {
    const input = parseFixture()
    const report = buildReport(input, options())
    const json = reportJson(report)
    const markdown = renderMarkdown(report)
    const refs = [
      ...input.offers.map(row => row.offerRef),
      ...input.accounts.map(row => row.accountRef),
      ...input.orders.map(row => row.orderRef),
    ]
    for (const ref of refs) {
      expect(json).not.toContain(ref)
      expect(markdown).not.toContain(ref)
    }
    expect(json).not.toMatch(/"accountRef"|"orderRef"|"offerRef"/)
  })

  it('suppresses small category groups and does not invent merchant margins', () => {
    const report = buildReport(parseFixture(), options())
    const offerAnalysis = report.candidates[1].offerPrices
    const rare = offerAnalysis.byCategory.find(row => row.category === 'rare')
    const digital = offerAnalysis.byCategory.find(row => row.category === 'digital')
    expect(rare?.suppressed).toBe(true)
    expect(rare?.distribution).toBeNull()
    expect(digital?.suppressed).toBe(true)
    expect(report.candidates[1].merchantUnitEconomics.emitted).toBe(false)
    expect(report.candidates[1].merchantUnitEconomics.referenceMinusCostAtomic).toBeNull()
    expect(report.candidates[1].merchantUnitEconomics.reason).toMatch(/cost/)
  })

  it('never emits Infinity or NaN', () => {
    const report = buildReport(parseFixture(), options())
    walkStrings(report, (text) => {
      expect(text).not.toBe('Infinity')
      expect(text).not.toBe('-Infinity')
      expect(text).not.toBe('NaN')
    })
    expect(JSON.stringify(report)).not.toMatch(/Infinity|NaN/)
  })

  it('keeps JSON and Markdown key figures aligned', () => {
    const report = buildReport(parseFixture(), options())
    const markdown = renderMarkdown(report)
    const hundred = report.candidates.find(row => row.candidate.pointsPerCnyMajor === 100)
    expect(hundred).toBeTruthy()
    expect(markdown).toContain(report.metadata.inputSha256)
    expect(markdown).toContain(`offer P50 CNY: ${hundred?.offerPrices.distribution?.referenceCny.p50}`)
    expect(markdown).toContain(`reference-value exposure CNY: ${hundred?.balances.referenceValueExposureCny}`)
    expect(markdown).toContain(`rounding incidence: ${hundred?.offerPrices.rounding?.incidence}`)
    expect(markdown).toContain(hundred?.rewardBudget.disclaimer ?? 'missing')
  })

  it('includes every required gate and only allowed statuses', () => {
    const report = buildReport(parseFixture(), options())
    const allowed = new Set(['pass', 'warn', 'fail', 'insufficient_data'])
    for (const candidate of report.candidates) {
      const names = candidate.gates.map(gate => gate.name)
      expect(names).toEqual([
        'DATA_COVERAGE',
        'PRICE_READABILITY',
        'REWARD_BUDGET',
        'USER_AFFORDABILITY',
        'MERCHANT_UNIT_ECONOMICS',
        'ROUNDING_STABILITY',
        'CONCENTRATION_RISK',
      ])
      for (const gate of candidate.gates) {
        expect(allowed.has(gate.status)).toBe(true)
      }
    }
    expect(report.metadata.gatesThresholds).toEqual(DEFAULT_GATE_THRESHOLDS)
  })

  it('records the 200 and 500 PTS candidates as fractional atomic ratios', () => {
    const report = buildReport(parseFixture(), options())
    expect(report.candidates[2].candidate).toMatchObject({
      pointsPerCnyMajor: 200,
      numerator: '1',
      denominator: '2',
      roundingMode: 'HALF_EVEN',
    })
    expect(report.candidates[3].candidate).toMatchObject({
      pointsPerCnyMajor: 500,
      numerator: '1',
      denominator: '5',
      roundingMode: 'HALF_EVEN',
    })
    expect(report.sensitivity.map(row => row.multiplierVs100PtsPerCny)).toEqual([
      '2.0000',
      '1.0000',
      '0.5000',
      '0.2000',
    ])
  })

  it('refuses to overwrite existing report files unless --overwrite is set', () => {
    const directory = mkdtempSync(join(tmpdir(), 'd02-out-'))
    const inputPath = join(directory, 'input.json')
    writeFileSync(inputPath, `${JSON.stringify(buildSyntheticSmallInput())}\n`)
    const first = executeBacktest(options({ inputPath, outputDir: directory }))
    expect(readFileSync(first.jsonPath, 'utf8')).toContain('NOT APPROVED')
    try {
      executeBacktest(options({ inputPath, outputDir: directory, overwrite: false }))
      throw new Error('expected overwrite rejection')
    } catch (error) {
      expect((error as BacktestError).code).toBe(BACKTEST_ERROR_CODES.OUTPUT_EXISTS)
    }
    const nested = join(directory, 'keep-me')
    mkdirSync(nested)
    writeFileSync(join(nested, 'other.txt'), 'preserve')
    const second = executeBacktest(options({
      inputPath,
      outputDir: directory,
      overwrite: true,
      runtime: {
        now: () => new Date('2026-08-18T01:00:00.000Z'),
        gitCommit: () => 'test-commit-2',
      },
    }))
    expect(readFileSync(second.jsonPath, 'utf8')).toContain('test-commit-2')
    expect(readFileSync(join(nested, 'other.txt'), 'utf8')).toBe('preserve')
  })

  it('does not mention cash liability or redemption promises as facts', () => {
    const report = buildReport(parseFixture(), options())
    const json = reportJson(report)
    expect(json).toContain('reference-value exposure')
    expect(json).toContain('reference-value estimate, not accounting liability')
    expect(json).not.toMatch(/cash liability|cash redemption commitment|accounting revenue|breakage income/i)
    expect(report.conclusions).toContain('CNY reference value is not a cash redemption promise')
  })
})

describe('fixture identifiers', () => {
  it('uses synthetic sha256 refs rather than database ids', () => {
    expect(syntheticRef('account-high-balance')).toMatch(/^[a-f0-9]{64}$/)
    expect(syntheticRef('account-high-balance')).not.toBe('1')
  })
})
