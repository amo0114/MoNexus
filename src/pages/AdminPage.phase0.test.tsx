import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import AdminPage from './AdminPage'
import { useAppStore } from '../stores/appStore'

const mocks = vi.hoisted(() => ({
  batchSettle: vi.fn(),
  getSettlements: vi.fn(),
  listAdminAudit: vi.fn(),
}))

vi.mock('../components/merchandising/AdminMerchandisingPage', () => ({
  default: () => <div data-testid="mock-merchandising" />,
}))
vi.mock('../components/catalog/AdminCategoryManager', () => ({
  default: () => <div data-testid="mock-catalog" />,
}))
vi.mock('../components/admin/recharge/AdminRechargePage', () => ({
  default: () => <div data-testid="mock-recharge" />,
}))

const statsFixture = {
  users: 120,
  orders: 85,
  totalPoints: 5000,
  todayOrders: 12,
  todayCheckins: 34,
  productCount: 8,
  availableInventory: 156,
}

const logsFixture = [
  {
    id: 1,
    userId: 101,
    user: { id: 101, email: 'u101@test.com' },
    type: 'refund',
    amount: 50,
    balanceAfter: 550,
    reason: '订单退款',
    createdAt: '2026-09-03T10:00:00.000Z',
  },
  {
    id: 2,
    userId: 102,
    user: { id: 102, email: 'u102@test.com' },
    type: 'out',
    amount: 100,
    balanceAfter: 450,
    reason: '商城购买',
    createdAt: '2026-09-03T09:00:00.000Z',
  },
  {
    id: 3,
    userId: 103,
    user: { id: 103, email: 'u103@test.com' },
    type: 'release',
    amount: 30,
    balanceAfter: 480,
    reason: '待支付返还',
    createdAt: '2026-09-03T08:00:00.000Z',
  },
]

const settlementsFixture = [
  {
    id: 11,
    orderId: 1001,
    merchantId: 1,
    merchant: { name: '商家A' },
    commissionAmount: 5,
    commissionRate: '0.05',
    orderAmount: 100,
    settlementAmount: 95,
    status: 'pending',
    createdAt: '2026-09-03T07:00:00.000Z',
  },
  {
    id: 12,
    orderId: 1002,
    merchantId: 2,
    merchant: { name: '商家B' },
    commissionAmount: 10,
    commissionRate: '0.05',
    orderAmount: 200,
    settlementAmount: 190,
    status: 'pending',
    createdAt: '2026-09-03T07:30:00.000Z',
  },
  {
    id: 13,
    orderId: 1003,
    merchantId: 1,
    merchant: { name: '商家A' },
    commissionAmount: 5,
    commissionRate: '0.05',
    orderAmount: 100,
    settlementAmount: 95,
    status: 'settled',
    createdAt: '2026-09-03T06:00:00.000Z',
  },
]

vi.mock('../api/client', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (url === '/admin/stats') return Promise.resolve({ data: statsFixture })
      if (url === '/admin/logs') return Promise.resolve({ data: logsFixture })
      if (url === '/admin/reports/offers') return Promise.resolve({ data: { items: [] } })
      return Promise.resolve({ data: [] })
    }),
  },
}))

vi.mock('../api/adminMerchant', () => ({
  getAdminMerchants: vi.fn(() => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 20 })),
  approveMerchant: vi.fn(),
  rejectMerchant: vi.fn(),
  suspendMerchant: vi.fn(),
  getAdminSettlements: mocks.getSettlements,
  batchSettle: mocks.batchSettle,
}))

vi.mock('../api/adminAudit', () => ({
  listAdminAudit: mocks.listAdminAudit,
}))

