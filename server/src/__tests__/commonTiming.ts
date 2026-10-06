import { performance } from 'node:perf_hooks'

// Capture the real clock before a test installs fake timers. Profiling is
// opt-in, and records only operation names and durations, never fixture data.
const now = performance.now.bind(performance)
const enabled = process.env.TEST_PROFILE_COMMON_SETUP === '1'
const samples = new Map<string, number[]>()

export async function timeTestOperation<T>(name: string, operation: () => PromiseLike<T>): Promise<T> {
  if (!enabled) return operation()
  const started = now()
  try {
    return await operation()
  } finally {
    const values = samples.get(name) ?? []
    values.push(now() - started)
    samples.set(name, values)
  }
}

export function reportCommonTestTimings(file: string, tests: number): void {
  if (!enabled) return
  const operations = Object.fromEntries([...samples].map(([name, values]) => {
    const sorted = [...values].sort((a, b) => a - b)
    const round = (value: number) => Math.round(value * 100) / 100
    return [name, {
      count: values.length,
      totalMs: round(values.reduce((sum, value) => sum + value, 0)),
      p50Ms: round(sorted[Math.ceil(sorted.length * 0.5) - 1]),
      p95Ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
      maxMs: round(sorted[sorted.length - 1]),
    }]
  }))
  console.info(`BACKEND_TEST_PROFILE ${JSON.stringify({ file, tests, operations })}`)
  samples.clear()
}
