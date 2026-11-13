import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAdminCapabilities, useCapabilitiesStore } from './adminCapabilities'
import { useAuthStore } from './authStore'
import { getAdminCapabilities } from '../api/governance'
import { fx, httpError } from '../test/governanceFixtures'
import RoleGuard from '../components/RoleGuard'
import type { AuthUser } from '../types/merchant'

vi.mock('../api/governance', () => ({ getAdminCapabilities: vi.fn() }))

const admin: AuthUser = { id: 1, email: 'a@example.invalid', role: 'admin', status: '正常', points: 0, merchant: null }

function Probe() {
  const caps = useAdminCapabilities()
  return (
    <output data-testid="caps">
      {caps.state.status}|{String(caps.governed)}|{String(caps.can('users.read'))}|{String(caps.can('users.ban'))}
    </output>
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  useCapabilitiesStore.setState({ identity: null, state: { status: 'idle' } })
  useAuthStore.setState({ user: admin, sessionId: 's', authEpoch: 1 })
})

describe('admin capabilities', () => {
  it('grants exactly the listed permissions', async () => {
    vi.mocked(getAdminCapabilities).mockResolvedValue(fx.capabilitiesOperator())
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('caps')).toHaveTextContent('ready|true|true|false'))
  })

  it('treats a backend without the endpoint as unavailable — never as super', async () => {
    vi.mocked(getAdminCapabilities).mockRejectedValue(httpError(404, { error: { code: 'NOT_FOUND', message: 'x' } }))
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('caps')).toHaveTextContent('unavailable|false|false|false'))
  })

  it('ignores another contract version', async () => {
    vi.mocked(getAdminCapabilities).mockResolvedValue({ ...fx.capabilitiesOperator(), contractVersion: 'governance-v2' } as never)
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('caps')).toHaveTextContent('unavailable|false'))
  })
})

describe('RoleGuard merchant capability', () => {
  const merchant = (patch: Partial<AuthUser>): AuthUser => ({
    id: 5, email: 'm@example.invalid', role: 'merchant', status: '正常', points: 0,
    merchant: { id: 8, name: '示例商家', status: 'suspended', commissionRate: '0.1' }, ...patch,
  })
  const guarded = (cap: 'history.read' | 'catalog.write') => (
    <MemoryRouter>
      <RoleGuard allowedRoles={['merchant']} requireActiveMerchant merchantCapability={cap}>
        <div>merchant-area</div>
      </RoleGuard>
    </MemoryRouter>
  )

  it('lets a suspended merchant read history but not publish', () => {
    useAuthStore.setState({ user: merchant({ merchantStatus: 'suspended', merchantCapabilities: ['application.read', 'history.read'] }) })
    const { unmount } = render(guarded('history.read'))
    expect(screen.getByText('merchant-area')).toBeInTheDocument()
    unmount()
    render(guarded('catalog.write'))
    expect(screen.queryByText('merchant-area')).not.toBeInTheDocument()
    expect(screen.getByText(/商家经营已停用/)).toBeInTheDocument()
  })

  it('an account ban (empty capabilities) blocks even read-only history', () => {
    useAuthStore.setState({ user: merchant({ accountStatus: 'banned', merchantCapabilities: [] }) })
    render(guarded('history.read'))
    expect(screen.getByText(/账号已被封禁/)).toBeInTheDocument()
  })

  it('keeps the legacy active-merchant rule on backends without capabilities', () => {
    useAuthStore.setState({ user: merchant({}) })
    render(guarded('history.read'))
    expect(screen.getByText('你的商家账号已被停用')).toBeInTheDocument()
  })
})
