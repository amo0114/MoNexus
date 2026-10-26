import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '../stores/authStore'
import { loadStoreCandidates, type StoreCandidateResponse } from './storeCandidates'

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }))
vi.mock('./client', () => ({ default: { get: apiGet } }))
const empty = (): StoreCandidateResponse => ({ version: 1, generatedAt: '2026-10-25T00:00:00Z', sponsored: [], editorial: [] })
function deferred() {
  let resolve!: (value: { data: StoreCandidateResponse }) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<{ data: StoreCandidateResponse }>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = async () => { await Promise.resolve(); await Promise.resolve() }

beforeEach(() => {
  apiGet.mockReset()
  useAuthStore.setState({ user: null, sessionId: null, accessToken: null, isLoggedIn: false, authEpoch: 0 })
})
afterEach(() => { vi.restoreAllMocks() })

describe('store candidate aggregate transport', () => {
  it('shares one request per identity/category and revalidates completed results on the next browse', async () => {
    apiGet.mockResolvedValue({ data: empty() })
    const first = loadStoreCandidates('network_nodes')
    const second = loadStoreCandidates('network_nodes')
    await expect(first).resolves.toEqual({ sponsored: [], editorial: [] })
    await expect(second).resolves.toEqual({ sponsored: [], editorial: [] })
    expect(apiGet).toHaveBeenCalledTimes(1)
    expect(apiGet.mock.calls[0][0]).toBe('/storefront/candidates')
    expect(apiGet.mock.calls[0][1].params).toEqual({ categoryCode: 'network_nodes' })
    await loadStoreCandidates('network_nodes')
    expect(apiGet).toHaveBeenCalledTimes(2)
  })

  it('a cancelled consumer does not cancel another consumer', async () => {
    const transport = deferred()
    apiGet.mockReturnValue(transport.promise)
    const a = new AbortController(), b = new AbortController()
    const first = loadStoreCandidates(undefined, a.signal)
    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const second = loadStoreCandidates(undefined, b.signal)
    await tick()
    a.abort()
    await firstRejected
    expect(apiGet.mock.calls[0][1].signal.aborted).toBe(false)
    transport.resolve({ data: empty() })
    await expect(second).resolves.toEqual({ sponsored: [], editorial: [] })
    expect(apiGet).toHaveBeenCalledTimes(1)
  })

  it('all consumers cancelling aborts transport; a late response cannot be reused', async () => {
    const transport = deferred()
    apiGet.mockReturnValue(transport.promise)
    const controller = new AbortController()
    const first = loadStoreCandidates(undefined, controller.signal)
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await tick()
    const signal = apiGet.mock.calls[0][1].signal as AbortSignal
    controller.abort()
    await rejected
    await tick()
    expect(signal.aborted).toBe(true)
    apiGet.mockResolvedValue({ data: empty() })
    const next = loadStoreCandidates()
    transport.resolve({ data: empty() })
    await next
    expect(apiGet).toHaveBeenCalledTimes(2)
  })

  it('StrictMode-like immediate reattachment reuses the transport', async () => {
    apiGet.mockResolvedValue({ data: empty() })
    const controller = new AbortController()
    const first = loadStoreCandidates(undefined, controller.signal)
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    const second = loadStoreCandidates()
    await rejected
    await second
    expect(apiGet).toHaveBeenCalledTimes(1)
  })

  it('isolates categories and refuses a response after member account/session changes', async () => {
    const transport = deferred()
    apiGet.mockReturnValue(transport.promise)
    useAuthStore.setState({ isLoggedIn: true, user: { id: 7 } as never, sessionId: 'a' })
    const old = loadStoreCandidates('first')
    const oldRejected = expect(old).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' })
    const category = loadStoreCandidates('second')
    const categoryRejected = expect(category).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' })
    await tick()
    expect(apiGet).toHaveBeenCalledTimes(2)
    useAuthStore.setState({ user: { id: 8 } as never, sessionId: 'b' })
    apiGet.mockResolvedValue({ data: empty() })
    await loadStoreCandidates('first')
    transport.resolve({ data: empty() })
    await oldRejected
    await categoryRejected
    expect(apiGet).toHaveBeenCalledTimes(3)
  })

  it('does not retain failures or start transport for an already cancelled consumer', async () => {
    apiGet.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue({ data: empty() })
    await expect(loadStoreCandidates()).rejects.toThrow('unavailable')
    await loadStoreCandidates()
    const controller = new AbortController()
    controller.abort()
    await expect(loadStoreCandidates(undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(apiGet).toHaveBeenCalledTimes(2)
  })
})
