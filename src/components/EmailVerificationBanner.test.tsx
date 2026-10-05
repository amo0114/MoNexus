import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import EmailVerificationBanner from './EmailVerificationBanner'
import { useAuthStore } from '../stores/authStore'

vi.mock('../api/auth', () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue({ success: true }),
}))

describe('EmailVerificationBanner', () => {
  beforeEach(() => {
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
})
