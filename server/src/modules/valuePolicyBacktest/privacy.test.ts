import { writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { testRuntime } from './__fixtures__/runtime.js'
import { syntheticRef } from './__fixtures__/syntheticSmall.js'
import { loadGateThresholds } from './cli.js'
import { BACKTEST_ERROR_CODES, BacktestError } from './errors.js'
import { hashBufferSha256, parseBacktestInput } from './parse.js'
import { buildReport, reportJson } from './report.js'
import { DEFAULT_GATE_THRESHOLDS } from './thresholds.js'
import type { RunOptions } from './types.js'

function parseJson(value: unknown) {
  const raw = `${JSON.stringify(value)}\n`
  return parseBacktestInput(raw, hashBufferSha256(Buffer.from(raw)), Buffer.byteLength(raw))
}

function singletonInput() {
  return {
    schemaVersion: 1,
    period: {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-31T23:59:59.999Z',
    },
    offers: [{
      offerRef: syntheticRef('solo-offer'),
      category: 'subscription',
      pricePoints: '1200',
      merchantCostCnyAtomic: '980',
    }],
    accounts: [{
      accountRef: syntheticRef('solo-account'),
      balancePoints: '5000',
      frozenPoints: '0',
    }],
    monthlyActivity: [{
      month: '2026-01',
      accountRef: syntheticRef('solo-account'),
      earnedPoints: '8000',
      spentPoints: '0',
      expiredPoints: '0',
      refundedPoints: '0',
    }],
    orders: [],
  }
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

function enoughOffers(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    offerRef: syntheticRef(`bulk-offer-${index}`),
    category: 'subscription',
    pricePoints: String(300 + index * 10),
    merchantCostCnyAtomic: '80',
  }))
}

function enoughAccounts(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    accountRef: syntheticRef(`bulk-account-${index}`),
    balancePoints: String(1000 + index),
    frozenPoints: '0',
  }))
}

