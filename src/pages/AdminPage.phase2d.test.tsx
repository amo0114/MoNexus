import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminPage from './AdminPage'
import { useAppStore } from '../stores/appStore'

const mocks = vi.hoisted(() => ({
  getOrders: vi.fn(),
  getOrderDetail: vi.fn(),
  resolveAdminOrder: vi.fn(),
  getStats: vi.fn(),
}))

vi.mock('../api/admin', () => ({
  getAdminOrders: mocks.getOrders,
  getAdminOrderDetail: mocks.getOrderDetail,
  resolveAdminOrder: mocks.resolveAdminOrder,
  getAdminProducts: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
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

describe('Phase 2D: Order Experience, Detail Modal & Date Boundary Governance', () => {
  const sampleOrders = [
    {
      id: 801,
      status: 'delivered',
      price: 200,
      createdAt: '2026-03-02T14:30:00.000Z',
      user: { id: 45, email: 'buyer45@test.local' },
      merchant: { id: 8, name: '极客数码专营' },
      product: { name: '自动化开通会员' },
      delivery: {
        status: 'delivered',
        expiresAt: '2026-04-02T14:30:00.000Z',
        expired: false,
      },
    },
    {
      id: 802,
      status: 'disputed',
      price: 500,
      createdAt: '2026-03-04T09:15:00.000Z',
      user: { id: 46, email: 'buyer46@test.local' },
      merchant: { id: 9, name: '海外充值小铺' },
      product: { name: '游戏点卡充值' },
      delivery: {
        status: 'pending',
        expiresAt: null,
      },
    },
  ]

  const sampleDetail801 = {
    ...sampleOrders[0],
    updatedAt: '2026-03-02T14:35:00.000Z',
    holdingPoints: 0,
    deliveryModeSnapshot: 'instant_inventory',
    delivery: {
      id: 991,
      content: 'SECRET-KEY-VIP-88888',
      status: 'delivered',
      expiresAt: '2026-04-02T14:30:00.000Z',
      expired: false,
    },
    purchaseFormAnswers: {
      '充值账号': 'vip_user_45',
      '服务节点': '香港专线',
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({
      toasts: [],
      registry: {
        orderStatuses: [
          { value: 'pending', label: '待支付' },
          { value: 'delivered', label: '已交付' },
          { value: 'disputed', label: '争议中' },
        ],
      } as any,
    })

    mocks.getStats.mockReturnValue({
      users: 10,
      orders: 2,
      totalPoints: 100,
    })

    mocks.getOrders.mockResolvedValue({
      items: sampleOrders,
      total: 2,
      page: 1,
      pageSize: 20,
    })

    mocks.getOrderDetail.mockResolvedValue(sampleDetail801)
  })

  it('renders AdminPanelHeader with date range filters and queries orders with fromDate/toDate', async () => {
    render(<AdminPage />)
    fireEvent.click(screen.getByTestId('admin-nav-item-orders'))

    expect(await screen.findByRole('heading', { level: 2, name: '订单记录' })).toBeInTheDocument()
    expect(screen.getByText('全平台订单交易明细、状态跟踪与争议仲裁')).toBeInTheDocument()

    const searchInput = screen.getByTestId('admin-order-search')
    const statusSelect = screen.getByTestId('admin-order-status-filter')
    const fromInput = screen.getByTestId('admin-order-from-date')
    const toInput = screen.getByTestId('admin-order-to-date')
    const searchBtn = screen.getByTestId('admin-order-search-btn')

    // Input search, status, and valid date range
    fireEvent.change(searchInput, { target: { value: 'buyer45' } })
    fireEvent.change(statusSelect, { target: { value: 'delivered' } })
    fireEvent.change(fromInput, { target: { value: '2026-03-01' } })
    fireEvent.change(toInput, { target: { value: '2026-03-05' } })

    fireEvent.click(searchBtn)

    await waitFor(() => {
      expect(mocks.getOrders).toHaveBeenCalledWith({
        page: 1,
        pageSize: 20,
        q: 'buyer45',
        status: 'delivered',
        fromDate: '2026-03-01',
        toDate: '2026-03-05',
      })
    })
  })

  it('rejects query when fromDate is later than toDate and shows toast error', async () => {
    render(<AdminPage />)
    fireEvent.click(screen.getByTestId('admin-nav-item-orders'))
    expect(await screen.findByRole('heading', { level: 2, name: '订单记录' })).toBeInTheDocument()

    const fromInput = screen.getByTestId('admin-order-from-date')
    const toInput = screen.getByTestId('admin-order-to-date')
    const searchBtn = screen.getByTestId('admin-order-search-btn')

    // Inverted range
    fireEvent.change(fromInput, { target: { value: '2026-03-10' } })
    fireEvent.change(toInput, { target: { value: '2026-03-02' } })

    const callsBefore = mocks.getOrders.mock.calls.length
    fireEvent.click(searchBtn)

    expect(mocks.getOrders.mock.calls.length).toBe(callsBefore)
    expect(useAppStore.getState().toasts.some((t) => t.message.includes('起始日期不能晚于结束日期'))).toBe(true)
  })

  it('resets all filters including date range on reset button click', async () => {
    render(<AdminPage />)
    fireEvent.click(screen.getByTestId('admin-nav-item-orders'))
    expect(await screen.findByRole('heading', { level: 2, name: '订单记录' })).toBeInTheDocument()

    const searchInput = screen.getByTestId('admin-order-search')
    const fromInput = screen.getByTestId('admin-order-from-date')
    const toInput = screen.getByTestId('admin-order-to-date')
    const resetBtn = screen.getByTestId('admin-order-reset-btn')

    fireEvent.change(searchInput, { target: { value: 'test' } })
    fireEvent.change(fromInput, { target: { value: '2026-03-01' } })
    fireEvent.change(toInput, { target: { value: '2026-03-05' } })

    fireEvent.click(resetBtn)

    await waitFor(() => {
      expect(mocks.getOrders).toHaveBeenCalledWith({
        page: 1,
        pageSize: 20,
        q: undefined,
        status: undefined,
        fromDate: undefined,
        toDate: undefined,
      })
    })

    expect(searchInput).toHaveValue('')
    expect(fromInput).toHaveValue('')
    expect(toInput).toHaveValue('')
  })

  it('opens order detail dialog, shows sensitive compliance boundary notice, delivery credentials, and form answers', async () => {
    render(<AdminPage />)
    fireEvent.click(screen.getByTestId('admin-nav-item-orders'))
    expect(await screen.findByText('ORD-801')).toBeInTheDocument()

    // Click "详情" button on order 801
    const detailBtn = screen.getByTestId('admin-order-detail-801')
    fireEvent.click(detailBtn)

    await waitFor(() => {
      expect(mocks.getOrderDetail).toHaveBeenCalledWith(801)
    })

    // Verify dialog and sensitive compliance banner
    const dialog = await screen.findByTestId('admin-order-detail-dialog')
    expect(dialog).toBeInTheDocument()

    const notice = screen.getByTestId('admin-order-sensitive-notice')
    expect(notice).toHaveTextContent('【敏感信息合规边界】')
    expect(notice).toHaveTextContent('本页面向管理人员如实展示买家真实交付凭据及预留表单')

    // Verify delivery content and purchase form
    expect(screen.getByTestId('admin-order-delivery-content')).toHaveTextContent('SECRET-KEY-VIP-88888')
    const formAnswers = screen.getByTestId('admin-order-form-answers')
    expect(formAnswers).toHaveTextContent('充值账号')
    expect(formAnswers).toHaveTextContent('vip_user_45')

    // Close dialog
    fireEvent.click(screen.getByTestId('admin-order-detail-close-btn'))
    await waitFor(() => {
      expect(screen.queryByTestId('admin-order-detail-dialog')).not.toBeInTheDocument()
    })
  })

  it('has accessible labels on all filter controls', async () => {
    render(<AdminPage />)
    fireEvent.click(screen.getByTestId('admin-nav-item-orders'))
    expect(await screen.findByRole('heading', { level: 2, name: '订单记录' })).toBeInTheDocument()

    expect(screen.getByLabelText('搜索买家邮箱或订单号')).toBeInTheDocument()
    expect(screen.getByLabelText('筛选订单状态')).toBeInTheDocument()
    expect(screen.getByLabelText('起始日期')).toBeInTheDocument()
    expect(screen.getByLabelText('结束日期')).toBeInTheDocument()
  })

  it('protects against out-of-order responses for order list', async () => {
    render(<AdminPage />)
    fireEvent.click(screen.getByTestId('admin-nav-item-orders'))
    expect(await screen.findByText('ORD-801')).toBeInTheDocument()

    let resolveFirst!: (val: any) => void
    let resolveSecond!: (val: any) => void

    const p1 = new Promise((res) => {
      resolveFirst = res
    })
    const p2 = new Promise((res) => {
      resolveSecond = res
    })

    mocks.getOrders.mockReturnValueOnce(p1).mockReturnValueOnce(p2)

    const searchInput = screen.getByTestId('admin-order-search')
    const searchBtn = screen.getByTestId('admin-order-search-btn')

    // Trigger request 1
    fireEvent.change(searchInput, { target: { value: 'first' } })
    fireEvent.click(searchBtn)

    // Trigger request 2
    fireEvent.change(searchInput, { target: { value: 'second' } })
    fireEvent.click(searchBtn)

    // Resolve request 2 first with ORD-802 only
    resolveSecond({
      items: [sampleOrders[1]],
      total: 1,
      page: 1,
      pageSize: 20,
    })

    expect(await screen.findByText('ORD-802')).toBeInTheDocument()
    expect(screen.queryByText('ORD-801')).not.toBeInTheDocument()

    // Now resolve request 1 late with ORD-801
    resolveFirst({
      items: [sampleOrders[0]],
      total: 1,
      page: 1,
      pageSize: 20,
    })

    // UI must NOT roll back to request 1's ORD-801
    expect(screen.queryByText('ORD-801')).not.toBeInTheDocument()
    expect(screen.getByText('ORD-802')).toBeInTheDocument()
  })

  it('protects against out-of-order responses for order detail between orders A and B', async () => {
    render(<AdminPage />)
    fireEvent.click(screen.getByTestId('admin-nav-item-orders'))
    expect(await screen.findByText('ORD-801')).toBeInTheDocument()

    let resolveDetail801!: (val: any) => void
    let resolveDetail802!: (val: any) => void

    const p801 = new Promise((res) => {
      resolveDetail801 = res
    })
    const p802 = new Promise((res) => {
      resolveDetail802 = res
    })

    mocks.getOrderDetail.mockReturnValueOnce(p801).mockReturnValueOnce(p802)

    // 1. Click detail for Order 801
    fireEvent.click(screen.getByTestId('admin-order-detail-801'))

    // 2. Click detail for Order 802
    fireEvent.click(screen.getByTestId('admin-order-detail-802'))

    // 3. Resolve Order 802 first
    resolveDetail802({
      ...sampleOrders[1],
      delivery: {
        id: 992,
        content: 'SECRET-802-NEWEST',
        status: 'pending',
      },
    })

    expect(await screen.findByRole('heading', { level: 2, name: /ORD-802/ })).toBeInTheDocument()
    expect(screen.getByTestId('admin-order-delivery-content')).toHaveTextContent('SECRET-802-NEWEST')

    // 4. Resolve Order 801 late
    resolveDetail801(sampleDetail801)

    // 5. Must NOT overwrite with Order 801
    expect(screen.getByRole('heading', { level: 2, name: /ORD-802/ })).toBeInTheDocument()
    expect(screen.getByTestId('admin-order-delivery-content')).toHaveTextContent('SECRET-802-NEWEST')
    expect(screen.queryByText('SECRET-KEY-VIP-88888')).not.toBeInTheDocument()
  })

  it('discards late order detail response after closing dialog', async () => {
    render(<AdminPage />)
    fireEvent.click(screen.getByTestId('admin-nav-item-orders'))
    expect(await screen.findByText('ORD-801')).toBeInTheDocument()

    let resolveDetail!: (val: any) => void
    const p = new Promise((res) => {
      resolveDetail = res
    })
    mocks.getOrderDetail.mockReturnValueOnce(p)

    // Click detail for 801
    fireEvent.click(screen.getByTestId('admin-order-detail-801'))
    expect(screen.getByTestId('admin-order-detail-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('admin-order-detail-loading')).toBeInTheDocument()

    // Close dialog before response arrives
    fireEvent.click(screen.getByLabelText('关闭'))
    await waitFor(() => {
      expect(screen.queryByTestId('admin-order-detail-dialog')).not.toBeInTheDocument()
    })

    // Now resolve late
    resolveDetail(sampleDetail801)

    // Dialog must remain closed
    expect(screen.queryByTestId('admin-order-detail-dialog')).not.toBeInTheDocument()
  })

  it('displays error state on detail failure and recovers on retry', async () => {
    mocks.getOrderDetail
      .mockRejectedValueOnce({
        response: { data: { error: { message: '网络请求异常' } } },
      })
      .mockResolvedValueOnce(sampleDetail801)

    render(<AdminPage />)
    fireEvent.click(screen.getByTestId('admin-nav-item-orders'))
    expect(await screen.findByText('ORD-801')).toBeInTheDocument()

    // Click detail for 801
    fireEvent.click(screen.getByTestId('admin-order-detail-801'))

    // Verify error state
    expect(await screen.findByTestId('admin-order-detail-error')).toBeInTheDocument()
    expect(screen.getByText('加载订单详情失败')).toBeInTheDocument()
    expect(screen.getByText('网络请求异常')).toBeInTheDocument()

    // Click retry
    const retryBtn = screen.getByTestId('admin-order-detail-retry-btn')
    fireEvent.click(retryBtn)

    // Verify successful recovery
    expect(await screen.findByTestId('admin-order-sensitive-notice')).toBeInTheDocument()
    expect(screen.getByTestId('admin-order-delivery-content')).toHaveTextContent('SECRET-KEY-VIP-88888')
  })
})
