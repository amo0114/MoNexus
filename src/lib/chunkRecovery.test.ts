import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { recoverFromPreloadError } from './chunkRecovery'

beforeEach(() => { window.sessionStorage.clear() })
afterEach(() => { vi.restoreAllMocks() })

it('reloads once on a stale chunk and suppresses the import error', () => {
  const reload = vi.fn()
  const event = new Event('vite:preloadError', { cancelable: true })

  expect(recoverFromPreloadError(event, reload, 1_000_000)).toBe(true)
  expect(reload).toHaveBeenCalledTimes(1)
  expect(event.defaultPrevented).toBe(true)
})

it('falls back to the error page when the reloaded document fails again', () => {
  const reload = vi.fn()
  recoverFromPreloadError(new Event('vite:preloadError', { cancelable: true }), reload, 1_000_000)

  const again = new Event('vite:preloadError', { cancelable: true })
  expect(recoverFromPreloadError(again, reload, 1_005_000)).toBe(false)
  expect(reload).toHaveBeenCalledTimes(1)
  expect(again.defaultPrevented).toBe(false)
})

it('recovers again for a later release in the same tab', () => {
  const reload = vi.fn()
  recoverFromPreloadError(new Event('vite:preloadError', { cancelable: true }), reload, 1_000_000)

  expect(recoverFromPreloadError(new Event('vite:preloadError', { cancelable: true }), reload, 2_000_000)).toBe(true)
  expect(reload).toHaveBeenCalledTimes(2)
})

it('does not reload without session storage, avoiding an unguarded loop', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
  const reload = vi.fn()
  const event = new Event('vite:preloadError', { cancelable: true })

  expect(recoverFromPreloadError(event, reload)).toBe(false)
  expect(reload).not.toHaveBeenCalled()
  expect(event.defaultPrevented).toBe(false)
})
