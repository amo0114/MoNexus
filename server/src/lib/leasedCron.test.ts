import { describe, it, expect } from 'vitest'
import { defineLeasedCron } from './leasedCron.js'
import { registry } from './metrics.js'

// The test environment's cron lease is a pass-through handle, so each tick runs.
async function series(name: string) {
  const metrics = await registry.getMetricsAsJSON()
  const value = (metric: string, labels: Record<string, string>) => metrics
    .find(m => m.name === metric)?.values
    .find(v => Object.entries(labels).every(([k, l]) => v.labels[k] === l))?.value
  return {
    success: value('monexus_cron_runs_total', { job: name, outcome: 'success' }) ?? 0,
    failure: value('monexus_cron_runs_total', { job: name, outcome: 'failure' }) ?? 0,
    lastSuccess: value('monexus_cron_last_success_timestamp_seconds', { job: name }),
  }
}

describe('defineLeasedCron', () => {
  it('counts a successful tick and records its time', async () => {
    let runs = 0
    const cron = defineLeasedCron({ name: 'test-leased-ok', intervalMs: 60_000, run: async () => { runs++ } })
    const before = Date.now() / 1000
    await cron.tick()
    const s = await series('test-leased-ok')
    expect(runs).toBe(1)
    expect(s.success).toBe(1)
    expect(s.lastSuccess).toBeGreaterThanOrEqual(before)
  })

  it('isolates a failing tick: no throw, failure counted, no success time', async () => {
    const cron = defineLeasedCron({ name: 'test-leased-fail', intervalMs: 60_000, run: async () => { throw new Error('boom') } })
    await expect(cron.tick()).resolves.toBeUndefined()
    const s = await series('test-leased-fail')
    expect(s.failure).toBe(1)
    expect(s.success).toBe(0)
    expect(s.lastSuccess).toBeUndefined()
  })

  it('does not re-enter while a tick is still running', async () => {
    let release!: () => void
    let runs = 0
    const cron = defineLeasedCron({
      name: 'test-leased-reentry',
      intervalMs: 60_000,
      run: () => { runs++; return new Promise<void>(resolve => { release = resolve }) },
    })
    const first = cron.tick()
    await new Promise(resolve => setImmediate(resolve))
    await cron.tick()
    release()
    await first
    expect(runs).toBe(1)
  })
})
