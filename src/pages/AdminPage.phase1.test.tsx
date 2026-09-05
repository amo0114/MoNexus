import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import AdminPage from './AdminPage'
import { useAppStore } from '../stores/appStore'
import { getAdminMerchants, getAdminSettlements, batchSettle } from '../api/adminMerchant'
import api from '../api/client'

const mocks = vi.hoisted(() => ({
  getMerchants: vi.fn(),
  getSettlements: vi.fn(),
  batchSettle: vi.fn(),
  approveMerchant: vi.fn(),
  rejectMerchant: vi.fn(),
  suspendMerchant: vi.fn(),
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

vi.mock('../api/adminMerchant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/adminMerchant')>()
  return {
    ...actual,
    getAdminMerchants: mocks.getMerchants,
    getAdminSettlements: mocks.getSettlements,
    batchSettle: mocks.batchSettle,
    approveMerchant: mocks.approveMerchant,
    rejectMerchant: mocks.rejectMerchant,
    suspendMerchant: mocks.suspendMerchant,
  }
})

vi.mock('../api/client', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (url === '/admin/stats') {
        return Promise.resolve({
          data: { users: 10, orders: 20, totalPoints: 100 },
        })
      }
      if (url === '/admin/reports/offers') {
        return Promise.resolve({
          data: { items: [], total: 0 },
        })
      }
      return Promise.resolve({ data: [] })
    }),
  },
}))

