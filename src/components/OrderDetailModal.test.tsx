import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckoutPreview } from '../api/orders'
import type { UserOrderDetail } from '../types/order'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'

const { createOrder, getCheckoutPreview, renewOrder } = vi.hoisted(() => ({
  createOrder: vi.fn(),
  getCheckoutPreview: vi.fn(),
  renewOrder: vi.fn(),
}))

vi.mock('../api/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/orders')>()
  return {
    ...actual,
    createOrder,
    getCheckoutPreview,
    renewOrder,
    disputeOrder: vi.fn(),
    closeOrder: vi.fn(),
    getOrderAttentionCount: vi.fn().mockResolvedValue(0),
    getOrderDetail: vi.fn(),
  }
})

import OrderDetailModal from './OrderDetailModal'

const ORDER: UserOrderDetail = {
  id: 50,
  price: 100,
  status: 'delivered',
  deliveryMode: 'instant_inventory',
  createdAt: '2026-09-01T00:00:00.000Z',
  merchant: null,
  product: {
    id: 42,
    name: '订阅商品',
    type: '网络节点',
    icon: 'box',
    imageUrl: null,
    deliveryMode: 'instant_inventory',
  },
  delivery: {
    status: 'delivered',
    content: 'secret-credentials-token',
    expiresAt: '2026-10-01T00:00:00.000Z',
    expired: false,
  },
  timeline: [],
}

function preview(overrides: Partial<CheckoutPreview> = {}): CheckoutPreview {
  return {
    productId: 42,
    productName: '订阅商品',
    offerId: 11,
    offerName: '月卡',
    price: 100,
    deliveryMode: 'instant_inventory',
    chargeType: 'debit',
    balanceBefore: 500,
    balanceAfter: 400,
    sufficient: true,
    purchasable: true,
    purchaseForm: [],
    purchaseFormVersion: 'pf-v1',
    checkoutVersion: 'co-v1',
    requiresVerification: false,
    autoProvision: false,
    productContentVersion: 4,
    assuranceGrantId: null,
    ...overrides,
  }
}

