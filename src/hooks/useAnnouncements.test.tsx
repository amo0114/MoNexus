import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicAnnouncement } from '../types/admin'
import { useAuthStore } from '../stores/authStore'
import { beginPendingAuthSessionCommit } from '../auth/pendingAuthSession'
import { useAnnouncements } from './useAnnouncements'

const { getPublicAnnouncements, markAnnouncementRead, acknowledgeAnnouncement } = vi.hoisted(() => ({
  getPublicAnnouncements: vi.fn(),
  markAnnouncementRead: vi.fn(),
  acknowledgeAnnouncement: vi.fn(),
}))

vi.mock('../api/announcements', () => ({
  getPublicAnnouncements,
  markAnnouncementRead,
  acknowledgeAnnouncement,
}))

vi.mock('../realtime/announcementSyncBroadcast', () => ({
  broadcastAnnouncementReceiptInvalidation: vi.fn(),
  subscribeAnnouncementReceiptInvalidation: vi.fn(() => () => {}),
}))

const userA = {
  id: 401,
  email: 'announcement-a@example.test',
  role: 'user' as const,
  status: '正常',
  points: 0,
  merchant: null,
}

const userB = {
  id: 402,
  email: 'announcement-b@example.test',
  role: 'user' as const,
  status: '正常',
  points: 0,
  merchant: null,
}

function createAccessToken(userId: number, sessionId: string): string {
  const payload = {
    userId,
    sid: sessionId,
    exp: Math.floor(Date.now() / 1000) + 60,
  }
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload))
  const payloadBinary = Array.from(payloadBytes, (value) => String.fromCharCode(value)).join('')
  const encodedPayload = btoa(payloadBinary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
  return `header.${encodedPayload}.signature`
}

function createAnnouncement(title: string, version = 1): PublicAnnouncement {
  return {
    id: 71,
    title,
    content: `${title} body`,
    audience: 'user',
    priority: 1,
    presentation: 'acknowledgement_required',
    maxImpressions: 1,
    version,
    startsAt: new Date(Date.now() - 1_000).toISOString(),
    endsAt: null,
    updatedAt: new Date().toISOString(),
    readAt: null,
    acknowledgedAt: null,
  }
}

