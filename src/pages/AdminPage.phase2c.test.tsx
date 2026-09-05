import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminPage from './AdminPage'
import { useAppStore } from '../stores/appStore'

const mocks = vi.hoisted(() => ({
  getMerchants: vi.fn(),
  approveMerchant: vi.fn(),
  rejectMerchant: vi.fn(),
  suspendMerchant: vi.fn(),
  getProducts: vi.fn(),
  getStats: vi.fn(),
  getAudit: vi.fn(),
  getSettlements: vi.fn(),
}))

vi.mock('../api/adminMerchant', () => ({
  getAdminMerchants: mocks.getMerchants,
  approveMerchant: mocks.approveMerchant,
  rejectMerchant: mocks.rejectMerchant,
  suspendMerchant: mocks.suspendMerchant,
  getAdminSettlements: mocks.getSettlements,
  batchSettle: vi.fn(),
  updateMerchantCommission: vi.fn(),
}))

vi.mock('../api/admin', () => ({
  getAdminProducts: mocks.getProducts,
  archiveAdminProduct: vi.fn(),
  restoreAdminProduct: vi.fn(),
  setAdminFakaCapacity: vi.fn(),
  unpublishAdminProduct: vi.fn(),
}))

vi.mock('../api/client', () => ({
  default: {
    get: (url: string) => {
      if (url === '/admin/stats') return Promise.resolve({ data: mocks.getStats() })
      if (url.startsWith('/admin/point-logs')) return Promise.resolve({ data: { items: [], total: 0 } })
      return Promise.resolve({ data: {} })
    },
  },
}))

vi.mock('../api/adminAudit', () => ({
  listAdminAudit: mocks.getAudit,
}))

