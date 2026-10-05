import { StrictMode, type ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePageView } from './usePageView'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers() })

describe('page view tracking', () => {
  it('waits for visible product content and counts each navigation once under StrictMode', async () => {
    vi.stubEnv('PROD', true)
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    vi.stubGlobal('fetch', fetcher)
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>
    const { rerender } = renderHook(({ page, ready }) => usePageView(page, ready), {
      initialProps: { page: '/product/1', ready: false }, wrapper,
    })
    expect(fetcher).not.toHaveBeenCalled()
    rerender({ page: '/product/1', ready: true })
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    rerender({ page: '/product/1', ready: false })
    rerender({ page: '/product/1', ready: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
    rerender({ page: '/product/2', ready: true })
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    const first = JSON.parse(fetcher.mock.calls[0][1].body)
    const second = JSON.parse(fetcher.mock.calls[1][1].body)
    expect(first.visitorId).toBe(second.visitorId)
    expect(first.eventId).not.toBe(second.eventId)
  })

  it('retries a lost response with the same event ID and never tracks development previews', async () => {
    vi.useFakeTimers()
    vi.stubEnv('PROD', true)
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('network')).mockResolvedValue({ ok: true, status: 204 })
    vi.stubGlobal('fetch', fetcher)
    const { unmount } = renderHook(() => usePageView('/'))
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100) })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body)
    expect(fetcher.mock.calls[0][1].headers).not.toHaveProperty('Authorization')
    unmount()
    vi.stubEnv('PROD', false)
    renderHook(() => usePageView('/'))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
