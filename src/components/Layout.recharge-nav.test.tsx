import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * jsdom lacks ResizeObserver; Layout observes the navbar lane to publish its
 * height. A no-op stub is sufficient because these cases assert only the
 * presence/absence of the recharge CTA.
 */
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub

vi.mock('../api/announcements', () => ({
  getPublicAnnouncements: vi.fn().mockResolvedValue([]),
  acknowledgeAnnouncement: vi.fn(),
  markAnnouncementRead: vi.fn(),
}))

vi.mock('../api/notifications', () => ({
  getNotifications: vi.fn().mockResolvedValue({ items: [], unreadCount: 0 }),
  markAsRead: vi.fn(),
}))

const { getRechargeConfig } = vi.hoisted(() => ({
  getRechargeConfig: vi.fn(),
}))

vi.mock('../api/recharge', () => ({
  getRechargeConfig,
}))

import Layout from './Layout'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import { resetRechargeNavAvailabilityCache } from '../hooks/useRechargeNavAvailable'
import type { AuthUser } from '../types/merchant'

const LOGGED_IN_USER: AuthUser = {
  id: 91,
  email: 'shopper@example.com',
  nickname: '买家',
  role: 'user',
  status: '正常',
  points: 40,
  emailVerified: '2026-01-01T00:00:00.000Z',
  merchant: null,
}

function disabledError() {
  return {
    response: {
      data: { error: { code: 'RECHARGE_DISABLED', message: 'recharge disabled' } },
    },
  }
}

function renderLayout() {
  return render(
    <MemoryRouter>
      <Layout>content</Layout>
    </MemoryRouter>,
  )
}

describe('Layout desktop recharge entry gating', () => {
  beforeEach(() => {
    resetRechargeNavAvailabilityCache()
    getRechargeConfig.mockReset()
    useAppStore.setState({ orderAttentionCount: 0, notificationUnreadCount: 0 })
  })

  afterEach(() => {
    resetRechargeNavAvailabilityCache()
    useAuthStore.setState({ user: null, accessToken: null, sessionId: null, isLoggedIn: false })
  })

  it('hides the desktop recharge entry when logged out, even if recharge is enabled', async () => {
    getRechargeConfig.mockResolvedValue({ currency: 'CNY', mode: 'live', providers: [] })
    useAuthStore.setState({ user: null, accessToken: null, sessionId: null, isLoggedIn: false })

    renderLayout()

    // Logged-out chrome renders (login CTA present), but no recharge entry.
    expect(await screen.findByTestId('nav-login')).toBeInTheDocument()
    expect(screen.queryByTestId('nav-recharge')).toBeNull()
  })

  it('shows the desktop recharge entry when logged in and recharge is enabled', async () => {
    getRechargeConfig.mockResolvedValue({ currency: 'CNY', mode: 'live', providers: [] })
    useAuthStore.setState({ user: LOGGED_IN_USER, accessToken: 'token', sessionId: 's1', isLoggedIn: true })

    renderLayout()

    await waitFor(() => {
      expect(screen.getByTestId('nav-recharge')).toBeInTheDocument()
    })
  })

  it('hides the desktop recharge entry when the server explicitly reports RECHARGE_DISABLED', async () => {
    getRechargeConfig.mockRejectedValue(disabledError())
    useAuthStore.setState({ user: LOGGED_IN_USER, accessToken: 'token', sessionId: 's1', isLoggedIn: true })

    renderLayout()

    await waitFor(() => {
      expect(getRechargeConfig).toHaveBeenCalledWith('CNY')
    })
    await waitFor(() => {
      expect(screen.queryByTestId('nav-recharge')).toBeNull()
    })
  })

  it('keeps the desktop recharge entry on a network failure (fail-open)', async () => {
    getRechargeConfig.mockRejectedValue(new TypeError('Network Error'))
    useAuthStore.setState({ user: LOGGED_IN_USER, accessToken: 'token', sessionId: 's1', isLoggedIn: true })

    renderLayout()

    await waitFor(() => {
      expect(getRechargeConfig).toHaveBeenCalledWith('CNY')
    })
    expect(screen.getByTestId('nav-recharge')).toBeInTheDocument()
  })
})
