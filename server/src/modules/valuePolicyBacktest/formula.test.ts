import { describe, expect, it } from 'vitest'
import { testRuntime } from './__fixtures__/runtime.js'
import { syntheticRef } from './__fixtures__/syntheticSmall.js'
import { normalizeCandidate } from './candidates.js'
import { convertNetAvailableReferenceAtomic, netAvailablePoints } from './convert.js'
import { hashBufferSha256, parseBacktestInput } from './parse.js'
import { buildReport } from './report.js'
import { DEFAULT_GATE_THRESHOLDS } from './thresholds.js'
import type { RunOptions } from './types.js'

function parseJson(value: unknown) {
  const raw = `${JSON.stringify(value)}\n`
  return parseBacktestInput(raw, hashBufferSha256(Buffer.from(raw)), Buffer.byteLength(raw))
}

function options(): RunOptions {
  return {
    inputPath: 'memory.json',
    outputDir: '/tmp/unused',
    candidates: [100, 200],
    candidatesSource: 'explicit_cli',
    referenceAsset: 'CNY',
    overwrite: false,
    thresholds: { ...DEFAULT_GATE_THRESHOLDS },
    gatesConfigSource: 'documented_defaults',
    legacyCommissionBps: null,
    allowUnverifiableSource: false,
    runtime: testRuntime(),
  }
}

function largeInput(activity: Array<{
  earnedPoints: string
  spentPoints: string
  expiredPoints: string
  refundedPoints: string
}>) {
  const accounts = Array.from({ length: 12 }, (_, index) => ({
    accountRef: syntheticRef(`formula-account-${index}`),
    balancePoints: '1000',
    frozenPoints: '0',
  }))
  return {
    schemaVersion: 1,
    period: {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-31T23:59:59.999Z',
    },
    offers: Array.from({ length: 12 }, (_, index) => ({
      offerRef: syntheticRef(`formula-offer-${index}`),
      category: 'subscription',
      pricePoints: '1200',
    })),
    accounts,
    monthlyActivity: accounts.map((account, index) => ({
      month: '2026-01',
      accountRef: account.accountRef,
      ...activity[index % activity.length],
    })),
    orders: [],
  }
}

describe('frozen reward-budget formula', () => {
  it('defines netAvailable as earned - spent - expired + refunded', () => {
    expect(netAvailablePoints(800n, 500n, 50n, 20n)).toBe(270n)
    expect(netAvailablePoints(100n, 80n, 40n, 0n)).toBe(-20n)
  })

  it('converts each component with HALF_EVEN and then combines, allowing a negative net', () => {
    const half = normalizeCandidate(200)
    expect(convertNetAvailableReferenceAtomic(3n, 0n, 0n, 0n, half)).toBe(2n)
    expect(convertNetAvailableReferenceAtomic(0n, 3n, 0n, 0n, half)).toBe(-2n)
    expect(convertNetAvailableReferenceAtomic(5n, 1n, 1n, 1n, half)).toBe(2n)
  })

  it('writes the frozen formula and negative net into the report', () => {
    const report = buildReport(parseJson(largeInput([
      { earnedPoints: '100', spentPoints: '80', expiredPoints: '40', refundedPoints: '0' },
    ])), options())
    const hundred = report.candidates.find(row => row.candidate.pointsPerCnyMajor === 100)
    expect(hundred?.rewardBudget.formula).toBe('netAvailablePoints = earned - spent - expired + refunded')
    expect(hundred?.rewardBudget.suppressed).toBe(false)
    expect(hundred?.rewardBudget.totals.earnedPoints).toBe('1200')
    expect(hundred?.rewardBudget.totals.spentPoints).toBe('960')
    expect(hundred?.rewardBudget.totals.expiredPoints).toBe('480')
    expect(hundred?.rewardBudget.totals.refundedPoints).toBe('0')
    expect(hundred?.rewardBudget.totals.netAvailablePoints).toBe('-240')
    expect(hundred?.rewardBudget.totals.netAvailableReferenceCny).toBe('-2.40')
    expect(hundred?.gates.find(gate => gate.name === 'REWARD_BUDGET')?.status).toBe('warn')
  })

  it('labels period totals as period earned, not monthly reward', () => {
    const report = buildReport(parseJson(largeInput([
      { earnedPoints: '200', spentPoints: '50', expiredPoints: '0', refundedPoints: '10' },
    ])), options())
    const hundred = report.candidates[0]
    expect(report.sensitivity[0].periodEarnedReferenceAtomic).toBe(hundred.rewardBudget.totals.earnedReferenceAtomic)
    expect(JSON.stringify(report)).not.toMatch(/monthlyReward|Monthly reward/)
  })
})
