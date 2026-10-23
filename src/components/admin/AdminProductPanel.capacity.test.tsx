import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminProductPanel from './AdminProductPanel'
import * as adminApi from '../../api/admin'
import { useAppStore } from '../../stores/appStore'

vi.mock('../../api/admin', async () => {
  const actual = await vi.importActual<typeof import('../../api/admin')>('../../api/admin')
  return {
    ...actual,
    getAdminProducts: vi.fn(),
    adjustAdminOfferCapacity: vi.fn(),
  }
})
vi.mock('../catalog/AdminFakaImportPreview', () => ({ default: () => null }))
vi.mock('../catalog/AdminProductPublicationDialog', () => ({ default: () => null }))
vi.mock('../catalog/AdminOfferManagerModal', () => ({ default: () => null }))
vi.mock('../catalog/AdminFakaSyncDialog', () => ({ default: () => null }))
vi.mock('../catalog/AdminInventoryImportPreview', () => ({ default: () => null }))

const products: adminApi.AdminProductListItem[] = [
  {
    id: 6,
    name: '1 对 1 职业规划咨询',
    type: '团队特权',
    price: 200,
    stock: 0,
    status: 'draft',
    merchantId: null,
    deliveryMode: 'manual_service',
    stockMode: 'limited',
    offers: [{ id: 61, name: '默认规格', price: 200, isDefault: true, deliveryMode: 'manual_service', stockMode: 'limited', stock: 0, status: 'active' }],
  },
  {
    id: 7,
    name: '平台不限量服务',
    type: '团队特权',
    price: 50,
    stock: 0,
    status: 'active',
    merchantId: null,
    deliveryMode: 'manual_service',
    stockMode: 'unlimited',
    offers: [{ id: 71, name: '默认规格', price: 50, isDefault: true, deliveryMode: 'manual_service', stockMode: 'unlimited', stock: 0, status: 'active' }],
  },
  {
    id: 8,
    name: '商家限量服务',
    type: '网络节点',
    price: 80,
    stock: 3,
    status: 'active',
    merchantId: 2,
    deliveryMode: 'manual_service',
    stockMode: 'limited',
    offers: [{ id: 81, name: '默认规格', price: 80, isDefault: true, deliveryMode: 'manual_service', stockMode: 'limited', stock: 3, status: 'active' }],
  },
]

describe('AdminProductPanel platform capacity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [] })
    vi.mocked(adminApi.getAdminProducts).mockResolvedValue({ items: products, total: 3, page: 1, pageSize: 20 })
  })

  it('offers capacity adjustment only on limited platform fixed/manual products', async () => {
    render(<AdminProductPanel active={true} />)
    await screen.findByText('1 对 1 职业规划咨询')

    expect(screen.getByTestId('admin-adjust-capacity-6')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-adjust-capacity-7')).not.toBeInTheDocument()
    expect(screen.queryByTestId('admin-adjust-capacity-8')).not.toBeInTheDocument()
  })

  it('adjusts the quota and shows the new remaining count before the list reloads', async () => {
    vi.mocked(adminApi.adjustAdminOfferCapacity).mockResolvedValue({ stock: 4 })
    render(<AdminProductPanel active={true} />)
    fireEvent.click(await screen.findByTestId('admin-adjust-capacity-6'))

    const dialog = await screen.findByTestId('admin-offer-capacity-dialog')
    expect(within(dialog).getByTestId('availability-current-stock')).toHaveTextContent('0')
    fireEvent.change(within(dialog).getByTestId('availability-capacity-delta'), { target: { value: '4' } })
    fireEvent.change(within(dialog).getByTestId('availability-capacity-reason'), { target: { value: '十月名额' } })
    fireEvent.click(within(dialog).getByTestId('availability-capacity-submit'))

    await waitFor(() => expect(adminApi.adjustAdminOfferCapacity).toHaveBeenCalledWith(6, 61, { delta: 4, reason: '十月名额' }))
    await waitFor(() => expect(within(dialog).getByTestId('availability-current-stock')).toHaveTextContent('4'))
    expect(useAppStore.getState().toasts.some((toast) => toast.message === '名额已调整，当前剩余 4')).toBe(true)
    // The list refreshes after the change (initial load + reload).
    await waitFor(() => expect(vi.mocked(adminApi.getAdminProducts).mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it('keeps the inputs and reports the server reason when the adjustment fails', async () => {
    vi.mocked(adminApi.adjustAdminOfferCapacity).mockRejectedValue({
      response: { data: { error: { message: '减少数量不能超过当前可售名额' } } },
    })
    render(<AdminProductPanel active={true} />)
    fireEvent.click(await screen.findByTestId('admin-adjust-capacity-6'))
    const dialog = await screen.findByTestId('admin-offer-capacity-dialog')
    fireEvent.change(within(dialog).getByTestId('availability-capacity-delta'), { target: { value: '2' } })
    fireEvent.change(within(dialog).getByTestId('availability-capacity-reason'), { target: { value: '补充' } })
    fireEvent.click(within(dialog).getByTestId('availability-capacity-submit'))

    await waitFor(() => expect(useAppStore.getState().toasts.some((toast) => toast.message === '减少数量不能超过当前可售名额')).toBe(true))
    expect(within(dialog).getByTestId('availability-capacity-delta')).toHaveValue(2)
    expect(within(dialog).getByTestId('availability-current-stock')).toHaveTextContent('0')
  })
})
