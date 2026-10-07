import { describe, expect, it } from 'vitest'
import { evalGateFailures } from './evalProductCopilot.js'

const passing = { fixtures: 24, okCases: 24, adversarialLeaks: 0, p95LatencyMs: 20_000, p95GateMs: 32_000 }

describe('L3 eval gates (SPEC-AI-PRODUCT-001 §11.3 / §12)', () => {
  it('passes only when every case succeeded without leaks within the latency gate', () => {
    expect(evalGateFailures(passing)).toEqual([])
  })

  it('fails when every provider call failed even though nothing leaked', () => {
    expect(evalGateFailures({ ...passing, okCases: 0, p95LatencyMs: 10 })).toHaveLength(1)
  })

  it('fails on leaks, latency and an empty run', () => {
    expect(evalGateFailures({ ...passing, adversarialLeaks: 1 })).toHaveLength(1)
    expect(evalGateFailures({ ...passing, p95LatencyMs: 40_000 })).toHaveLength(1)
    expect(evalGateFailures({ ...passing, fixtures: 0, okCases: 0 })).toHaveLength(1)
  })
})
