import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminOrderTable from './AdminOrderTable'
import type { AdminOrderDetail, AdminOrderItem } from '../../api/admin'
import { useAppStore } from '../../stores/appStore'

const apiMocks = vi.hoisted(() => ({
  getAdminOrders: vi.fn(),
  getAdminOrderDetail: vi.fn(),
  resolveAdminOrder: vi.fn(),
  startAdminPlatformFulfillment: vi.fn(),
  postAdminPlatformProgress: vi.fn(),
  deliverAdminPlatformOrder: vi.fn(),
  rejectAdminPlatformOrder: vi.fn(),
}))

vi.mock('../../api/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/admin')>()
  return {
    ...actual,
    getAdminOrders: apiMocks.getAdminOrders,
    getAdminOrderDetail: apiMocks.getAdminOrderDetail,
    resolveAdminOrder: apiMocks.resolveAdminOrder,
    startAdminPlatformFulfillment: apiMocks.startAdminPlatformFulfillment,
    postAdminPlatformProgress: apiMocks.postAdminPlatformProgress,
    deliverAdminPlatformOrder: apiMocks.deliverAdminPlatformOrder,
    rejectAdminPlatformOrder: apiMocks.rejectAdminPlatformOrder,
  }
})

const platformPending: AdminOrderItem = {
  id: 501,
  status: 'pending',
  price: 99,
  createdAt: '2026-04-02T10:00:00.000Z',
  merchantId: null,
  merchant: null,
  user: { id: 8, email: 'buyer8@test.local' },
  product: { name: '人工咨询' },
}

const merchantPending: AdminOrderItem = {
  id: 502,
  status: 'pending',
  price: 80,
  createdAt: '2026-04-02T11:00:00.000Z',
  merchantId: 12,
  merchant: { id: 12, name: '专营卡券商户' },
  user: { id: 9, email: 'buyer9@test.local' },
  product: { name: '商家人工单' },
}

const platformDetail: AdminOrderDetail = {
  ...platformPending,
  deliveryModeSnapshot: 'manual_service',
  product: { id: 21, name: '人工咨询', deliveryMode: 'manual_service' },
  delivery: { status: 'pending' },
}

const merchantDetail: AdminOrderDetail = {
  ...merchantPending,
  deliveryModeSnapshot: 'manual_service',
  product: { id: 22, name: '商家人工单', deliveryMode: 'manual_service' },
  delivery: { status: 'pending' },
}

describe('AdminOrderTable platform fulfillment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({
      toasts: [],
      registry: {
        orderStatuses: [
          { value: 'pending', label: '待处理' },
          { value: 'processing', label: '履约中' },
        ],
      } as never,
    })
    apiMocks.getAdminOrders.mockResolvedValue({
      items: [platformPending, merchantPending],
      total: 2,
      page: 1,
      pageSize: 20,
    })
    apiMocks.getAdminOrderDetail.mockImplementation(async (id: number) => {
      if (id === 501) return platformDetail
      return merchantDetail
    })
    apiMocks.startAdminPlatformFulfillment.mockResolvedValue({ id: 501, status: 'processing' })
  })

  it('renders 开始履约 for platform pending manual order', async () => {
    render(<AdminOrderTable />)
    fireEvent.click(await screen.findByTestId('admin-order-detail-501'))
    expect(await screen.findByTestId('admin-platform-start-fulfillment')).toHaveTextContent('开始履约')
  })

  it('does not render for merchant order', async () => {
    render(<AdminOrderTable />)
    fireEvent.click(await screen.findByTestId('admin-order-detail-502'))
    expect(await screen.findByTestId('admin-order-detail-dialog')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-platform-start-fulfillment')).not.toBeInTheDocument()
  })

  it('click calls the admin API mock and refreshes detail plus list', async () => {
    render(<AdminOrderTable />)
    fireEvent.click(await screen.findByTestId('admin-order-detail-501'))
    fireEvent.click(await screen.findByTestId('admin-platform-start-fulfillment'))

    await waitFor(() => {
      expect(apiMocks.startAdminPlatformFulfillment).toHaveBeenCalledWith(501)
    })
    await waitFor(() => {
      expect(apiMocks.getAdminOrderDetail.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(apiMocks.getAdminOrders.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })
})
