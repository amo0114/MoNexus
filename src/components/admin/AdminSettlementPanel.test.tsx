import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import AdminSettlementPanel from './AdminSettlementPanel'
import * as adminMerchantApi from '../../api/adminMerchant'

vi.mock('../../api/adminMerchant', () => ({
  getAdminSettlements: vi.fn(),
  batchSettle: vi.fn(),
}))

vi.mock('../../stores/appStore', () => ({
  useAppStore: () => vi.fn(),
}))

describe('AdminSettlementPanel (PR 01 Remediation)', () => {
  const mockSettlements = [
    {
      id: 1,
      orderId: 101,
      merchantId: 10,
      orderAmount: 100,
      commissionRate: '0.1',
      commissionAmount: 10,
      settlementAmount: 90,
      status: 'pending',
      settledAt: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      merchant: { id: 10, name: '测试商户' },
      order: { id: 101, price: 100, createdAt: '2026-09-01T00:00:00.000Z', status: 'delivered' },
      payable: true,
      blockReason: null,
    },
    {
      id: 2,
      orderId: 102,
      merchantId: 10,
      orderAmount: 200,
      commissionRate: '0.1',
      commissionAmount: 20,
      settlementAmount: 180,
      status: 'pending',
      settledAt: null,
      createdAt: '2026-09-01T01:00:00.000Z',
      merchant: { id: 10, name: '测试商户' },
      order: { id: 102, price: 200, createdAt: '2026-09-01T01:00:00.000Z', status: 'disputed' },
      payable: false,
      blockReason: '订单争议中，暂不可结算',
    },
    {
      id: 3,
      orderId: 103,
      merchantId: 10,
      orderAmount: 300,
      commissionRate: '0.1',
      commissionAmount: 30,
      settlementAmount: 270,
      status: 'settled',
      settledAt: '2026-09-01T02:00:00.000Z',
      createdAt: '2026-09-01T02:00:00.000Z',
      merchant: { id: 10, name: '测试商户' },
      order: { id: 103, price: 300, createdAt: '2026-09-01T02:00:00.000Z', status: 'closed' },
      payable: true,
      blockReason: null,
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(adminMerchantApi.getAdminSettlements).mockResolvedValue({
      items: mockSettlements as any,
      total: 3,
      page: 1,
      pageSize: 20,
    })
  })

  it('fails closed: disables checkbox for pending settlements with payable === false and displays safe blockReason', async () => {
    render(<AdminSettlementPanel active={true} />)

    expect(await screen.findByText('ORD-101')).toBeInTheDocument()

    // Row 1: payable = true -> checkbox enabled
    const checkbox1 = screen.getByTestId('admin-settlement-checkbox-1') as HTMLInputElement
    expect(checkbox1).toBeEnabled()

    // Row 2: payable = false -> checkbox disabled and blockReason displayed
    const checkbox2 = screen.getByTestId('admin-settlement-checkbox-2') as HTMLInputElement
    expect(checkbox2).toBeDisabled()
    expect(screen.getByTestId('settlement-block-reason-2')).toHaveTextContent('订单争议中，暂不可结算')

    // Row 3: settled -> no checkbox
    expect(screen.queryByTestId('admin-settlement-checkbox-3')).not.toBeInTheDocument()
  })

  it('controls header checkbox indeterminate state on partial selection of eligible items', async () => {
    render(<AdminSettlementPanel active={true} />)

    expect(await screen.findByText('ORD-101')).toBeInTheDocument()
    const headerCheckbox = screen.getByLabelText('选择当前页待结算订单') as HTMLInputElement
    expect(headerCheckbox.checked).toBe(false)
    expect(headerCheckbox.indeterminate).toBe(false)

    // Select row 1 (the only eligible pending item on this page)
    const checkbox1 = screen.getByTestId('admin-settlement-checkbox-1')
    fireEvent.click(checkbox1)

    // Since row 1 is the ONLY eligible pending item, selecting it makes current page all-selected
    expect(headerCheckbox.checked).toBe(true)
    expect(headerCheckbox.indeterminate).toBe(false)
  })

  it('supports mobile toolbar to toggle select-all, clear selection, and view details dialog', async () => {
    render(<AdminSettlementPanel active={true} />)

    expect(await screen.findByText('ORD-101')).toBeInTheDocument()

    const mobileToggleAll = screen.getByTestId('admin-mobile-toggle-page-all')
    fireEvent.click(mobileToggleAll)

    // Selected 1 eligible item (row 1)
    const viewDetailBtn = await screen.findByTestId('admin-mobile-view-selection')
    expect(viewDetailBtn).toHaveTextContent('已选 1 笔')

    // Open detail dialog
    fireEvent.click(viewDetailBtn)
    expect(await screen.findByTestId('admin-settlements-selection-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('admin-selection-detail-item-1')).toHaveTextContent('ORD-101')
    expect(screen.getByTestId('admin-selection-detail-item-1')).toHaveTextContent('90 积分')

    // Clear selection inside dialog
    const clearBtn = screen.getByTestId('admin-dialog-clear-selection')
    fireEvent.click(clearBtn)

    expect(screen.queryByTestId('admin-mobile-view-selection')).not.toBeInTheDocument()
    expect(screen.getByTestId('admin-batch-settle')).toHaveTextContent('批量结算 (0)')
  })

  it('fails closed when item is missing payable property', async () => {
    const itemMissingPayable = [
      {
        id: 99,
        orderId: 999,
        merchantId: 10,
        orderAmount: 100,
        commissionRate: '0.1',
        commissionAmount: 10,
        settlementAmount: 90,
        status: 'pending',
        settledAt: null,
        createdAt: '2026-09-01T00:00:00.000Z',
        merchant: { id: 10, name: '测试商户' },
        order: { id: 999, price: 100, createdAt: '2026-09-01T00:00:00.000Z' },
        // payable is undefined!
      },
    ]
    vi.mocked(adminMerchantApi.getAdminSettlements).mockResolvedValueOnce({
      items: itemMissingPayable as any,
      total: 1,
      page: 1,
      pageSize: 20,
    })

    render(<AdminSettlementPanel active={true} />)
    expect(await screen.findByText('ORD-999')).toBeInTheDocument()

    const cb = screen.getByTestId('admin-settlement-checkbox-99') as HTMLInputElement
    expect(cb).toBeDisabled()
  })
})
