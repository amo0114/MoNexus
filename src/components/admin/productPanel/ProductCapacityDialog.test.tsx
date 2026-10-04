import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ProductCapacityDialog from './ProductCapacityDialog'
import * as adminApi from '../../../api/admin'
import { useAppStore } from '../../../stores/appStore'

vi.mock('../../../api/admin', async () => {
  const actual = await vi.importActual<typeof import('../../../api/admin')>('../../../api/admin')
  return {
    ...actual,
    setAdminFakaCapacity: vi.fn(),
  }
})

function fakaProduct(capacityLimit: number | null, activeUsers = 3): adminApi.AdminProductListItem {
  return {
    id: 501,
    name: '自营数码礼品卡',
    type: '礼品卡',
    price: 100,
    stock: 10,
    status: 'active',
    merchantId: null,
    fakaBridge: true,
    fakaCapacity: {
      sku: 'SKU-501',
      planId: 1,
      capacityLimit,
      activeUsers,
      remaining: capacityLimit == null ? null : capacityLimit - activeUsers,
      sellable: true,
      source: 'xboard',
    },
    offers: [
      { id: 901, name: '月付', price: 100, isDefault: true, externalIntegration: 'faka_bridge' },
    ],
  }
}

describe('ProductCapacityDialog (R09d)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [] })
  })

  it('seeds the limit input from the product capacity and hides it when unlimited', () => {
    const { rerender } = render(
      <ProductCapacityDialog product={fakaProduct(50)} onClose={() => {}} onSaved={() => {}} />,
    )

    expect(screen.getByText('调整 Xboard 人数上限')).toBeInTheDocument()
    expect(screen.getByTestId('admin-faka-cap-input')).toHaveValue(50)
    expect(screen.getByTestId('admin-faka-cap-unlimited')).not.toBeChecked()
    expect(screen.getByText(/当前容量：/)).toHaveTextContent('50 人')
    expect(screen.getByText(/当前容量：/)).toHaveTextContent('在用 3')

    // 不限制人数：输入框隐藏，开关勾选
    fireEvent.click(screen.getByTestId('admin-faka-cap-unlimited'))
    expect(screen.queryByTestId('admin-faka-cap-input')).not.toBeInTheDocument()
    expect(screen.getByTestId('admin-faka-cap-unlimited')).toBeChecked()

    // 关闭后重新打开：草稿按当前商品重新播种，不保留上次编辑
    rerender(<ProductCapacityDialog product={null} onClose={() => {}} onSaved={() => {}} />)
    rerender(
      <ProductCapacityDialog product={fakaProduct(null)} onClose={() => {}} onSaved={() => {}} />,
    )
    expect(screen.getByTestId('admin-faka-cap-unlimited')).toBeChecked()
    expect(screen.getByText(/当前容量：/)).toHaveTextContent('不限制')
  })

  it('rejects a non-integer limit without calling the API', async () => {
    render(<ProductCapacityDialog product={fakaProduct(10)} onClose={() => {}} onSaved={() => {}} />)

    fireEvent.change(screen.getByTestId('admin-faka-cap-input'), { target: { value: '-1' } })
    fireEvent.click(screen.getByTestId('admin-faka-cap-save'))

    await waitFor(() => {
      expect(useAppStore.getState().toasts.map((t) => t.message)).toContain(
        '请输入有效的非负整数上限',
      )
    })
    expect(adminApi.setAdminFakaCapacity).not.toHaveBeenCalled()
  })

  it('saves through the existing payload, closes, then reloads the list', async () => {
    const onClose = vi.fn()
    const onSaved = vi.fn()
    vi.mocked(adminApi.setAdminFakaCapacity).mockResolvedValueOnce({
      sku: 'SKU-501',
      planId: 1,
      capacityLimit: 20,
      activeUsers: 3,
      remaining: 17,
      sellable: true,
      source: 'xboard',
    })

    render(
      <ProductCapacityDialog product={fakaProduct(10)} onClose={onClose} onSaved={onSaved} />,
    )

    fireEvent.change(screen.getByTestId('admin-faka-cap-input'), { target: { value: '20' } })
    fireEvent.click(screen.getByTestId('admin-faka-cap-save'))

    await waitFor(() => {
      expect(adminApi.setAdminFakaCapacity).toHaveBeenCalledWith(501, {
        offerId: 901,
        capacityLimit: 20,
      })
    })
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled()
      expect(onSaved).toHaveBeenCalled()
      expect(useAppStore.getState().toasts.map((t) => t.message)).toContain('已同步到 Xboard')
    })
  })

  it('keeps the dialog open and surfaces the error when the sync fails', async () => {
    const onClose = vi.fn()
    const onSaved = vi.fn()
    vi.mocked(adminApi.setAdminFakaCapacity).mockRejectedValueOnce(new Error('upstream down'))

    render(
      <ProductCapacityDialog product={fakaProduct(10)} onClose={onClose} onSaved={onSaved} />,
    )

    fireEvent.click(screen.getByTestId('admin-faka-cap-save'))

    await waitFor(() => {
      expect(adminApi.setAdminFakaCapacity).toHaveBeenCalled()
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
    expect(screen.getByTestId('admin-faka-cap-save')).toBeEnabled()
  })

  it('sends a null limit when unlimited is checked', async () => {
    vi.mocked(adminApi.setAdminFakaCapacity).mockResolvedValueOnce({
      sku: 'SKU-501',
      planId: 1,
      capacityLimit: null,
      activeUsers: 3,
      remaining: null,
      sellable: true,
      source: 'xboard',
    })

    render(<ProductCapacityDialog product={fakaProduct(10)} onClose={() => {}} onSaved={() => {}} />)

    fireEvent.click(screen.getByTestId('admin-faka-cap-unlimited'))
    fireEvent.click(screen.getByTestId('admin-faka-cap-save'))

    await waitFor(() => {
      expect(adminApi.setAdminFakaCapacity).toHaveBeenCalledWith(501, {
        offerId: 901,
        capacityLimit: null,
      })
    })
  })
})
