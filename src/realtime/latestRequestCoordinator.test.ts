import { describe, expect, it } from 'vitest'
import { createLatestRequestCoordinator } from './latestRequestCoordinator'

describe('latest request coordinator', () => {
  it('latest generation wins and background inherits an active owner', () => {
    const c = createLatestRequestCoordinator(true)
    const a = c.begin('foreground'); const b = c.begin('background')
    expect(c.isLatest(b)).toBe(true); expect(c.isLatest(a)).toBe(false)
    expect(c.ownsLoading(b)).toBe(true); expect(c.finish(b)).toBe(true)
    expect(c.loadingOwner).toBe(null)
  })
  it('keeps loading until background settles, regardless of completion order', () => {
    const c = createLatestRequestCoordinator(true)
    const a = c.begin('foreground'); const b = c.begin('background')
    expect(c.finish(a)).toBe(false); expect(c.loadingOwner).toBe(b)
    expect(c.finish(b)).toBe(true)
  })
  it('background failure also releases inherited ownership', () => {
    const c = createLatestRequestCoordinator(true); c.begin('foreground')
    const b = c.begin('background'); expect(c.finish(b)).toBe(true)
  })
  it('a new foreground cannot be cleared by older background or foreground', () => {
    const c = createLatestRequestCoordinator(true)
    const a = c.begin('foreground'); const b = c.begin('background'); const d = c.begin('foreground')
    expect(c.finish(b)).toBe(false); expect(c.finish(a)).toBe(false)
    expect(c.ownsLoading(d)).toBe(true); expect(c.finish(d)).toBe(true)
  })
  it('does not give an idle background a skeleton owner', () => {
    const c = createLatestRequestCoordinator(false); const b = c.begin('background')
    expect(c.ownsLoading(b)).toBe(false); expect(c.finish(b)).toBe(false)
  })
})
