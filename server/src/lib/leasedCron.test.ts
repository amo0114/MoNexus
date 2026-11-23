import { describe, it, expect } from 'vitest'
import { defineLeasedCron } from './leasedCron.js'
import { acquireCronLeaseWithHeartbeat } from './cronLease.js'
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

  it('isolates a failing tick: no throw, failure counted, success time not advanced', async () => {
    const cron = defineLeasedCron({ name: 'test-leased-fail', intervalMs: 60_000, run: async () => { throw new Error('boom') } })
    await expect(cron.tick()).resolves.toBeUndefined()
    const first = await series('test-leased-fail')
    await new Promise(resolve => setTimeout(resolve, 5))
    await cron.tick()
    const s = await series('test-leased-fail')
    expect(s.failure).toBe(2)
    expect(s.success).toBe(0)
    // Staleness counts from the first acquisition until a tick succeeds.
    expect(s.lastSuccess).toBe(first.lastSuccess)
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

  it('records a hand-written cron as failed when its catch marks the lease', async () => {
    const lease = await acquireCronLeaseWithHeartbeat('test-hand-written', 60_000, { scheduleMs: 600_000 })
    lease!.markFailed()
    lease!.release()
    lease!.release() // a second release must not record another outcome
    const s = await series('test-hand-written')
    expect(s.failure).toBe(1)
    expect(s.success).toBe(0)
    const interval = (await registry.getMetricsAsJSON()).find(m => m.name === 'monexus_cron_interval_seconds')
      ?.values.find(v => v.labels.job === 'test-hand-written')?.value
    expect(interval).toBe(600)
  })
})
