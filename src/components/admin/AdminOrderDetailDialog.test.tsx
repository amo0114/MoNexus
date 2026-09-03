import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import AdminOrderDetailDialog from './AdminOrderDetailDialog'
import { AdminOrderDetail } from '../../api/admin'
import { useAppStore } from '../../stores/appStore'

describe('AdminOrderDetailDialog Component', () => {
  const sampleDetail: AdminOrderDetail = {
    id: 999,
    status: 'delivered',
    price: 350,
    createdAt: '2026-03-01T10:00:00.000Z',
    updatedAt: '2026-03-01T10:05:00.000Z',
    user: { id: 77, email: 'buyer77@test.local' },
    merchant: { id: 12, name: '专营卡券商户' },
    product: {
      id: 88,
      name: '月度订阅VIP卡',
      deliveryMode: 'instant_inventory',
    },
    delivery: {
      id: 555,
      content: 'CARD-SECRET-KEY-XYZ-999',
      status: 'delivered',
      expiresAt: '2026-04-01T10:00:00.000Z',
      expired: false,
    },
    purchaseFormAnswers: {
      '充值QQ号': '12345678',
      '服务器大区': '电信一区',
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [] })
  })

  it('renders nothing when closed', () => {
    render(
      <AdminOrderDetailDialog
        order={null}
        open={false}
        onOpenChange={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('admin-order-detail-dialog')).not.toBeInTheDocument()
  })

  it('renders loading state with role="status" and aria-live="polite" when loading is true', () => {
    render(
      <AdminOrderDetailDialog
        order={null}
        open={true}
        loading={true}
        onOpenChange={vi.fn()}
      />,
    )
    expect(screen.getByTestId('admin-order-detail-dialog')).toBeInTheDocument()
    const loadingContainer = screen.getByTestId('admin-order-detail-loading')
    expect(loadingContainer).toHaveAttribute('role', 'status')
    expect(loadingContainer).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByText('加载订单详情中...')).toBeInTheDocument()
  })

  it('renders error state with error message and retry button calling onRetry', () => {
    const onRetry = vi.fn()
    render(
      <AdminOrderDetailDialog
        order={null}
        open={true}
        loading={false}
        error="网络连接超时，请重试"
        onRetry={onRetry}
        onOpenChange={vi.fn()}
      />,
    )

    const errorContainer = screen.getByTestId('admin-order-detail-error')
    expect(errorContainer).toBeInTheDocument()
    expect(screen.getByText('加载订单详情失败')).toBeInTheDocument()
    expect(screen.getByText('网络连接超时，请重试')).toBeInTheDocument()

    const retryBtn = screen.getByTestId('admin-order-detail-retry-btn')
    fireEvent.click(retryBtn)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('displays sensitive information compliance boundary banner and order metadata', () => {
    render(
      <AdminOrderDetailDialog
        order={sampleDetail}
        open={true}
        onOpenChange={vi.fn()}
      />,
    )

    // Verify sensitive notice
    const notice = screen.getByTestId('admin-order-sensitive-notice')
    expect(notice).toBeInTheDocument()
    expect(notice).toHaveTextContent('【敏感信息合规边界】')
    expect(notice).toHaveTextContent('本页面向管理人员如实展示买家真实交付凭据及预留表单')

    // Basic metadata
    expect(screen.getByRole('heading', { level: 2, name: /ORD-999/ })).toBeInTheDocument()
    expect(screen.getByText('U77（buyer77@test.local）')).toBeInTheDocument()
    expect(screen.getByText('专营卡券商户')).toBeInTheDocument()
    expect(screen.getByText(/350 积分/)).toBeInTheDocument()
    expect(screen.getByText('月度订阅VIP卡')).toBeInTheDocument()
  })

  it('renders delivery content and copies to clipboard on button click', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    })

    render(
      <AdminOrderDetailDialog
        order={sampleDetail}
        open={true}
        onOpenChange={vi.fn()}
      />,
    )

    const contentBox = screen.getByTestId('admin-order-delivery-content')
    expect(contentBox).toHaveTextContent('CARD-SECRET-KEY-XYZ-999')

    const copyBtn = screen.getByTestId('copy-delivery-content-btn')
    fireEvent.click(copyBtn)

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('CARD-SECRET-KEY-XYZ-999')
    })
    expect(useAppStore.getState().toasts.some((t) => t.message.includes('已复制'))).toBe(true)
  })

  it('renders purchase form answers when provided', () => {
    render(
      <AdminOrderDetailDialog
        order={sampleDetail}
        open={true}
        onOpenChange={vi.fn()}
      />,
    )

    const answersContainer = screen.getByTestId('admin-order-form-answers')
    expect(answersContainer).toHaveTextContent('充值QQ号')
    expect(answersContainer).toHaveTextContent('12345678')
    expect(answersContainer).toHaveTextContent('服务器大区')
    expect(answersContainer).toHaveTextContent('电信一区')
  })

  it('calls onOpenChange(false) on close button click', () => {
    const onOpenChange = vi.fn()
    render(
      <AdminOrderDetailDialog
        order={sampleDetail}
        open={true}
        onOpenChange={onOpenChange}
      />,
    )

    const closeBtn = screen.getByTestId('admin-order-detail-close-btn')
    fireEvent.click(closeBtn)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
