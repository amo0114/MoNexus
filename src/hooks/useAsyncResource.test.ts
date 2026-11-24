import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthSessionChangedError } from '../auth/sessionContext'
import { useAuthStore } from '../stores/authStore'
import { useAsyncResource } from './useAsyncResource'

function token(userId: number, sid: string) {
  const payload = btoa(JSON.stringify({ userId, sid })).replace(/=+$/, '')
  return `h.${payload}.s`
}

function signIn(userId: number, sid: string) {
  useAuthStore.setState({ user: { id: userId } as never, accessToken: token(userId, sid), sessionId: sid, isLoggedIn: true })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

afterEach(() => {
  cleanup()
  useAuthStore.setState({ user: null, accessToken: null, sessionId: null, isLoggedIn: false })
})

describe('useAsyncResource', () => {
  it('is idle without a key and never calls the loader', () => {
    const load = vi.fn()
    const { result } = renderHook(() => useAsyncResource(null, load))
    expect(result.current.state).toEqual({ status: 'idle' })
    expect(load).not.toHaveBeenCalled()
  })

  it('never renders a superseded result and aborts the old request', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const signals: AbortSignal[] = []
    const { result, rerender } = renderHook(({ id }) => useAsyncResource(`item:${id}`, (signal) => {
      signals.push(signal)
      return id === 1 ? first.promise : second.promise
    }), { initialProps: { id: 1 } })

    rerender({ id: 2 })
    expect(signals[0].aborted).toBe(true)
    await act(async () => { first.resolve('stale') })
    expect(result.current.state).toEqual({ status: 'loading' })
    await act(async () => { second.resolve('fresh') })
    expect(result.current.state).toEqual({ status: 'ready', data: 'fresh' })
  })

  it('reloads when the auth session changes', async () => {
    signIn(7, 'session-a')
    const load = vi.fn().mockResolvedValue('ok')
    const { result } = renderHook(() => useAsyncResource('profile', load))
    await waitFor(() => expect(result.current.state.status).toBe('ready'))

    act(() => signIn(8, 'session-b'))
    expect(result.current.state).toEqual({ status: 'loading' })
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('reports errors of the current key once and ignores session-change failures', async () => {
    const onError = vi.fn()
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new AuthSessionChangedError())
      .mockResolvedValueOnce('ok')
    const { result } = renderHook(() => useAsyncResource('panel', load, { onError }))
    await waitFor(() => expect(result.current.state.status).toBe('error'))
    expect(onError).toHaveBeenCalledTimes(1)

    act(() => result.current.reload())
    expect(result.current.state).toEqual({ status: 'loading' })
    await act(async () => {})
    expect(result.current.state).toEqual({ status: 'loading' })
    expect(onError).toHaveBeenCalledTimes(1)

    act(() => result.current.reload())
    await waitFor(() => expect(result.current.state).toEqual({ status: 'ready', data: 'ok' }))
  })
})
