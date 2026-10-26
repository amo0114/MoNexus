import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MobileNavDrawer from './MobileNavDrawer'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import { resetRechargeNavAvailabilityCache } from '../hooks/useRechargeNavAvailable'
import type { AuthUser } from '../types/merchant'

const { getRechargeConfig } = vi.hoisted(() => ({
  getRechargeConfig: vi.fn(),
}))

vi.mock('../api/recharge', () => ({
  getRechargeConfig,
}))

const LOGGED_IN_USER: AuthUser = {
  id: 77,
  email: 'shopper@example.com',
  nickname: '买家',
  role: 'user',
  status: '正常',
  points: 120,
  emailVerified: '2026-01-01T00:00:00.000Z',
  merchant: null,
}

function disabledError() {
  return {
    response: {
      data: {
        error: { code: 'RECHARGE_DISABLED', message: 'recharge disabled' },
      },
    },
  }
}

/** Transport failure without a server error code. */
function networkError() {
  return new TypeError('Network Error')
}

async function openDrawer() {
  const user = userEvent.setup()
  await user.click(screen.getByLabelText('打开导航菜单'))
  return user
}

describe('MobileNavDrawer recharge entry gating', () => {
  beforeEach(() => {
    resetRechargeNavAvailabilityCache()
    getRechargeConfig.mockReset()
    useAppStore.setState({ orderAttentionCount: 0 })
  })

  afterEach(() => {
    resetRechargeNavAvailabilityCache()
    useAuthStore.setState({ user: null, accessToken: null, sessionId: null, isLoggedIn: false })
  })

  it('never shows the recharge row when logged out, even if recharge is enabled', async () => {
    getRechargeConfig.mockResolvedValue({ currency: 'CNY', mode: 'live', providers: [] })
    useAuthStore.setState({ user: null, accessToken: null, sessionId: null, isLoggedIn: false })

    render(
      <MemoryRouter>
        <MobileNavDrawer />
      </MemoryRouter>,
    )
    await openDrawer()

    // The drawer is open (its login row is present) but recharge stays hidden.
    expect(screen.getByTestId('drawer-login')).toBeInTheDocument()
    expect(screen.queryByTestId('drawer-recharge')).toBeNull()
  })

  it('shows the recharge row when logged in and recharge is enabled', async () => {
    getRechargeConfig.mockResolvedValue({ currency: 'CNY', mode: 'live', providers: [] })
    useAuthStore.setState({ user: LOGGED_IN_USER, accessToken: 'token', sessionId: 's1', isLoggedIn: true })

    render(
      <MemoryRouter>
        <MobileNavDrawer />
      </MemoryRouter>,
    )
    await openDrawer()

    await waitFor(() => {
      expect(screen.getByTestId('drawer-recharge')).toBeInTheDocument()
    })
  })

  it('hides the recharge row when the server explicitly reports RECHARGE_DISABLED', async () => {
    getRechargeConfig.mockRejectedValue(disabledError())
    useAuthStore.setState({ user: LOGGED_IN_USER, accessToken: 'token', sessionId: 's1', isLoggedIn: true })

    render(
      <MemoryRouter>
        <MobileNavDrawer />
      </MemoryRouter>,
    )
    await openDrawer()

    await waitFor(() => {
      expect(getRechargeConfig).toHaveBeenCalledWith('CNY')
    })
    await waitFor(() => {
      expect(screen.queryByTestId('drawer-recharge')).toBeNull()
    })
    // Other logged-in rows are unaffected by the disabled verdict.
    expect(screen.getByTestId('drawer-orders')).toBeInTheDocument()
  })

  it('keeps the recharge row on a network failure (fail-open)', async () => {
    getRechargeConfig.mockRejectedValue(networkError())
    useAuthStore.setState({ user: LOGGED_IN_USER, accessToken: 'token', sessionId: 's1', isLoggedIn: true })

    render(
      <MemoryRouter>
        <MobileNavDrawer />
      </MemoryRouter>,
    )
    await openDrawer()

    await waitFor(() => {
      expect(getRechargeConfig).toHaveBeenCalledWith('CNY')
    })
    // A transient transport failure must not hide a working entry.
    expect(screen.getByTestId('drawer-recharge')).toBeInTheDocument()
  })
})