describe('AdminPage Phase 0 verification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [] })
    mocks.getSettlements.mockResolvedValue({
      items: settlementsFixture,
      total: settlementsFixture.length,
      page: 1,
      pageSize: 20,
    })
    mocks.batchSettle.mockResolvedValue({ settled: 2, creditedTotal: 285 })
  })

  it('renders dashboard with platform order count label and extended metrics', async () => {
    render(<AdminPage />)

    expect(await screen.findByText('平台订单总数')).toBeInTheDocument()
    expect(screen.getByText('85')).toBeInTheDocument()
    expect(screen.getByText('今日新增订单')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('今日签到人次')).toBeInTheDocument()
    expect(screen.getByText('34')).toBeInTheDocument()
    expect(screen.getByText('在售商品数')).toBeInTheDocument()
    expect(screen.getByText('8')).toBeInTheDocument()
    expect(screen.getByText('可用卡密库存')).toBeInTheDocument()
    expect(screen.getByText('156')).toBeInTheDocument()
  })

  it('renders point logs with correct type badge, amount prefix, and balanceAfter', async () => {
    render(<AdminPage />)
    expect(await screen.findByText('平台订单总数')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '积分流水' }))
    expect(await screen.findByText('变动后余额')).toBeInTheDocument()

    // Row 1: refund (should be +50 with 退款 badge and balanceAfter 550)
    expect(screen.getByText('+50')).toBeInTheDocument()
    expect(screen.getByText('退款')).toBeInTheDocument()
    expect(screen.getByText('550')).toBeInTheDocument()

    // Row 2: out (should be −100 with 已支付 badge and balanceAfter 450)
    expect(screen.getByText('−100')).toBeInTheDocument()
    expect(screen.getByText('已支付')).toBeInTheDocument()
    expect(screen.getByText('450')).toBeInTheDocument()

    // Row 3: release (should be +30 with 已返还 badge and balanceAfter 480)
    expect(screen.getByText('+30')).toBeInTheDocument()
    expect(screen.getByText('已返还')).toBeInTheDocument()
    expect(screen.getByText('480')).toBeInTheDocument()
  })

  it('opens batch settle confirmation with pending sum and executes batchSettle only on confirm', async () => {
    render(<AdminPage />)
    expect(await screen.findByText('平台订单总数')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '结算管理' }))
    expect(await screen.findByText('ORD-1001')).toBeInTheDocument()

    // Select all pending records via header checkbox
    const selectAllCheckbox = screen.getAllByRole('checkbox')[0]
    fireEvent.click(selectAllCheckbox)

    const batchSettleBtn = screen.getByTestId('admin-batch-settle')
    expect(batchSettleBtn).toHaveTextContent('批量结算 (2)')

    fireEvent.click(batchSettleBtn)

    // Confirm dialog should be open with pending sum: 95 + 190 = 285
    expect(await screen.findByTestId('admin-batch-settle-confirm-dialog')).toBeInTheDocument()
    expect(screen.getByText(/285 积分/)).toBeInTheDocument()
    expect(screen.getByText(/2 笔待结算订单/)).toBeInTheDocument()

    // Click confirm in dialog
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
    await waitFor(() => expect(mocks.batchSettle).toHaveBeenCalledWith({ settlementIds: [11, 12] }))
    expect(useAppStore.getState().toasts.some((t) => t.message.includes('成功结算 2 笔订单'))).toBe(true)
  })

  it('audit search uses explicit snapshot with page 1, without duplicate requests or race conditions', async () => {
    mocks.listAdminAudit.mockResolvedValue({
      items: [
        { id: 1, adminId: 1, adminEmail: 'admin@test.com', action: 'login', targetType: 'system', createdAt: '2026-09-03T10:00:00.000Z' },
      ],
      total: 45,
    })

    render(<AdminPage />)
    expect(await screen.findByText('平台订单总数')).toBeInTheDocument()

    // Switch to Audit tab
    fireEvent.click(screen.getByRole('button', { name: '操作审计' }))
    expect(await screen.findByText('共 45 条记录，第 1 / 3 页')).toBeInTheDocument()
    expect(mocks.listAdminAudit).toHaveBeenCalledWith({ page: 1, pageSize: 20 })

    // Paginate to page 2
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(mocks.listAdminAudit).toHaveBeenCalledWith({ page: 2, pageSize: 20 })

    mocks.listAdminAudit.mockClear()

    // Type into filters
    const adminIdInput = await screen.findByPlaceholderText('管理员ID')
    const actionInput = screen.getByPlaceholderText('操作动作 (如: ban)')
    fireEvent.change(adminIdInput, { target: { value: '88' } })
    fireEvent.change(actionInput, { target: { value: 'user.ban' } })

    // Click search
    fireEvent.click(screen.getByRole('button', { name: '查询' }))

    // Verified: exactly ONE call, with page 1 and explicit filter snapshot (no stale page 2 or effect replay)
    expect(mocks.listAdminAudit).toHaveBeenCalledTimes(1)
    expect(mocks.listAdminAudit).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
      adminId: 88,
      action: 'user.ban',
    })

    mocks.listAdminAudit.mockClear()

    // Click reset: immediately fetches page 1 with empty filters (no setTimeout, exactly 1 call)
    fireEvent.click(screen.getByRole('button', { name: '重置' }))
    expect(mocks.listAdminAudit).toHaveBeenCalledTimes(1)
    expect(mocks.listAdminAudit).toHaveBeenCalledWith({ page: 1, pageSize: 20 })
    expect(adminIdInput).toHaveValue('')
    expect(actionInput).toHaveValue('')
  })

  it('audit logs protects against out-of-order responses with request sequence guard', async () => {
    let resolveSearchA: ((data: any) => void) | undefined
    mocks.listAdminAudit.mockImplementation(({ action }) => {
      if (action === 'action_slow') {
        return new Promise((resolve) => { resolveSearchA = resolve })
      }
      return Promise.resolve({
        items: [
          { id: 99, adminId: 99, adminEmail: 'fast@test.com', action: 'action_fast', targetType: 'system', createdAt: '2026-09-03T11:00:00.000Z' },
        ],
        total: 1,
      })
    })

    render(<AdminPage />)
    expect(await screen.findByText('平台订单总数')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '操作审计' }))
    const actionInput = await screen.findByPlaceholderText('操作动作 (如: ban)')

    // Search A (slow)
    fireEvent.change(actionInput, { target: { value: 'action_slow' } })
    fireEvent.click(screen.getByRole('button', { name: '查询' }))

    // Search B (fast)
    fireEvent.change(actionInput, { target: { value: 'action_fast' } })
    fireEvent.click(screen.getByRole('button', { name: '查询' }))

    // Fast search renders
    expect(await screen.findByText('action_fast')).toBeInTheDocument()

    // Slow search A resolves later
    resolveSearchA?.({
      items: [
        { id: 11, adminId: 11, adminEmail: 'slow@test.com', action: 'action_slow', targetType: 'system', createdAt: '2026-09-03T09:00:00.000Z' },
      ],
      total: 1,
    })

    await new Promise((r) => setTimeout(r, 20))

    // Verified: stale search A MUST NOT overwrite search B
    expect(screen.getByText('action_fast')).toBeInTheDocument()
    expect(screen.queryByText('action_slow')).not.toBeInTheDocument()
  })
})