describe('Phase 2C: High-frequency Operations, UI Primitives & Merchant Rejection Audit', () => {
  const sampleMerchant = {
    id: 88,
    userId: 188,
    name: '待审商户小店',
    status: 'pending' as const,
    commissionRate: 0.1,
    contactEmail: 'applicant@shop.test',
    contactPhone: '13800000000',
    description: '申请入驻数码专营店',
    createdAt: '2026-03-01T12:00:00.000Z',
    updatedAt: '2026-03-01T12:00:00.000Z',
  }

  const sampleProducts = [
    {
      id: 501,
      name: '自营数码礼品卡',
      status: 'active' as const,
      type: 'faka',
      price: 100,
      stock: 5,
      deliveryMode: 'faka' as const,
      merchantId: null,
      fakaCapacity: { capacityLimit: 50 },
      offers: [{ id: 1, name: '默认规格', isDefault: true, deliveryMode: 'faka' }],
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [] })

    mocks.getStats.mockReturnValue({
      users: 10,
      orders: 20,
      totalPoints: 100,
      todayOrders: 5,
      todayCheckins: 8,
      productCount: 1,
      availableInventory: 5,
    })

    mocks.getMerchants.mockResolvedValue({
      items: [sampleMerchant],
      total: 1,
      page: 1,
      pageSize: 20,
    })

    mocks.getProducts.mockResolvedValue({
      items: sampleProducts,
      total: sampleProducts.length,
      page: 1,
      pageSize: 20,
    })
    mocks.getAudit.mockResolvedValue({ items: [], total: 0 })
    mocks.getSettlements.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 })
  })

  it('AdminPanelHeader renders unified header with title and actions in Merchant panel', async () => {
    render(<AdminPage />)

    // Switch to merchants tab
    fireEvent.click(screen.getByTestId('admin-nav-item-merchants'))

    expect(await screen.findByRole('heading', { level: 2, name: '商家管理' })).toBeInTheDocument()
    expect(screen.getByText('审核新商户入驻申请与管理已有商户经营状态')).toBeInTheDocument()
    expect(screen.getByTestId('admin-merchant-status-filter')).toBeInTheDocument()
    expect(screen.getByTestId('admin-merchant-search-input')).toBeInTheDocument()
  })

  it('opens RejectMerchantDialog, enforces mandatory reason, accurately states audit record, and calls rejectMerchant API on confirm', async () => {
    mocks.rejectMerchant.mockResolvedValue({ ...sampleMerchant, status: 'rejected' })

    render(<AdminPage />)
    fireEvent.click(screen.getByTestId('admin-nav-item-merchants'))

    expect(await screen.findByText('待审商户小店')).toBeInTheDocument()

    // Click "拒绝" in table row
    const rejectActionLink = screen.getByRole('button', { name: '拒绝' })
    fireEvent.click(rejectActionLink)

    // Verify RejectMerchantDialog is displayed
    const dialog = await screen.findByTestId('reject-merchant-dialog')
    expect(dialog).toBeInTheDocument()
    expect(dialog).toHaveTextContent('待审商户小店')
    expect(dialog).toHaveTextContent('此信息将真实记录在操作审计中')

    // Confirm button is disabled initially
    const confirmBtn = screen.getByTestId('confirm-reject-merchant-btn')
    expect(confirmBtn).toBeDisabled()

    const reasonInput = screen.getByTestId('reject-merchant-reason-input')

    // Input too short (< 2 chars)
    fireEvent.change(reasonInput, { target: { value: 'a' } })
    expect(confirmBtn).toBeDisabled()

    // Input valid reason with surrounding spaces
    fireEvent.change(reasonInput, { target: { value: '  商户经营资质不齐，未上传有效执照  ' } })
    expect(confirmBtn).toBeEnabled()

    // Confirm rejection
    fireEvent.click(confirmBtn)

    await waitFor(() => {
      expect(mocks.rejectMerchant).toHaveBeenCalledWith(88, {
        reason: '商户经营资质不齐，未上传有效执照',
      })
    })

    // Dialog closes and toast appears
    await waitFor(() => {
      expect(screen.queryByTestId('reject-merchant-dialog')).not.toBeInTheDocument()
    })
    expect(useAppStore.getState().toasts.some((t) => t.message.includes('已拒绝入驻'))).toBe(true)
  })

  it('cancels rejection without calling rejectMerchant API', async () => {
    render(<AdminPage />)
    fireEvent.click(screen.getByTestId('admin-nav-item-merchants'))

    expect(await screen.findByText('待审商户小店')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    expect(await screen.findByTestId('reject-merchant-dialog')).toBeInTheDocument()

    // Click cancel button
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    await waitFor(() => {
      expect(screen.queryByTestId('reject-merchant-dialog')).not.toBeInTheDocument()
    })
    expect(mocks.rejectMerchant).not.toHaveBeenCalled()
  })

  it('slims down product row: secondary actions are moved into portal-mounted AdminActionMenu without duplication', async () => {
    render(<AdminPage />)
    fireEvent.click(screen.getByTestId('admin-nav-item-products'))

    expect(await screen.findByText('自营数码礼品卡')).toBeInTheDocument()

    // Primary action buttons remain flat in the row
    expect(screen.getByTestId('admin-product-unpublish-501')).toHaveTextContent('下架')
    expect(screen.getByTestId('admin-edit-product-501')).toHaveTextContent('编辑')
    expect(screen.getByTestId('admin-archive-product-501')).toHaveTextContent('归档')

    // Secondary actions are NOT rendered flat in the table row
    expect(screen.queryByTestId('admin-manage-offers-501')).not.toBeInTheDocument()
    expect(screen.queryByTestId('admin-faka-capacity-501')).not.toBeInTheDocument()
    expect(screen.queryByTestId('admin-faka-sync-501')).not.toBeInTheDocument()

    // AdminActionMenu trigger exists
    const menuTrigger = screen.getByTestId('admin-product-actions-501')
    expect(menuTrigger).toBeInTheDocument()

    // Open menu
    fireEvent.click(menuTrigger)
    const menu = screen.getByRole('menu')
    expect(menu).toBeInTheDocument()
    // Verify portal mounted to document.body
    expect(menu.parentElement).toBe(document.body)

    // Legacy testids are now accessible in the menu
    expect(screen.getByTestId('admin-manage-offers-501')).toHaveTextContent('规格管理')
    expect(screen.getByTestId('admin-faka-capacity-501')).toHaveTextContent('调整 Xboard 名额')
    expect(screen.getByTestId('admin-faka-sync-501')).toHaveTextContent('同步 Xboard')
  })
})
