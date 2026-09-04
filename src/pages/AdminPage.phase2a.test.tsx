import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminPage from './AdminPage'
import { useAppStore } from '../stores/appStore'

const mocks = vi.hoisted(() => ({
  getMerchants: vi.fn(),
  getSettlements: vi.fn(),
  getProducts: vi.fn(),
  listAudit: vi.fn(),
}))

vi.mock('../api/client', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (url === '/admin/stats') {
        return Promise.resolve({ data: { users: 10, orders: 20, totalPoints: 100 } })
      }
      if (url === '/admin/reports/offers') {
        return Promise.resolve({ data: { items: [] } })
      }
      if (url === '/admin/logs') {
        return Promise.resolve({ data: [] })
      }
      return Promise.resolve({ data: {} })
    }),
  },
}))

vi.mock('../api/adminMerchant', () => ({
  getAdminMerchants: (...args: any[]) => mocks.getMerchants(...args),
  getAdminSettlements: (...args: any[]) => mocks.getSettlements(...args),
  approveMerchant: vi.fn(),
  rejectMerchant: vi.fn(),
  suspendMerchant: vi.fn(),
  batchSettle: vi.fn(),
}))

vi.mock('../api/admin', async () => {
  const actual = await vi.importActual<typeof import('../api/admin')>('../api/admin')
  return {
    ...actual,
    getAdminProducts: (...args: any[]) => mocks.getProducts(...args),
  }
})

vi.mock('../api/adminAudit', () => ({
  listAdminAudit: (...args: any[]) => mocks.listAudit(...args),
}))

