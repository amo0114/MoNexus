import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import UserDetailSheet from './UserDetailSheet'
import * as governanceApi from '../../../api/governance'
import { useCapabilitiesStore } from '../../../stores/adminCapabilities'
import { useAuthStore } from '../../../stores/authStore'
import { fx } from '../../../test/governanceFixtures'
import type { AdminPermission, GVUserDetail, GVUserOrder } from '../../../types/governance'

vi.mock('../../../api/governance', () => ({
  getAdminCapabilities: vi.fn(),
  getAdminUserDetail: vi.fn(),
  listUserOrders: vi.fn(),
  listUserPointLogs: vi.fn(),
  listUserSessions: vi.fn(),
  listUserReferrals: vi.fn(),
  listUserSecurityEvents: vi.fn(),
  listUserAudit: vi.fn(),
  listUserBans: vi.fn(),
  getAdminAuditDetail: vi.fn(),
  getAdminAuthorization: vi.fn(),
}))

const api = vi.mocked(governanceApi)
const emptyPage = { items: [], pageInfo: { nextCursor: null, hasNextPage: false }, asOf: '2026-11-12T08:00:00.000Z' }

function grant(permissions: AdminPermission[]) {
  const caps = { ...fx.capabilitiesOperator(), permissions }
  useAuthStore.setState({ user: { id: 1, email: 'a@example.invalid', role: 'admin', status: '正常', points: 0, merchant: null }, sessionId: 's', authEpoch: 1 })
  useCapabilitiesStore.setState({ identity: '1:s:1', state: { status: 'ready', capabilities: caps } })
}

function detailFor(id: number, patch: Partial<GVUserDetail> = {}): GVUserDetail {
  const d = fx.userBannedLegacyIncomplete()
  return { ...d, ...patch, user: { ...d.user, id, email: `u${id}@example.invalid`, nickname: `用户${id}` } }
}

function order(id: number): GVUserOrder {
  return { id, orderNo: `MN20261112-${id}`, productName: `商品${id}`, status: 'closed', price: 100, chargedPoints: 100, refundedPoints: 0, createdAt: '2026-11-12T08:00:00.000Z' }
}

beforeEach(() => {
  vi.resetAllMocks()
  for (const fn of [api.listUserPointLogs, api.listUserSessions, api.listUserReferrals, api.listUserSecurityEvents, api.listUserAudit, api.listUserBans]) {
    fn.mockResolvedValue(emptyPage)
  }
  grant(['users.read', 'orders.read', 'points.read'])
})

describe('UserDetailSheet', () => {
  it('renders null wallet/stats as "no permission", never as zero, and skips hidden sections', async () => {
    api.getAdminUserDetail.mockResolvedValue(detailFor(42, {
      wallet: null,
      stats: null,
      sections: { orders: true, pointLogs: false, sessions: false, referrals: false, securityEvents: false, audit: false },
    }))
    api.listUserOrders.mockResolvedValue({ ...emptyPage, items: [order(9)] })
    render(<UserDetailSheet userId={42} onOpenChange={() => {}} />)

    expect(await screen.findByTestId('user-detail-wallet')).toHaveTextContent('没有积分查看权限')
    expect(screen.getByTestId('user-detail-wallet')).not.toHaveTextContent(/^0$/)
    expect(screen.getByTestId('user-detail-stats')).toHaveTextContent('没有消费统计的查看权限')
    expect(screen.queryByTestId('user-detail-tab-pointLogs')).not.toBeInTheDocument()
    expect(await screen.findByText('MN20261112-9')).toBeInTheDocument()
    expect(api.listUserPointLogs).not.toHaveBeenCalled()
    expect(api.listUserSessions).not.toHaveBeenCalled()
  })

  it('shows the active ban, legacy-completeness caveat and distinct activity precisions', async () => {
    api.getAdminUserDetail.mockResolvedValue(detailFor(42))
    api.listUserOrders.mockResolvedValue(emptyPage)
    render(<UserDetailSheet userId={42} onOpenChange={() => {}} />)

    expect(await screen.findByTestId('user-detail-active-ban')).toHaveTextContent('合成运营理由')
    expect(screen.getByTestId('user-detail-completeness')).toHaveTextContent('含历史缺口')
    // lastLoginAt null → "未知", not the registration date.
    expect(screen.getByText('最近成功登录').nextSibling).toHaveTextContent('未知')
  })

  it('loads a section only when its tab is opened', async () => {
    api.getAdminUserDetail.mockResolvedValue(detailFor(42))
    api.listUserOrders.mockResolvedValue(emptyPage)
    render(<UserDetailSheet userId={42} onOpenChange={() => {}} />)
    await screen.findByTestId('user-detail-tab-orders')
    expect(api.listUserSessions).not.toHaveBeenCalled()

    fireEvent.mouseDown(screen.getByTestId('user-detail-tab-sessions'))
    await waitFor(() => expect(api.listUserSessions).toHaveBeenCalledWith(42, expect.objectContaining({ cursor: null })))
  })

  it('never renders a late response for the previously opened user', async () => {
    let resolveA!: (d: GVUserDetail) => void
    api.getAdminUserDetail
      .mockImplementationOnce(() => new Promise((r) => { resolveA = r }))
      .mockResolvedValueOnce(detailFor(8))
    api.listUserOrders.mockResolvedValue(emptyPage)

    const { rerender } = render(<UserDetailSheet userId={7} onOpenChange={() => {}} />)
    rerender(<UserDetailSheet userId={8} onOpenChange={() => {}} />)
    expect(await screen.findByText('u8@example.invalid', { exact: false })).toBeInTheDocument()

    resolveA(detailFor(7))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByText('u7@example.invalid', { exact: false })).not.toBeInTheDocument()
  })

  it('shows a no-permission state for a 403 section without retrying it', async () => {
    api.getAdminUserDetail.mockResolvedValue(detailFor(42))
    api.listUserOrders.mockRejectedValue(Object.assign(new Error('403'), { response: { status: 403, data: { error: { code: 'PERMISSION_DENIED', message: 'x' } } } }))
    render(<UserDetailSheet userId={42} onOpenChange={() => {}} />)
    expect(await screen.findByTestId('governance-forbidden')).toBeInTheDocument()
    expect(api.listUserOrders).toHaveBeenCalledTimes(1)
  })
})
