import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import EmailVerificationBanner from './EmailVerificationBanner'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import { sendVerificationEmail } from '../api/auth'

vi.mock('../api/auth', () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue({ success: true }),
}))

describe('EmailVerificationBanner', () => {
  afterEach(() => vi.restoreAllMocks())
  beforeEach(() => {
    vi.mocked(sendVerificationEmail).mockReset().mockResolvedValue({ ok: true })
    useAppStore.setState({ islandNotice: null, islandQueue: [], islandNoticeAvailable: false, toasts: [] })
    sessionStorage.clear()
    useAuthStore.setState({
      user: {
        id: 1234,
        email: 'user@example.com',
        emailVerified: false,
        role: 'user',
        username: 'test',
        points: 0,
        createdAt: '2026-01-01',
      },
      isLoggedIn: true,
      accessToken: 'test-token',
    })
  })

  it('renders compact warning banner for unverified user with accessible touch targets', () => {
    render(<EmailVerificationBanner />)
    expect(screen.getByText('邮箱尚未验证')).toBeInTheDocument()
    expect(screen.getByText('验证后即可正常购买与签到')).toBeInTheDocument()

    const sendBtn = screen.getByRole('button', { name: '发送验证邮件' })
    expect(sendBtn).toBeInTheDocument()
    expect(sendBtn.className).toContain('min-h-[44px]')

    const closeBtn = screen.getByRole('button', { name: '关闭邮箱验证提示' })
    expect(closeBtn).toBeInTheDocument()
    expect(closeBtn.className).toContain('min-h-[44px]')
    expect(closeBtn.className).toContain('min-w-[44px]')
  })

  it('allows user to dismiss and saves state per userId in sessionStorage', () => {
    render(<EmailVerificationBanner />)
    const closeBtn = screen.getByRole('button', { name: '关闭邮箱验证提示' })
    fireEvent.click(closeBtn)

    expect(sessionStorage.getItem('email-banner-dismissed:1234')).toBe('1')
    expect(screen.queryByText('邮箱尚未验证')).not.toBeInTheDocument()
  })

  it('does not render if user is already email verified', () => {
    useAuthStore.setState({
      user: {
        id: 1234,
        email: 'user@example.com',
        emailVerified: true,
        role: 'user',
        username: 'test',
        points: 0,
        createdAt: '2026-01-01',
      },
    })
    render(<EmailVerificationBanner />)
    expect(screen.queryByText('邮箱尚未验证')).not.toBeInTheDocument()
  })

  it('does not render if guest user', () => {
    useAuthStore.setState({ user: null, isLoggedIn: false })
    render(<EmailVerificationBanner />)
    expect(screen.queryByText('邮箱尚未验证')).not.toBeInTheDocument()
  })
  function enableMobile() {
    vi.spyOn(window, 'matchMedia').mockImplementation(media => ({ matches: media.includes('767'), media, addEventListener() {}, removeEventListener() {} }) as MediaQueryList)
    useAppStore.setState({ islandNoticeAvailable: true })
  }

  it('sends from the mobile reminder once and shows mail guidance only after success', async () => {
    enableMobile()
    let resolve!: (value: { ok: true }) => void
    vi.mocked(sendVerificationEmail).mockImplementation(() => new Promise(r => { resolve = r }))
    render(<EmailVerificationBanner />)
    const reminder = useAppStore.getState().islandNotice!
    expect(reminder.actionLabel).toBe('发送验证邮件')
    expect(screen.queryByText('邮箱尚未验证')).toBeNull()
    act(() => { reminder.onAction?.(); reminder.onAction?.() })
    expect(sendVerificationEmail).toHaveBeenCalledOnce()
    expect(useAppStore.getState().islandNotice?.title).not.toBe('验证邮件已发送')
    await act(async () => resolve({ ok: true }))
    expect(useAppStore.getState().islandNotice?.title).toBe('验证邮件已发送')
    expect(useAppStore.getState().islandNotice?.subtitle).toContain('24 小时')
  })

  it('retains retry on send failure and ignores a late success after account changes', async () => {
    enableMobile()
    vi.mocked(sendVerificationEmail).mockRejectedValueOnce(new Error('offline'))
    render(<EmailVerificationBanner />)
    act(() => { useAppStore.getState().islandNotice?.onAction?.() })
    await waitFor(() => expect(useAppStore.getState().islandNotice?.actionLabel).toBe('重新发送'))
    expect(useAppStore.getState().toasts[0].type).toBe('error')
    let resolve!: (value: { ok: true }) => void
    vi.mocked(sendVerificationEmail).mockImplementation(() => new Promise(r => { resolve = r }))
    act(() => { useAppStore.getState().islandNotice?.onAction?.() })
    act(() => useAuthStore.setState({user:null, authEpoch:useAuthStore.getState().authEpoch+1}))
    await act(async () => resolve({ ok: true }))
    expect(useAppStore.getState().islandNotice).toBeNull()
  })

})