vi.mock('../components/admin/AdminUserTable', () => ({
  default: function MockAdminUserTable() {
    return <div data-testid="users-panel-marker">AdminUserTable</div>
  },
}))

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: any) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('Phase 2A: AdminPage Activation-Aware Keep-Alive & Decoupling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [], islandNotice: null })

    mocks.getMerchants.mockResolvedValue({
      items: [
        { id: 1, name: 'Merchant Alpha 1', contactEmail: 'a@test.com', commissionRate: 0.1, status: 'active' },
      ],
      total: 45,
      page: 1,
      pageSize: 20,
    })

    mocks.getSettlements.mockResolvedValue({
      items: [
        {
          id: 101,
          merchantId: 1,
          orderId: 1001,
          orderAmount: 100,
          commissionRate: '0.1000',
          commissionAmount: 10,
          settlementAmount: 90,
          status: 'pending',
          createdAt: new Date().toISOString(),
          merchant: { id: 1, name: 'Alpha Store' },
          payable: true,
          blockReason: null,
        },
      ],
      total: 25,
      page: 1,
      pageSize: 20,
    })

    mocks.listAudit.mockResolvedValue({
      items: [
        {
          id: 1,
          adminId: 1,
          adminEmail: 'admin@test.com',
          action: 'test_action',
          targetType: 'user',
          targetId: '10',
          metadata: {},
          createdAt: new Date().toISOString(),
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    })

    mocks.getProducts.mockResolvedValue([
      {
        id: 11,
        name: 'Test Product',
        status: 'active',
        price: 100,
        type: '节点',
      },
    ])
  })

  it('preserves merchant search input, applied filters, and actual page 2 across tab switching', async () => {
    render(<AdminPage />)
    expect(await screen.findByText('平台订单总数')).toBeInTheDocument()

    // 1. Switch to merchants tab
    fireEvent.click(screen.getByRole('button', { name: '商家管理' }))
    expect(await screen.findByText('Merchant Alpha 1')).toBeInTheDocument()

    // 2. Set draft search and status filter, then query
    fireEvent.change(screen.getByTestId('admin-merchant-search-input'), { target: { value: 'Alpha' } })
    fireEvent.change(screen.getByTestId('admin-merchant-status-filter'), { target: { value: 'active' } })
    fireEvent.click(screen.getByTestId('admin-merchant-search-btn'))

    await waitFor(() => {
      expect(mocks.getMerchants).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: 'Alpha', status: 'active', page: 1 }),
      )
    })

    // 3. Actually navigate to Page 2
    mocks.getMerchants.mockResolvedValueOnce({
      items: [
        { id: 21, name: 'Merchant Alpha 21', contactEmail: 'a21@test.com', commissionRate: 0.1, status: 'active' },
      ],
      total: 45,
      page: 2,
      pageSize: 20,
    })
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(await screen.findByText('Merchant Alpha 21')).toBeInTheDocument()
    expect(screen.getByTestId('admin-merchants-pagination')).toHaveTextContent('2')

    // 4. Switch away to dashboard
    fireEvent.click(screen.getByRole('button', { name: '数据仪表盘' }))
    expect(await screen.findByText('平台订单总数')).toBeInTheDocument()

    // Mock page 2 response for when tab is reactivated
    mocks.getMerchants.mockResolvedValueOnce({
      items: [
        { id: 21, name: 'Merchant Alpha 21', contactEmail: 'a21@test.com', commissionRate: 0.1, status: 'active' },
      ],
      total: 45,
      page: 2,
      pageSize: 20,
    })

    // 5. Switch back to merchants
    fireEvent.click(screen.getByRole('button', { name: '商家管理' }))

    // Verify reactivation reloaded using page 2 and applied filters
    await waitFor(() => {
      expect(mocks.getMerchants).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: 'Alpha', status: 'active', page: 2 }),
      )
    })

    // Verify draft input, select value, and page number remain intact
    expect(screen.getByTestId('admin-merchant-search-input')).toHaveValue('Alpha')
    expect(screen.getByTestId('admin-merchant-status-filter')).toHaveValue('active')
    expect(screen.getByTestId('admin-merchants-pagination')).toHaveTextContent('2')
    expect(screen.getByText('Merchant Alpha 21')).toBeInTheDocument()
  })

  it('preserves settlement cross-page selections and pending totals across tab switching', async () => {
    render(<AdminPage />)
    expect(await screen.findByText('平台订单总数')).toBeInTheDocument()

    // 1. Switch to settlements tab (page 1)
    fireEvent.click(screen.getByRole('button', { name: '结算管理' }))
    expect(await screen.findByText('ORD-1001')).toBeInTheDocument()

    // Check page 1 settlement
    fireEvent.click(screen.getByLabelText('选择订单 ORD-1001'))
    expect(screen.getByTestId('admin-batch-settle')).toHaveTextContent('批量结算 (1)')

    // 2. Navigate to page 2 and select an item there
    mocks.getSettlements.mockResolvedValueOnce({
      items: [
        {
          id: 121,
          merchantId: 1,
          orderId: 1021,
          orderAmount: 300,
          commissionRate: '0.1000',
          commissionAmount: 30,
          settlementAmount: 270,
          status: 'pending',
          createdAt: new Date().toISOString(),
          merchant: { id: 1, name: 'Alpha Store' },
          payable: true,
          blockReason: null,
        },
      ],
      total: 25,
      page: 2,
      pageSize: 20,
    })
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(await screen.findByText('ORD-1021')).toBeInTheDocument()

    // Check page 2 settlement
    fireEvent.click(screen.getByLabelText('选择订单 ORD-1021'))
    // Now across page 1 and page 2, 2 items are selected
    expect(screen.getByTestId('admin-batch-settle')).toHaveTextContent('批量结算 (2)')

    // 3. Switch away to users tab (unrelated stateless component)
    fireEvent.click(screen.getByRole('button', { name: '用户管理' }))
    expect(await screen.findByTestId('users-panel-marker')).toBeInTheDocument()

    // Mock page 2 response for reactivation
    mocks.getSettlements.mockResolvedValueOnce({
      items: [
        {
          id: 121,
          merchantId: 1,
          orderId: 1021,
          orderAmount: 300,
          commissionRate: '0.1000',
          commissionAmount: 30,
          settlementAmount: 270,
          status: 'pending',
          createdAt: new Date().toISOString(),
          merchant: { id: 1, name: 'Alpha Store' },
          payable: true,
          blockReason: null,
        },
      ],
      total: 25,
      page: 2,
      pageSize: 20,
    })

    // 4. Switch back to settlements
    fireEvent.click(screen.getByRole('button', { name: '结算管理' }))
    expect(await screen.findByText('ORD-1021')).toBeInTheDocument()

    // Cross-page selection count is still 2 and current page checkbox remains checked
    expect(screen.getByTestId('admin-batch-settle')).toHaveTextContent('批量结算 (2)')
    expect(screen.getByLabelText('选择订单 ORD-1021')).toBeChecked()
  })

  it('preserves audit and product filters and carries them in reactivation requests', async () => {
    render(<AdminPage />)
    expect(await screen.findByText('平台订单总数')).toBeInTheDocument()

    // 1. Go to audit tab and apply filter
    fireEvent.click(screen.getByRole('button', { name: '操作审计' }))
    expect(await screen.findByPlaceholderText('管理员ID')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('管理员ID'), { target: { value: '88' } })
    fireEvent.change(screen.getByPlaceholderText('操作动作 (如: ban)'), { target: { value: 'ban' } })
    fireEvent.click(screen.getByRole('button', { name: '查询' }))

    await waitFor(() => {
      expect(mocks.listAudit).toHaveBeenLastCalledWith(
        expect.objectContaining({ adminId: 88, action: 'ban', page: 1 }),
      )
    })

    // 2. Go to products tab and change filter to 'only'
    fireEvent.click(screen.getByRole('button', { name: '商品与库存' }))
    expect(await screen.findByTestId('admin-products-archived-filter')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('admin-products-archived-filter'), { target: { value: 'only' } })

    await waitFor(() => {
      expect(mocks.getProducts).toHaveBeenLastCalledWith({ archived: 'only' })
    })

    // 3. Go back to audit tab: verify input preserved and request carried adminId=88, action='ban'
    fireEvent.click(screen.getByRole('button', { name: '操作审计' }))
    expect(screen.getByPlaceholderText('管理员ID')).toHaveValue('88')
    expect(screen.getByPlaceholderText('操作动作 (如: ban)')).toHaveValue('ban')
    await waitFor(() => {
      expect(mocks.listAudit).toHaveBeenLastCalledWith(
        expect.objectContaining({ adminId: 88, action: 'ban' }),
      )
    })

    // 4. Go back to products tab: verify select preserved and request carried archived='only'
    fireEvent.click(screen.getByRole('button', { name: '商品与库存' }))
    expect(screen.getByTestId('admin-products-archived-filter')).toHaveValue('only')
    await waitFor(() => {
      expect(mocks.getProducts).toHaveBeenLastCalledWith({ archived: 'only' })
    })
  })

  it('drops late in-flight responses from inactive panel: deferred reject does not show toast and deferred resolve does not alter UI', async () => {
    render(<AdminPage />)
    expect(await screen.findByText('平台订单总数')).toBeInTheDocument()

    // Switch to merchants tab
    fireEvent.click(screen.getByRole('button', { name: '商家管理' }))
    expect(await screen.findByText('Merchant Alpha 1')).toBeInTheDocument()

    // ---- Part A: Late Deferred Reject ----
    const deferredReject = createDeferred<any>()
    mocks.getMerchants.mockReturnValueOnce(deferredReject.promise)

    // Trigger search
    fireEvent.click(screen.getByTestId('admin-merchant-search-btn'))
    // Verify request is actually in-flight
    expect(mocks.getMerchants).toHaveBeenCalledTimes(2)

    // Immediately switch to dashboard before deferred rejects
    fireEvent.click(screen.getByRole('button', { name: '数据仪表盘' }))
    expect(await screen.findByText('平台订单总数')).toBeInTheDocument()

    // Settle the in-flight promise with rejection
    deferredReject.reject(new Error('late merchant error that must be ignored'))

    // Allow microtasks to complete
    await new Promise((r) => setTimeout(r, 50))

    // Assert no toast was shown
    const toasts = useAppStore.getState().toasts
    expect(toasts.some((t) => t.message.includes('late merchant error'))).toBe(false)

    // ---- Part B: Late Deferred Resolve ----
    // Switch to audit tab
    fireEvent.click(screen.getByRole('button', { name: '操作审计' }))
    expect(await screen.findByText('test_action')).toBeInTheDocument()

    const deferredResolve = createDeferred<any>()
    mocks.listAudit.mockReturnValueOnce(deferredResolve.promise)

    // Trigger search in audit
    fireEvent.click(screen.getByRole('button', { name: '查询' }))
    expect(mocks.listAudit).toHaveBeenCalledTimes(2)

    // Switch away before deferred resolves
    fireEvent.click(screen.getByRole('button', { name: '数据仪表盘' }))
    expect(await screen.findByText('平台订单总数')).toBeInTheDocument()

    // Resolve deferred with new action that should NOT update the UI
    deferredResolve.resolve({
      items: [
        {
          id: 999,
          adminId: 9,
          adminEmail: 'stale@test.com',
          action: 'STALE_ACTION_NEVER_SHOW',
          targetType: 'user',
          targetId: '99',
          metadata: {},
          createdAt: new Date().toISOString(),
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    })

    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByText('STALE_ACTION_NEVER_SHOW')).not.toBeInTheDocument()
  })

  it('displays error toast and banner on product list refresh failure', async () => {
    mocks.getProducts.mockRejectedValue(new Error('网络异常'))

    render(<AdminPage />)
    expect(await screen.findByText('平台订单总数')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '商品与库存' }))

    // Expect the refresh error banner
    expect(await screen.findByTestId('admin-products-refresh-error')).toHaveTextContent('不是最新状态')

    // Expect the toast to be emitted
    await waitFor(() => {
      const toasts = useAppStore.getState().toasts
      expect(toasts.some((t) => t.message.includes('网络异常') || t.message.includes('加载失败'))).toBe(true)
    })
  })
})
