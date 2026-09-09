import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminPlatformFulfillmentActions from './AdminPlatformFulfillmentActions'
import type { AdminOrderDetail } from '../../api/admin'
import { useAppStore } from '../../stores/appStore'

const apiMocks = vi.hoisted(() => ({
  startAdminPlatformFulfillment: vi.fn(),
  postAdminPlatformProgress: vi.fn(),
  deliverAdminPlatformOrder: vi.fn(),
  rejectAdminPlatformOrder: vi.fn(),
}))

vi.mock('../../api/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/admin')>()
  return {
    ...actual,
    startAdminPlatformFulfillment: apiMocks.startAdminPlatformFulfillment,
    postAdminPlatformProgress: apiMocks.postAdminPlatformProgress,
    deliverAdminPlatformOrder: apiMocks.deliverAdminPlatformOrder,
    rejectAdminPlatformOrder: apiMocks.rejectAdminPlatformOrder,
  }
})

function platformOrder(overrides: Partial<AdminOrderDetail> = {}): AdminOrderDetail {
  return {
    id: 42,
    status: 'pending',
    price: 88,
    createdAt: '2026-04-01T08:00:00.000Z',
    merchantId: null,
    merchant: null,
    user: { id: 3, email: 'buyer@test.local' },
    product: { id: 7, name: '人工咨询', deliveryMode: 'manual_service' },
    deliveryModeSnapshot: 'manual_service',
    delivery: { status: 'pending' },
    ...overrides,
  }
}

describe('AdminPlatformFulfillmentActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [] })
    apiMocks.startAdminPlatformFulfillment.mockResolvedValue({ id: 42, status: 'processing' })
    apiMocks.postAdminPlatformProgress.mockResolvedValue({ id: 42, status: 'processing' })
    apiMocks.deliverAdminPlatformOrder.mockResolvedValue({ id: 42, status: 'delivered' })
    apiMocks.rejectAdminPlatformOrder.mockResolvedValue({ id: 42, status: 'refunded' })
  })

  it('renders 开始履约 for platform pending manual order', () => {
    render(<AdminPlatformFulfillmentActions order={platformOrder()} />)
    expect(screen.getByTestId('admin-platform-start-fulfillment')).toHaveTextContent('开始履约')
  })

  it('does not render for merchant order', () => {
    render(
      <AdminPlatformFulfillmentActions
        order={platformOrder({
          merchantId: 12,
          merchant: { id: 12, name: '专营卡券商户' },
        })}
      />,
    )
    expect(screen.queryByTestId('admin-platform-fulfillment-actions')).not.toBeInTheDocument()
    expect(screen.queryByText('开始履约')).not.toBeInTheDocument()
  })

  it('click calls the admin API mock', async () => {
    render(<AdminPlatformFulfillmentActions order={platformOrder()} />)
    fireEvent.click(screen.getByTestId('admin-platform-start-fulfillment'))
    await waitFor(() => {
      expect(apiMocks.startAdminPlatformFulfillment).toHaveBeenCalledWith(42)
    })
  })

  it('hides actions for fakaBridge and provisionTask orders', () => {
    const { rerender } = render(
      <AdminPlatformFulfillmentActions
        order={platformOrder({ fakaBridgeTask: { id: 9 } })}
      />,
    )
    expect(screen.queryByTestId('admin-platform-fulfillment-actions')).not.toBeInTheDocument()
    expect(screen.queryByText('开始履约')).not.toBeInTheDocument()

    rerender(
      <AdminPlatformFulfillmentActions
        order={platformOrder({
          product: { id: 7, name: 'Xboard 月卡', deliveryMode: 'manual_service', fakaBridge: true },
        })}
      />,
    )
    expect(screen.queryByTestId('admin-platform-fulfillment-actions')).not.toBeInTheDocument()
    expect(screen.queryByText('开始履约')).not.toBeInTheDocument()

    rerender(
      <AdminPlatformFulfillmentActions
        order={platformOrder({
          provisionTask: {
            status: 'pending',
            attempts: 1,
            lastError: null,
            lastHttpStatus: null,
            nextAttemptAt: null,
            merchantNotifiedAt: null,
            updatedAt: null,
          },
        })}
      />,
    )
    expect(screen.queryByTestId('admin-platform-fulfillment-actions')).not.toBeInTheDocument()
  })

  it('shows processing actions and posts progress note', async () => {
    render(<AdminPlatformFulfillmentActions order={platformOrder({ status: 'processing' })} />)
    expect(screen.queryByTestId('admin-platform-start-fulfillment')).not.toBeInTheDocument()
    expect(screen.getByTestId('admin-platform-progress')).toHaveTextContent('进度备注')
    expect(screen.getByTestId('admin-platform-deliver')).toHaveTextContent('交付')
    expect(screen.getByTestId('admin-platform-reject')).toHaveTextContent('拒单')

    fireEvent.click(screen.getByTestId('admin-platform-progress'))
    fireEvent.change(screen.getByTestId('admin-platform-progress-note'), {
      target: { value: '初稿已完成' },
    })
    fireEvent.click(screen.getByTestId('admin-platform-progress-submit'))

    await waitFor(() => {
      expect(apiMocks.postAdminPlatformProgress).toHaveBeenCalledWith(42, { publicNote: '初稿已完成' })
    })
  })
})
