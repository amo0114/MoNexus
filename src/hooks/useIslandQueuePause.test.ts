import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useIslandQueuePause } from './useIslandQueuePause'
import { islandQueueNow, useAppStore } from '../stores/appStore'

beforeEach(() => {
  vi.useFakeTimers()
  useAppStore.setState({ islandQueuePausedAt: null, islandQueuePausedMs: 0 })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('keeps the queue paused across overlapping modal/search and background visibility, then resumes', () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const clock = () => islandQueueNow(useAppStore.getState())
  const view = renderHook(({ obscured }) => useIslandQueuePause(obscured), { initialProps: { obscured: true } })
  const pausedAt = clock()
  act(() => vi.advanceTimersByTime(40_000))
  visibility.mockReturnValue('hidden')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  view.rerender({ obscured: false })
  act(() => vi.advanceTimersByTime(40_000))
  expect(clock()).toBe(pausedAt)
  visibility.mockReturnValue('visible')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  act(() => vi.advanceTimersByTime(1000))
  expect(clock()).toBe(pausedAt + 1000)
  view.unmount()
  expect(useAppStore.getState().islandQueuePausedAt).toBeNull()
})