describe('OrderDetailModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [], islandNotice: null, modalDepth: 0 })
    useAuthStore.setState({
      user: {
        id: 1,
        email: 'buyer@test.local',
        role: 'user',
        status: 'active',
        points: 500,
        merchant: null,
      },
      accessToken: 'token',
      isLoggedIn: true,
    })
    renewOrder.mockResolvedValue({
      productId: 42,
      offerId: 11,
      offerName: '月卡',
      price: 100,
      validityDays: 30,
      currentExpiresAt: '2026-10-01T00:00:00.000Z',
    })
    getCheckoutPreview.mockResolvedValue(preview())
    createOrder.mockResolvedValue({
      orderId: 88,
      productName: '订阅商品',
      price: 100,
      status: 'delivered',
      deliveryMode: 'instant_inventory',
      balanceAfter: 400,
      merchantId: null,
      merchantName: null,
    })
  })

  describe('renewal term fields', () => {
    it('sends expectedProductContentVersion and expectedAssuranceGrantId from the confirmed renewal preview, including null grant id', async () => {
      render(<OrderDetailModal order={ORDER} onClose={vi.fn()} />)

      fireEvent.click(screen.getByTestId('order-renew-button'))
      await screen.findByTestId('purchase-modal')
      await screen.findByTestId('preview-price')
      fireEvent.click(screen.getByRole('button', { name: '确认支付' }))

      await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(1))
      expect(createOrder).toHaveBeenCalledWith(42, expect.objectContaining({
        expectedPrice: 100,
        offerId: 11,
        renewalOfOrderId: 50,
        expectedPurchaseFormVersion: 'pf-v1',
        expectedCheckoutVersion: 'co-v1',
        expectedProductContentVersion: 4,
        expectedAssuranceGrantId: null,
      }))
      const options = createOrder.mock.calls[0][1]
      expect(Object.prototype.hasOwnProperty.call(options, 'expectedAssuranceGrantId')).toBe(true)
    })
  })

  describe('real DTO status decoupling and fulfillment views', () => {
    it('disables file download when order is disputed while preserving historical delivery text', () => {
      const disputedOrder: UserOrderDetail = {
        ...ORDER,
        status: 'disputed',
        delivery: {
          status: 'delivered',
          content: 'HISTORICAL_SECRET_KEY',
          file: { fileName: 'software-v1.tar.gz', size: 10240, status: 'uploaded' },
          expiresAt: null,
          expired: false,
        },
      }

      render(<OrderDetailModal order={disputedOrder} onClose={vi.fn()} />)

      // Status badge is disputed
      const statusBadge = screen.getByTestId('order-detail-status')
      expect(statusBadge).toHaveAttribute('data-order-status', 'disputed')

      // File download is disabled
      const downloadBtn = screen.getByTestId('file-delivery-download')
      expect(downloadBtn).toBeDisabled()
      expect(downloadBtn).toHaveTextContent('下载已暂停')
      expect(screen.getByTestId('file-delivery-disputed-notice')).toHaveTextContent('争议处理中，文件下载已暂停')

      // Historical delivered text remains visible
      expect(screen.getByTestId('delivery-text-content')).toHaveTextContent('HISTORICAL_SECRET_KEY')
    })

    it('disables file download and displays refund notice when order is refunded', () => {
      const refundedOrder: UserOrderDetail = {
        ...ORDER,
        status: 'refunded',
        holdingPoints: 100,
        delivery: {
          status: 'delivered',
          content: 'HISTORICAL_KEY',
          file: { fileName: 'package.zip', size: 512, status: 'uploaded' },
          expiresAt: null,
          expired: false,
        },
      }

      render(<OrderDetailModal order={refundedOrder} onClose={vi.fn()} />)

      const statusBadge = screen.getByTestId('order-detail-status')
      expect(statusBadge).toHaveAttribute('data-order-status', 'refunded')

      // Download button disabled
      const downloadBtn = screen.getByTestId('file-delivery-download')
      expect(downloadBtn).toBeDisabled()
      expect(downloadBtn).toHaveTextContent('下载已关闭')
      expect(screen.getByTestId('file-delivery-refunded-notice')).toHaveTextContent('订单已全额退款，文件下载授权已关闭')

      // Holding points refund notice is shown
      expect(screen.getByTestId('order-holding-points')).toHaveTextContent('订单已退款结束。冻结积分已按规则退还')
    })
  })

  describe('real clipboard feedback and copy actions', () => {
    it('copies content on resolved promise and switches to Check icon feedback', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      vi.stubGlobal('navigator', { clipboard: { writeText } })

      render(<OrderDetailModal order={ORDER} onClose={vi.fn()} />)

      const copyBtn = screen.getByTestId('order-detail-copy')
      expect(copyBtn).toBeInTheDocument()
      expect(copyBtn).toHaveTextContent('复制内容')

      fireEvent.click(copyBtn)

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith('secret-credentials-token')
      })
      expect(copyBtn).toHaveTextContent('已复制')
      expect(useAppStore.getState().toasts[0]?.message).toBe('发货信息已复制')
    })

    it('shows error toast when clipboard write rejects', async () => {
      const writeText = vi.fn().mockRejectedValue(new Error('Permission denied'))
      vi.stubGlobal('navigator', { clipboard: { writeText } })

      render(<OrderDetailModal order={ORDER} onClose={vi.fn()} />)

      const copyBtn = screen.getByTestId('order-detail-copy')
      fireEvent.click(copyBtn)

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith('secret-credentials-token')
      })
      expect(copyBtn).not.toHaveTextContent('已复制')
      expect(useAppStore.getState().toasts[0]?.message).toContain('复制失败，请长按或手动选中文本复制')
    })

    it('does not render bottom copy button when content is empty or masked', () => {
      const maskedOrder: UserOrderDetail = {
        ...ORDER,
        delivery: {
          status: 'delivered',
          content: null,
          contentMasked: true,
          expiresAt: '2026-09-01T00:00:00.000Z',
          expired: true,
        },
      }

      render(<OrderDetailModal order={maskedOrder} onClose={vi.fn()} />)

      // Copy button is omitted per "无有效可复制内容时，不渲染复制操作"
      expect(screen.queryByTestId('order-detail-copy')).not.toBeInTheDocument()
      // Masked placeholder is present
      expect(screen.getByTestId('delivery-masked')).toBeInTheDocument()
    })
  })
})
