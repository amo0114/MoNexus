import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import MerchantAvailabilityModal from './MerchantAvailabilityModal'
import type { MerchantProduct } from '../../types/merchant'

const apiMocks = vi.hoisted(() => ({
  adjust: vi.fn(),
  importInventory: vi.fn(),
  preview: vi.fn(),
  voidInventory: vi.fn(),
}))

vi.mock('../../api/merchant', async () => {
  const actual = await vi.importActual<typeof import('../../api/merchant')>('../../api/merchant')
  return {
    ...actual,
    adjustMerchantOfferCapacity: apiMocks.adjust,
    importMerchantOfferInventory: apiMocks.importInventory,
    previewMerchantOfferInventory: apiMocks.preview,
    voidMerchantOfferInventory: apiMocks.voidInventory,
  }
})

const product: MerchantProduct = {
  id: 7,
  merchantId: 9,
  name: '多规格商品',
  description: null,
  richDescription: null,
  type: '网络节点',
  icon: 'package',
  imageUrl: null,
  price: 100,
  originalPrice: null,
  stock: 0,
  availableStock: 5,
  sales: 0,
  status: 'active',
  createdAt: '2026-08-09T00:00:00.000Z',
  stockMode: 'limited',
  offers: [
    { id: 42, name: '月卡', price: 100, originalPrice: null, status: 'active', deliveryMode: 'instant_inventory', stockMode: 'limited', stock: 0, availableStock: 2 },
    { id: 43, name: '季卡', price: 200, originalPrice: null, status: 'active', deliveryMode: 'instant_fixed', stockMode: 'limited', stock: 5 },
    { id: 44, name: '终身卡', price: 300, originalPrice: null, status: 'active', deliveryMode: 'manual_service', stockMode: 'unlimited', stock: 0 },
  ],
}

describe('MerchantAvailabilityModal (T-CAT-FE-002)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.preview.mockResolvedValue({ totalRows: 1, validRows: 1, emptyRows: 0, duplicateRows: 0, existingDuplicateRows: 0, canImport: true })
    apiMocks.importInventory.mockResolvedValue({ imported: 1 })
    apiMocks.voidInventory.mockResolvedValue({ offerId: 42, voided: 1, availableStock: 1, productAvailableStock: 4 })
    apiMocks.adjust.mockResolvedValue({ stock: 7 })
  })

  it('selects an Offer before revealing its mutually exclusive action and splits Offer/Product totals', async () => {
    const onChanged = vi.fn()
    render(<MerchantAvailabilityModal isOpen onClose={vi.fn()} product={product} onChanged={onChanged} />)

    expect(screen.getByTestId('availability-offer-select')).toHaveValue('42')
    expect(screen.getByTestId('availability-inventory')).toBeInTheDocument()
    expect(screen.getByTestId('availability-offer-stock')).toHaveTextContent('2')
    expect(screen.getByTestId('availability-product-stock')).toHaveTextContent('5')
    expect(screen.queryByTestId('availability-capacity-form')).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('availability-offer-select'), { target: { value: '43' } })
    expect(screen.getByTestId('availability-capacity-form')).toBeInTheDocument()
    expect(screen.queryByTestId('availability-inventory')).not.toBeInTheDocument()
    fireEvent.change(screen.getByTestId('availability-capacity-delta'), { target: { value: '2' } })
    fireEvent.change(screen.getByTestId('availability-capacity-reason'), { target: { value: '扩容' } })
    fireEvent.click(screen.getByTestId('availability-capacity-submit'))
    await waitFor(() => expect(apiMocks.adjust).toHaveBeenCalledWith(7, 43, { delta: 2, reason: '扩容' }))
    expect(onChanged).toHaveBeenCalled()

    fireEvent.change(screen.getByTestId('availability-offer-select'), { target: { value: '44' } })
    expect(screen.getByTestId('availability-none')).toHaveTextContent('不限量')
    expect(screen.queryByRole('button', { name: /调整/ })).not.toBeInTheDocument()
  })

  it('keeps preview before confirm and targets the already-selected inventory Offer', async () => {
    render(<MerchantAvailabilityModal isOpen onClose={vi.fn()} product={product} onChanged={vi.fn()} />)
    fireEvent.click(screen.getByTestId('availability-open-import'))
    expect(screen.getByText('导入交付单元')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('交付单元内容'), { target: { value: 'secret-one' } })
    fireEvent.click(screen.getByRole('button', { name: '预览导入内容' }))
    await waitFor(() => expect(apiMocks.preview).toHaveBeenCalledWith(7, 42, { text: 'secret-one' }))
    expect(apiMocks.importInventory).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByRole('button', { name: '确认导入 1 个' }))
    await waitFor(() => expect(apiMocks.importInventory).toHaveBeenCalledWith(7, 42, { items: ['secret-one'] }))
  })
})
