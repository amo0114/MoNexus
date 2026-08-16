import { describe, expect, it } from 'vitest'
import { createLatestRequestGuard } from './latestRequest'

describe('latest request commit guard', () => {
  it('prevents an older background response from overwriting a newer refresh', () => {
    const guard = createLatestRequestGuard()
    const olderCanCommit = guard.begin()
    const newerCanCommit = guard.begin()
    expect(olderCanCommit()).toBe(false)
    expect(newerCanCommit()).toBe(true)
  })

  it('invalidates an in-flight request when its consumer closes', () => {
    const guard = createLatestRequestGuard()
    const canCommit = guard.begin()
    guard.invalidate()
    expect(canCommit()).toBe(false)
  })
})