describe('privacy suppression', () => {
  it('does not leak exact balances, rewards, or margins from a singleton input', () => {
    const report = buildReport(parseJson(singletonInput()), options())
    const json = reportJson(report)
    const candidate = report.candidates[0]
    expect(candidate.balances.suppressed).toBe(true)
    expect(candidate.balances.referenceValueExposureAtomic).toBeNull()
    expect(candidate.balances.referenceValueExposureCny).toBeNull()
    expect(candidate.balances.availablePoints.p50).toBeNull()
    expect(candidate.balances.concentration.top1Percent.totalSum).toBeNull()
    expect(candidate.userActivity.suppressed).toBe(true)
    expect(candidate.userActivity.monthlyAveragePoints).toBeNull()
    expect(candidate.rewardBudget.suppressed).toBe(true)
    expect(candidate.rewardBudget.totals.earnedReferenceCny).toBeNull()
    expect(candidate.rewardBudget.totals.netAvailablePoints).toBeNull()
    expect(candidate.merchantUnitEconomics.emitted).toBe(false)
    expect(candidate.merchantUnitEconomics.referenceMinusCostAtomic).toBeNull()
    expect(report.sensitivity[0].totalBalanceReferenceValueExposureAtomic).toBeNull()
    expect(report.sensitivity[0].periodEarnedReferenceCny).toBeNull()
    expect(report.sensitivity[0].belowCostOfferRate).toBeNull()
    expect(json).not.toContain('80.00')
    expect(json).not.toContain('"5000"')
    expect(json).not.toContain('"220"')
    expect(json).not.toContain('8.00')
  })

  it('suppresses a single small month when the overall sample is large enough', () => {
    const accounts = enoughAccounts(12)
    const activity = accounts.flatMap((account, index) => {
      const rows = [{
        month: '2026-01',
        accountRef: account.accountRef,
        earnedPoints: '400',
        spentPoints: '100',
        expiredPoints: '0',
        refundedPoints: '0',
      }]
      if (index === 0) {
        rows.push({
          month: '2026-02',
          accountRef: account.accountRef,
          earnedPoints: '7777',
          spentPoints: '0',
          expiredPoints: '0',
          refundedPoints: '0',
        })
      }
      return rows
    })
    const input = {
      schemaVersion: 1,
      period: {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-02-28T23:59:59.999Z',
      },
      offers: enoughOffers(12),
      accounts,
      monthlyActivity: activity,
      orders: [],
    }
    const report = buildReport(parseJson(input), options())
    const january = report.candidates[0].userActivity.monthlyEarnSpendRatio.find(row => row.month === '2026-01')
    const february = report.candidates[0].userActivity.monthlyEarnSpendRatio.find(row => row.month === '2026-02')
    expect(report.candidates[0].userActivity.suppressed).toBe(false)
    expect(january?.suppressed).toBe(false)
    expect(january?.earnedPoints).toBe('4800')
    expect(february?.suppressed).toBe(true)
    expect(february?.earnedPoints).toBeNull()
    expect(report.candidates[0].rewardBudget.byMonth.find(row => row.month === '2026-02')?.earnedPoints).toBeNull()
    expect(JSON.stringify(report)).not.toContain('7777')
  })

  it('suppresses activity and reward totals when 10 rows belong to one active account', () => {
    const accounts = enoughAccounts(10)
    const offers = enoughOffers(10)
    const monthlyActivity = [
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05',
      '2026-06', '2026-07', '2026-08', '2026-09', '2026-10',
    ].map(month => ({
      month,
      accountRef: accounts[0].accountRef,
      earnedPoints: '7777',
      spentPoints: '0',
      expiredPoints: '0',
      refundedPoints: '0',
    }))
    const input = {
      schemaVersion: 1,
      period: {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-10-31T23:59:59.999Z',
      },
      offers,
      accounts,
      monthlyActivity,
      orders: [],
    }
    const report = buildReport(parseJson(input), options())
    const candidate = report.candidates[0]
    expect(candidate.userActivity.sampleSizeUsers).toBe(10)
    expect(candidate.userActivity.sampleSizeUserMonths).toBe(10)
    expect(candidate.userActivity.sampleSizeActiveAccounts).toBe(1)
    expect(candidate.userActivity.suppressed).toBe(true)
    expect(candidate.userActivity.monthlyAveragePoints).toBeNull()
    expect(candidate.rewardBudget.suppressed).toBe(true)
    expect(candidate.rewardBudget.totals.earnedPoints).toBeNull()
    expect(candidate.rewardBudget.totals.earnedReferenceAtomic).toBeNull()
    expect(report.sensitivity[0].periodEarnedReferenceAtomic).toBeNull()
    expect(report.sensitivity[0].periodEarnedReferenceCny).toBeNull()
    expect(JSON.stringify(report)).not.toContain('7777')
    expect(JSON.stringify(report)).not.toContain('77770')
  })

  it('does not re-expose suppressed values through the sensitivity matrix', () => {
    const report = buildReport(parseJson(singletonInput()), options())
    const row = report.sensitivity[0]
    expect(row.offerP50ReferenceCny).toBeNull()
    expect(row.periodEarnedReferenceAtomic).toBeNull()
    expect(row.totalBalanceReferenceValueExposureCny).toBeNull()
    expect(row.belowCostOfferRate).toBeNull()
    expect(row.roundingIncidence).toBeNull()
  })

  it('rejects gates-config that lowers a privacy floor', () => {
    const directory = mkdtempSync(join(tmpdir(), 'd02-gates-'))
    const path = join(directory, 'gates.json')
    writeFileSync(path, JSON.stringify({ minSampleAccounts: 0 }))
    try {
      loadGateThresholds(path)
      throw new Error('expected privacy floor rejection')
    } catch (error) {
      expect((error as BacktestError).code).toBe(BACKTEST_ERROR_CODES.INVALID_GATES_CONFIG)
      expect((error as BacktestError).message).toMatch(/privacy floor/)
    }
  })

  it('rejects negative, out-of-range, and contradictory gate thresholds', () => {
    const directory = mkdtempSync(join(tmpdir(), 'd02-gates-bad-'))
    writeFileSync(join(directory, 'neg.json'), JSON.stringify({ minSampleOffers: -1 }))
    writeFileSync(join(directory, 'rate.json'), JSON.stringify({ roundingFailAboveRate: '1.5' }))
    writeFileSync(join(directory, 'pair.json'), JSON.stringify({
      roundingWarnAboveRate: '0.4000',
      roundingFailAboveRate: '0.2000',
    }))
    expect(() => loadGateThresholds(join(directory, 'neg.json'))).toThrow(BacktestError)
    expect(() => loadGateThresholds(join(directory, 'rate.json'))).toThrow(/\[0, 1\]/)
    expect(() => loadGateThresholds(join(directory, 'pair.json'))).toThrow(/warn threshold/)
  })

  it('allows raising a privacy floor', () => {
    const directory = mkdtempSync(join(tmpdir(), 'd02-gates-up-'))
    const path = join(directory, 'gates.json')
    writeFileSync(path, JSON.stringify({ minSampleAccounts: 25 }))
    const loaded = loadGateThresholds(path)
    expect(loaded.thresholds.minSampleAccounts).toBe(25)
  })
})