function establishSession(user: typeof userA | typeof userB, sessionId: string): void {
  const authEpoch = useAuthStore.getState().beginIdentityTransition()
  const accessToken = createAccessToken(user.id, sessionId)
  const committed = useAuthStore.getState().login(
    user,
    accessToken,
    authEpoch,
    beginPendingAuthSessionCommit(accessToken),
  )
  if (!committed) throw new Error('Expected test session to be established')
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useAuthStore.setState({
    user: null,
    accessToken: null,
    sessionId: null,
    isLoggedIn: false,
    authEpoch: 0,
  })
  getPublicAnnouncements.mockResolvedValue([])
  markAnnouncementRead.mockResolvedValue({
    id: 71,
    version: 1,
    readAt: new Date().toISOString(),
    acknowledgedAt: null,
  })
  acknowledgeAnnouncement.mockResolvedValue({
    id: 71,
    version: 1,
    readAt: new Date().toISOString(),
    acknowledgedAt: new Date().toISOString(),
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useAnnouncements identity and displayed-version guards', () => {
  it('hides one account announcements immediately when the active session changes', async () => {
    establishSession(userA, 'session-a')
    getPublicAnnouncements.mockImplementation(async () => (
      useAuthStore.getState().user?.id === userA.id
        ? [createAnnouncement('Account A announcement')]
        : [createAnnouncement('Account B announcement')]
    ))

    const { result } = renderHook(() => useAnnouncements())
    await waitFor(() => expect(result.current.items[0]?.title).toBe('Account A announcement'))

    act(() => establishSession(userB, 'session-b'))
    expect(result.current.items).toEqual([])
    await waitFor(() => expect(result.current.items[0]?.title).toBe('Account B announcement'))
  })

  it('reruns for the new session instead of applying a delayed old-session response', async () => {
    establishSession(userA, 'session-a')
    const delayedAccountAList = deferred<PublicAnnouncement[]>()
    getPublicAnnouncements
      .mockReturnValueOnce(delayedAccountAList.promise)
      .mockResolvedValueOnce([createAnnouncement('Account B announcement')])

    const { result } = renderHook(() => useAnnouncements())
    await waitFor(() => expect(getPublicAnnouncements).toHaveBeenCalledTimes(1))

    act(() => establishSession(userB, 'session-b'))
    delayedAccountAList.resolve([createAnnouncement('Stale Account A announcement')])

    await waitFor(() => expect(result.current.items[0]?.title).toBe('Account B announcement'))
    expect(result.current.items.some((item) => item.title === 'Stale Account A announcement')).toBe(false)
  })

  it('submits the version actually displayed and reloads after a version conflict without auto-confirming', async () => {
    establishSession(userA, 'session-a')
    getPublicAnnouncements
      .mockResolvedValueOnce([createAnnouncement('Displayed version one', 1)])
      .mockResolvedValueOnce([createAnnouncement('Updated version two', 2)])
    acknowledgeAnnouncement.mockRejectedValueOnce({
      response: { data: { error: { code: 'ANNOUNCEMENT_VERSION_CHANGED' } } },
    })

    const { result } = renderHook(() => useAnnouncements())
    await waitFor(() => expect(result.current.items[0]?.version).toBe(1))

    await act(async () => {
      await expect(result.current.acknowledge(result.current.items[0])).rejects.toMatchObject({
        response: { data: { error: { code: 'ANNOUNCEMENT_VERSION_CHANGED' } } },
      })
    })

    await waitFor(() => expect(result.current.items[0]?.version).toBe(2))
    expect(acknowledgeAnnouncement).toHaveBeenCalledTimes(1)
    expect(acknowledgeAnnouncement).toHaveBeenCalledWith(71, 1)
  })

  it('does not let a pre-confirmation list response undo a successful acknowledgement', async () => {
    establishSession(userA, 'session-a')
    const displayedAnnouncement = createAnnouncement('Must confirm')
    const oldListResponse = deferred<PublicAnnouncement[]>()
    getPublicAnnouncements.mockResolvedValueOnce([displayedAnnouncement])

    const { result } = renderHook(() => useAnnouncements())
    await waitFor(() => expect(result.current.items[0]?.acknowledgedAt).toBeNull())

    getPublicAnnouncements
      .mockReturnValueOnce(oldListResponse.promise)
      .mockResolvedValueOnce([{
        ...displayedAnnouncement,
        acknowledgedAt: '2026-10-02T12:00:00.000Z',
        readAt: '2026-10-02T12:00:00.000Z',
      }])
    const staleReload = result.current.reload()
    await waitFor(() => expect(getPublicAnnouncements).toHaveBeenCalledTimes(2))

    acknowledgeAnnouncement.mockResolvedValueOnce({
      id: displayedAnnouncement.id,
      version: displayedAnnouncement.version,
      readAt: '2026-10-02T12:00:00.000Z',
      acknowledgedAt: '2026-10-02T12:00:00.000Z',
    })
    await act(async () => {
      await result.current.acknowledge(displayedAnnouncement)
    })
    expect(result.current.unreadCount).toBe(0)

    oldListResponse.resolve([displayedAnnouncement])
    await staleReload

    await waitFor(() => expect(getPublicAnnouncements).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(result.current.items[0]?.acknowledgedAt).toBe('2026-10-02T12:00:00.000Z'))
    expect(result.current.unreadCount).toBe(0)
  })

  it.each([30, 90])('does not rapidly reload for an announcement ending in %i days', async (daysAhead) => {
    vi.useFakeTimers()
    establishSession(userA, 'session-a')
    getPublicAnnouncements.mockResolvedValueOnce([{
      ...createAnnouncement(`Ends in ${daysAhead} days`),
      endsAt: new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString(),
    }])

    const { result, unmount } = renderHook(() => useAnnouncements())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.items).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })

    expect(getPublicAnnouncements).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('does not create an expiry timer for announcements without an end date', async () => {
    vi.useFakeTimers()
    establishSession(userA, 'session-a')
    getPublicAnnouncements.mockResolvedValueOnce([createAnnouncement('No expiry')])

    const { result, unmount } = renderHook(() => useAnnouncements())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.items).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })

    expect(getPublicAnnouncements).toHaveBeenCalledTimes(1)
    unmount()
  })
})
