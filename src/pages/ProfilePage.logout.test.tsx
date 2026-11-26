import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ProfilePage from './ProfilePage'
import { logoutCurrentSession } from '../api/auth'
import { disablePush, isPushSupported } from '../lib/webPush'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'

const mockNavigate = vi.fn()

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})

vi.mock('../api/auth', () => ({
  logoutCurrentSession: vi.fn(),
  getActiveSessions: vi.fn().mockResolvedValue([]),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
  updateMe: vi.fn(),
  changePassword: vi.fn(),
  sendVerificationEmail: vi.fn(),
}))

vi.mock('../api/orders', () => ({
  getOrders: vi.fn().mockResolvedValue([]),
  getOrderDetail: vi.fn(),
}))

vi.mock('../api/points', () => ({
  getMemberTier: vi.fn().mockResolvedValue({
    tier: 'bronze',
    label: '青铜',
    tone: 'neutral',
    lifetimeEarnedPoints: 0,
    bonusBps: 0,
    thresholds: { silver: 1000, gold: 5000, platinum: 10000 },
    nextTier: 'silver',
    pointsToNextTier: 1000,
  }),
}))

vi.mock('../api/registry', () => ({
  getConfigRegistry: vi.fn().mockResolvedValue({}),
}))

vi.mock('../hooks/useCheckin', () => ({
  useCheckin: () => ({ status: { hasCheckedIn: false }, busy: null, checkin: vi.fn() }),
}))

vi.mock('../lib/webPush', () => ({
  isPushSupported: vi.fn(() => false),
  disablePush: vi.fn(() => Promise.resolve()),
}))

vi.mock('../components/ChatBindCard', () => ({ default: () => <div data-testid="chat-bind-stub" /> }))
vi.mock('../components/PushToggle', () => ({ default: () => <div data-testid="push-toggle-stub" /> }))
vi.mock('../components/checkin/CheckinCard', () => ({ default: () => <div data-testid="checkin-stub" /> }))
vi.mock('../components/profile/ProfileIdentityCard', () => ({ default: () => <div data-testid="identity-stub" /> }))
vi.mock('../components/auth/SessionManager', () => ({ default: () => <div data-testid="sessions-stub" /> }))

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

function setLoggedIn(userId: number, sessionId: string, authEpoch: number) {
  useAuthStore.setState({
    user: {
      id: userId,
      email: `profile-${userId}@test.local`,
      nickname: `用户${userId}`,
      role: 'user',
      status: '正常',
      points: 100,
      merchant: null,
    },
    accessToken: createToken(userId, sessionId),
    sessionId,
    isLoggedIn: true,
    authEpoch,
  })
}

function renderProfileSettings() {
  return render(
    <MemoryRouter initialEntries={['/profile?tab=settings']}>
      <ProfilePage />
    </MemoryRouter>,
  )
}

describe('ProfilePage logout error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useAppStore.setState({ toasts: [], orderAttentionCount: 0, pointsHistoryOpen: false })
    setLoggedIn(101, 'profile-session-1', 1)
    vi.mocked(isPushSupported).mockReturnValue(false)
  })

  it('stays logged in on /profile and shows an error toast when logoutCurrentSession fails', async () => {
    vi.mocked(logoutCurrentSession).mockRejectedValueOnce(new Error('network failure'))

    renderProfileSettings()
    const logoutButton = await screen.findByTestId('profile-logout')
    fireEvent.click(logoutButton)

    await waitFor(() => expect(logoutCurrentSession).toHaveBeenCalledOnce())
    await waitFor(() => expect(useAppStore.getState().toasts).toHaveLength(1))
    expect(useAppStore.getState().toasts[0]?.type).toBe('error')
    expect(useAuthStore.getState().isLoggedIn).toBe(true)
    expect(useAuthStore.getState().sessionId).toBe('profile-session-1')
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(logoutButton).toBeEnabled()
  })

  it('clears local auth and navigates to /login when logoutCurrentSession succeeds', async () => {
    vi.mocked(logoutCurrentSession).mockResolvedValueOnce(undefined)

    renderProfileSettings()
    fireEvent.click(await screen.findByTestId('profile-logout'))

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/login'))
    expect(useAuthStore.getState().isLoggedIn).toBe(false)
    expect(logoutCurrentSession).toHaveBeenCalledWith({
      userId: 101,
      sessionId: 'profile-session-1',
      authEpoch: 1,
    })
  })

  it('aborts logout without touching a newer account if the session changes during disablePush', async () => {
    let finishPush!: () => void
    vi.mocked(isPushSupported).mockReturnValue(true)
    vi.mocked(disablePush).mockReturnValueOnce(new Promise<void>((resolve) => { finishPush = resolve }))

    renderProfileSettings()
    fireEvent.click(await screen.findByTestId('profile-logout'))
    await waitFor(() => expect(disablePush).toHaveBeenCalledOnce())

    act(() => {
      setLoggedIn(202, 'profile-session-new', 2)
    })
    await act(async () => finishPush())

    expect(logoutCurrentSession).not.toHaveBeenCalled()
    expect(useAuthStore.getState().isLoggedIn).toBe(true)
    expect(useAuthStore.getState().sessionId).toBe('profile-session-new')
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})