describe('Phase 1: Admin Merchants & Settlements Contract and UX Governance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [] })
  })

  describe('API Client ListEnvelope Contract Strict Validation', () => {
    it('throws error when response does not conform to ListEnvelope contract', async () => {
      const { getAdminMerchants: actualGetMerchants, getAdminSettlements: actualGetSettlements } =
        await vi.importActual<typeof import('../api/adminMerchant')>('../api/adminMerchant')

      // Mock client returning bare array (contract regression)
      vi.mocked(api.get).mockResolvedValueOnce({ data: [{ id: 1, name: 'bare array' }] } as any)
      await expect(actualGetMerchants()).rejects.toThrow('无效的商家列表分页响应结构，缺少 ListEnvelope 契约字段')

      // Mock client returning object missing total
      vi.mocked(api.get).mockResolvedValueOnce({ data: { items: [], page: 1, pageSize: 20 } } as any)
      await expect(actualGetSettlements()).rejects.toThrow('无效的结算列表分页响应结构，缺少 ListEnvelope 契约字段')

      // Mock client returning negative total
      vi.mocked(api.get).mockResolvedValueOnce({ data: { items: [], total: -1, page: 1, pageSize: 20 } } as any)
      await expect(actualGetMerchants()).rejects.toThrow('无效的商家列表分页响应结构，缺少 ListEnvelope 契约字段')

      // Mock client returning page < 1
      vi.mocked(api.get).mockResolvedValueOnce({ data: { items: [], total: 0, page: 0, pageSize: 20 } } as any)
      await expect(actualGetSettlements()).rejects.toThrow('无效的结算列表分页响应结构，缺少 ListEnvelope 契约字段')

      // Mock client returning invalid pageSize (0 or > 100 or float)
      vi.mocked(api.get).mockResolvedValueOnce({ data: { items: [], total: 0, page: 1, pageSize: 101 } } as any)
      await expect(actualGetMerchants()).rejects.toThrow('无效的商家列表分页响应结构，缺少 ListEnvelope 契约字段')

      vi.mocked(api.get).mockResolvedValueOnce({ data: { items: [], total: 0, page: 1, pageSize: 20.5 } } as any)
      await expect(actualGetSettlements()).rejects.toThrow('无效的结算列表分页响应结构，缺少 ListEnvelope 契约字段')
    })
  })

  describe('Merchants Management: Draft vs Applied Filter & Stable Pagination', () => {
    it('preserves applied filters across pagination and only updates on explicit query/reset', async () => {
      mocks.getMerchants.mockResolvedValue({
        items: [
          { id: 1, name: 'Merchant Alpha', contactEmail: 'a@test.com', commissionRate: 0.1, status: 'active' },
        ],
        total: 45,
        page: 1,
        pageSize: 20,
      })

      render(<AdminPage />)
      expect(await screen.findByText('平台订单总数')).toBeInTheDocument()

      // Switch to merchants tab
      fireEvent.click(screen.getByRole('button', { name: '商家管理' }))
      expect(await screen.findByText('Merchant Alpha')).toBeInTheDocument()
      expect(mocks.getMerchants).toHaveBeenCalledWith({
        page: 1,
        pageSize: 20,
      })

      mocks.getMerchants.mockClear()

      // Type in draft search and select draft status (does NOT trigger request)
      const searchInput = screen.getByTestId('admin-merchant-search-input')
      const statusSelect = screen.getByTestId('admin-merchant-status-filter')

      fireEvent.change(searchInput, { target: { value: 'Beta' } })
      fireEvent.change(statusSelect, { target: { value: 'pending' } })
      expect(mocks.getMerchants).not.toHaveBeenCalled()

      // Click "查询" -> applies filter snapshot and fetches page 1
      fireEvent.click(screen.getByTestId('admin-merchant-search-btn'))
      expect(mocks.getMerchants).toHaveBeenCalledTimes(1)
      expect(mocks.getMerchants).toHaveBeenCalledWith({
        status: 'pending',
        q: 'Beta',
        page: 1,
        pageSize: 20,
      })

      mocks.getMerchants.mockClear()

      // Change draft input without clicking search
      fireEvent.change(searchInput, { target: { value: 'Uncommitted Draft' } })

      // Paginating to page 2: MUST carry applied filter ('Beta' + 'pending'), NOT uncommitted draft!
      fireEvent.click(screen.getByRole('button', { name: '下一页' }))
      expect(mocks.getMerchants).toHaveBeenCalledTimes(1)
      expect(mocks.getMerchants).toHaveBeenCalledWith({
        status: 'pending',
        q: 'Beta',
        page: 2,
        pageSize: 20,
      })

      mocks.getMerchants.mockClear()

      // Click "重置" -> clears drafts and fetches page 1 with clean filter
      fireEvent.click(screen.getByTestId('admin-merchant-reset-btn'))
      expect(mocks.getMerchants).toHaveBeenCalledTimes(1)
      expect(mocks.getMerchants).toHaveBeenCalledWith({
        page: 1,
        pageSize: 20,
      })
      expect(searchInput).toHaveValue('')
      expect(statusSelect).toHaveValue('')
    })

    it('auto-shrinks to lower page when action causes last page to be empty', async () => {
      // Initially page 2 with total = 21 (totalPages = 2)
      mocks.getMerchants.mockResolvedValueOnce({
        items: [{ id: 21, name: 'Sole Item on Page 2', status: 'pending', commissionRate: 0.1 }],
        total: 21,
        page: 2,
        pageSize: 20,
      })
      mocks.approveMerchant.mockResolvedValueOnce({ id: 21, status: 'active' })

      render(<AdminPage />)
      fireEvent.click(screen.getByRole('button', { name: '商家管理' }))
      expect(await screen.findByText('Sole Item on Page 2')).toBeInTheDocument()

      // Approve item on page 2: refresh returns total = 20 (totalPages = 1)
      mocks.getMerchants.mockResolvedValueOnce({
        items: [],
        total: 20,
        page: 2,
        pageSize: 20,
      })
      // Subsequent clamped request to page 1
      mocks.getMerchants.mockResolvedValueOnce({
        items: [{ id: 1, name: 'Item on Page 1', status: 'active', commissionRate: 0.1 }],
        total: 20,
        page: 1,
        pageSize: 20,
      })

      fireEvent.click(screen.getByRole('button', { name: '通过' }))
      expect(await screen.findByText('Item on Page 1')).toBeInTheDocument()
      expect(screen.getByText('共 20 条记录，第 1 / 1 页')).toBeInTheDocument()
    })
  })

  describe('Settlements Management: Multi-page Selection & Header Checkbox', () => {
    it('maintains cross-page selections, limits header checkbox to current page pending, and clears on filter change', async () => {
      // Page 1 mock: 2 pending items
      const page1Items = [
        { id: 101, orderId: 1001, merchantId: 1, status: 'pending', settlementAmount: 120, commissionAmount: 10, commissionRate: 0.1, orderAmount: 130, createdAt: '2026-09-01T00:00:00Z', payable: true, blockReason: null },
        { id: 102, orderId: 1002, merchantId: 1, status: 'pending', settlementAmount: 180, commissionAmount: 20, commissionRate: 0.1, orderAmount: 200, createdAt: '2026-09-01T01:00:00Z', payable: true, blockReason: null },
      ]
      // Page 2 mock: 1 pending, 1 settled
      const page2Items = [
        { id: 201, orderId: 2001, merchantId: 2, status: 'pending', settlementAmount: 300, commissionAmount: 30, commissionRate: 0.1, orderAmount: 330, createdAt: '2026-09-02T00:00:00Z', payable: true, blockReason: null },
        { id: 202, orderId: 2002, merchantId: 2, status: 'settled', settlementAmount: 400, commissionAmount: 40, commissionRate: 0.1, orderAmount: 440, createdAt: '2026-09-02T01:00:00Z', payable: true, blockReason: null },
      ]

      mocks.getSettlements.mockImplementation(({ page }) => {
        if (page === 2) {
          return Promise.resolve({ items: page2Items, total: 40, page: 2, pageSize: 20 })
        }
        return Promise.resolve({ items: page1Items, total: 40, page: 1, pageSize: 20 })
      })

      mocks.batchSettle.mockResolvedValue({ settled: 2, creditedTotal: 420 })

      render(<AdminPage />)
      expect(await screen.findByText('平台订单总数')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: '结算管理' }))
      expect(await screen.findByText('ORD-1001')).toBeInTheDocument()

      const batchSettleBtn = screen.getByTestId('admin-batch-settle')
      expect(batchSettleBtn).toHaveTextContent('批量结算 (0)')
      expect(batchSettleBtn).toBeDisabled()

      // Select item 101 on page 1
      const select101 = screen.getByLabelText('选择订单 ORD-1001')
      fireEvent.click(select101)
      expect(batchSettleBtn).toHaveTextContent('批量结算 (1)')

      // Flip to page 2: selection remains preserved!
      fireEvent.click(screen.getByRole('button', { name: '下一页' }))
      expect(await screen.findByText('ORD-2001')).toBeInTheDocument()
      expect(batchSettleBtn).toHaveTextContent('批量结算 (1)')

      // Header select on page 2: only selects page 2 pending item (201), non-pending (202) is ignored
      const headerSelect = screen.getByLabelText('选择当前页待结算订单')
      fireEvent.click(headerSelect)
      expect(batchSettleBtn).toHaveTextContent('批量结算 (2)') // 101 from p1, 201 from p2

      // Click batch settle
      fireEvent.click(batchSettleBtn)

      // Confirm dialog must sum the cross-page selection: 120 (101) + 300 (201) = 420
      expect(await screen.findByTestId('admin-batch-settle-confirm-dialog')).toBeInTheDocument()
      expect(screen.getByText(/420 积分/)).toBeInTheDocument()
      expect(screen.getByText(/2 笔待结算订单/)).toBeInTheDocument()

      // Confirm batch settlement
      fireEvent.click(screen.getByTestId('confirm-dialog-confirm'))
      await waitFor(() => {
        expect(mocks.batchSettle).toHaveBeenCalledWith({ settlementIds: [101, 201] })
      })

      // After settlement: selection is cleared
      expect(batchSettleBtn).toHaveTextContent('批量结算 (0)')

      // Test filter change clearing selection: select item 201, change filter -> selection cleared
      const select201 = screen.getByLabelText('选择订单 ORD-2001')
      fireEvent.click(select201)
      expect(batchSettleBtn).toHaveTextContent('批量结算 (1)')

      const statusFilter = screen.getByTestId('admin-settlement-status-filter')
      fireEvent.change(statusFilter, { target: { value: 'holding' } })
      expect(batchSettleBtn).toHaveTextContent('批量结算 (0)')
    })
  })
})
