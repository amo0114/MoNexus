import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import SessionManager from './SessionManager'
import {
  getActiveSessions,
  revokeOtherSessions,
  revokeSession,
  type ActiveSessionSummary,
} from '../../api/auth'
import { useAppStore } from '../../stores/appStore'
import { useAuthStore } from '../../stores/authStore'

vi.mock('../../api/auth', () => ({
  getActiveSessions: vi.fn(),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
}))

function createToken(userId: number, sessionId: string) {
  const payload = btoa(JSON.stringify({
    userId,
    sid: sessionId,
    exp: Math.floor(Date.now() / 1000) + 300,
  }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
  return `header.${payload}.signature`
}

function setSession(userId: number, sessionId: string, authEpoch: number) {
  useAuthStore.setState({
    user: {
      id: userId,
      email: `u${userId}@test.local`,
      role: 'user',
      status: '正常',
      points: 0,
      merchant: null,
    },
    accessToken: createToken(userId, sessionId),
    sessionId,
    isLoggedIn: true,
    authEpoch,
  })
}

function makeSession(index: number, current = false): ActiveSessionSummary {
  return {
    sessionId: `00000000-0000-4000-8000-00000000000${index}`,
    deviceLabel: current ? 'Chrome · macOS' : `设备 ${index}`,
    ipHint: current ? '203.0.113.*' : `198.51.100.*`,
    sessionStartedAt: `2026-11-2${index}T08:00:00.000Z`,
    lastUsedAt: `2026-11-2${index}T09:00:00.000Z`,
    current,
  }
}

describe('SessionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useAppStore.setState({ toasts: [] })
    setSession(10, '00000000-0000-4000-8000-000000000001', 1)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows up to 3 sessions by default, labels lastUsedAt as 最近续签, and expands/collapses >3 sessions', async () => {
    vi.mocked(getActiveSessions).mockResolvedValueOnce([
      makeSession(1, true),
      makeSession(2, false),
      makeSession(3, false),
      makeSession(4, false),
    ])

    render(<SessionManager />)

    await waitFor(() => expect(screen.getAllByTestId('session-device')).toHaveLength(3))
    expect(screen.getAllByText(/最近续签：/)).toHaveLength(3)
    expect(screen.queryByText(/最近活跃：/)).not.toBeInTheDocument()
    expect(screen.queryByText('设备 4')).not.toBeInTheDocument()
    expect(screen.getByTestId('session-toggle-all')).toHaveTextContent('查看其余 1 台设备')

    fireEvent.click(screen.getByTestId('session-toggle-all'))
    expect(screen.getAllByTestId('session-device')).toHaveLength(4)
    expect(screen.getByText('设备 4')).toBeInTheDocument()
    expect(screen.getByTestId('session-toggle-all')).toHaveTextContent('收起设备列表')
  })

  it('hides the expand toggle when 3 or fewer sessions exist', async () => {
    vi.mocked(getActiveSessions).mockResolvedValueOnce([
      makeSession(1, true),
      makeSession(2, false),
      makeSession(3, false),
    ])

    render(<SessionManager />)

    await waitFor(() => expect(screen.getAllByTestId('session-device')).toHaveLength(3))
    expect(screen.queryByTestId('session-toggle-all')).not.toBeInTheDocument()
  })

  it('drops stale session list responses after a session switch', async () => {
    let resolveFirst!: (items: ActiveSessionSummary[]) => void
    vi.mocked(getActiveSessions)
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce([
        {
          sessionId: '00000000-0000-4000-8000-000000000099',
          deviceLabel: 'Firefox · Linux',
          ipHint: 'IPv6 地址',
          sessionStartedAt: '2026-11-25T08:00:00.000Z',
          lastUsedAt: '2026-11-25T09:00:00.000Z',
          current: true,
        },
      ])

    render(<SessionManager />)
    await waitFor(() => expect(getActiveSessions).toHaveBeenCalledTimes(1))

    act(() => {
      setSession(20, '00000000-0000-4000-8000-000000000099', 2)
    })

    await waitFor(() => expect(screen.getByText('Firefox · Linux')).toBeInTheDocument())

    await act(async () => {
      resolveFirst([makeSession(1, true)])
    })

    expect(screen.getByText('Firefox · Linux')).toBeInTheDocument()
    expect(screen.queryByText('Chrome · macOS')).not.toBeInTheDocument()
  })

  it('aborts a pending revocation dialog if the auth session changes before confirmation or completion', async () => {
    let resolveRevoke!: () => void
    vi.mocked(getActiveSessions)
      .mockResolvedValueOnce([makeSession(1, true), makeSession(2, false)])
      .mockResolvedValueOnce([makeSession(9, true)])
    vi.mocked(revokeSession).mockReturnValueOnce(new Promise((resolve) => { resolveRevoke = () => resolve() }))

    render(<SessionManager />)
    await waitFor(() => expect(screen.getByTestId('session-revoke-device')).toBeInTheDocument())

    // Open confirm dialog, then switch auth session while dialog is open -> dialog closes cleanly.
    fireEvent.click(screen.getByTestId('session-revoke-device'))
    expect(screen.getByRole('heading', { name: '退出此设备？' })).toBeInTheDocument()
    act(() => {
      setSession(20, '00000000-0000-4000-8000-000000000009', 2)
    })
    await waitFor(() => expect(screen.queryByRole('heading', { name: '退出此设备？' })).not.toBeInTheDocument())
    expect(revokeSession).not.toHaveBeenCalled()

    // Now test in-flight revoke whose session switches before response settles.
    vi.mocked(getActiveSessions)
      .mockResolvedValueOnce([makeSession(9, true), makeSession(8, false)])
      .mockResolvedValueOnce([makeSession(7, true)])
    act(() => {
      setSession(30, '00000000-0000-4000-8000-000000000009', 3)
    })
    await waitFor(() => expect(screen.getByTestId('session-revoke-device')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('session-revoke-device'))
    fireEvent.click(screen.getByRole('button', { name: '确认退出' }))
    await waitFor(() => expect(revokeSession).toHaveBeenCalledOnce())

    act(() => {
      setSession(40, '00000000-0000-4000-8000-000000000007', 4)
    })
    await act(async () => resolveRevoke())
    expect(useAppStore.getState().toasts).toHaveLength(0)
    expect(revokeOtherSessions).not.toHaveBeenCalled()
  })
})
