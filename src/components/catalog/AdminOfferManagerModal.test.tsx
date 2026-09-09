import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminOfferManagerModal from './AdminOfferManagerModal'
import type { AdminProductListItem } from '../../api/admin'

const mocks = vi.hoisted(() => ({
  archiveAdminOffer: vi.fn(),
  makeDefaultAdminOffer: vi.fn(),
  restoreAdminOffer: vi.fn(),
  createPlatformOffer: vi.fn(),
  patchPlatformOffer: vi.fn(),
  uploadDeliveryFile: vi.fn(),
  getAdminProductEditor: vi.fn(),
}))

vi.mock('../../stores/appStore', () => ({
  useAppStore: (selector: (state: {
    showToast: () => void
    modalOpened: () => void
    modalClosed: () => void
  }) => unknown) => selector({
    showToast: vi.fn(),
    modalOpened: vi.fn(),
    modalClosed: vi.fn(),
  }),
}))

vi.mock('../../api/admin', () => ({
  archiveAdminOffer: mocks.archiveAdminOffer,
  makeDefaultAdminOffer: mocks.makeDefaultAdminOffer,
  restoreAdminOffer: mocks.restoreAdminOffer,
}))

vi.mock('../../api/adminOffers', () => ({
  createPlatformOffer: mocks.createPlatformOffer,
  patchPlatformOffer: mocks.patchPlatformOffer,
  uploadDeliveryFile: mocks.uploadDeliveryFile,
  getAdminProductEditor: mocks.getAdminProductEditor,
}))

const product: AdminProductListItem = {
  id: 7,
  name: '规格商品',
  status: 'inactive',
  merchantId: null,
  archivedAt: null,
  offers: [
    { id: 1, name: '在售', price: 1000, status: 'active', isDefault: true, validityDays: 30, deliveryMode: 'instant_inventory', stockMode: 'limited', sortOrder: 0 },
    { id: 2, name: '已归档', price: 2000, status: 'inactive', isDefault: false, validityDays: 90 },
    { id: 3, name: '可设默认', price: 1500, status: 'active', isDefault: false, validityDays: 60 },
  ],
} as AdminProductListItem

describe('AdminOfferManagerModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getAdminProductEditor.mockResolvedValue({
      offers: [
        {
          id: 1,
          name: '在售',
          price: 1000,
          originalPrice: null,
          status: 'active',
          sortOrder: 0,
          isDefault: true,
          deliveryMode: 'instant_inventory',
          stockMode: 'limited',
          stock: 0,
          validityDays: 30,
          fixedContentType: 'text',
          fixedFileId: null,
          deliveryFields: null,
          autoProvision: false,
          attributes: {},
          fixedContent: null,
        },
      ],
    })
    mocks.createPlatformOffer.mockResolvedValue({ id: 9 })
    mocks.patchPlatformOffer.mockResolvedValue({ id: 1 })
    mocks.uploadDeliveryFile.mockResolvedValue({ id: 88, fileName: 'pack.zip', size: 12 })
  })

  it('hides 设为默认 on archived offers', () => {
    render(<AdminOfferManagerModal product={product} onClose={() => undefined} onChanged={() => undefined} />)
    expect(screen.queryByTestId('admin-offer-make-default-2')).toBeNull()
    expect(screen.getByTestId('admin-offer-make-default-3')).toBeTruthy()
  })

  it('creates a file-form offer after uploading and POSTs fixedFileId', async () => {
    render(<AdminOfferManagerModal product={product} onClose={() => undefined} onChanged={() => undefined} />)
    fireEvent.click(screen.getByTestId('admin-offer-create'))
    fireEvent.change(screen.getByTestId('admin-offer-form-name'), { target: { value: '文件版' } })
    fireEvent.change(screen.getByTestId('admin-offer-form-price'), { target: { value: '120' } })
    fireEvent.change(screen.getByTestId('admin-offer-form-delivery-mode'), { target: { value: 'instant_fixed' } })
    fireEvent.change(screen.getByTestId('admin-offer-form-fixed-content-type'), { target: { value: 'file' } })
    fireEvent.change(screen.getByTestId('admin-offer-file-input'), {
      target: { files: [new File(['paid'], 'pack.zip', { type: 'application/zip' })] },
    })

    await waitFor(() => expect(mocks.uploadDeliveryFile).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText(/pack\.zip/)).toBeTruthy())
    fireEvent.click(screen.getByTestId('admin-offer-form-save'))

    await waitFor(() => expect(mocks.createPlatformOffer).toHaveBeenCalledTimes(1))
    expect(mocks.createPlatformOffer).toHaveBeenCalledWith(7, expect.objectContaining({
      name: '文件版',
      price: 120,
      deliveryMode: 'instant_fixed',
      stockMode: 'unlimited',
      fixedContentType: 'file',
      fixedContent: null,
      fixedFileId: 88,
      autoProvision: false,
    }))
  })

  it('patches delivery fields on an existing platform offer', async () => {
    render(<AdminOfferManagerModal product={product} onClose={() => undefined} onChanged={() => undefined} />)
    fireEvent.click(screen.getByTestId('admin-offer-edit-1'))
    await waitFor(() => expect(screen.getByTestId('admin-offer-form-save')).not.toBeDisabled())

    fireEvent.change(screen.getByTestId('admin-offer-form-delivery-mode'), { target: { value: 'instant_fixed' } })
    fireEvent.change(screen.getByTestId('admin-offer-form-fixed-content-type'), { target: { value: 'text' } })
    fireEvent.change(screen.getByTestId('admin-offer-form-fixed-content'), { target: { value: 'FIXED-KEY' } })
    fireEvent.click(screen.getByTestId('admin-offer-form-save'))

    await waitFor(() => expect(mocks.patchPlatformOffer).toHaveBeenCalledTimes(1))
    expect(mocks.patchPlatformOffer).toHaveBeenCalledWith(7, 1, expect.objectContaining({
      name: '在售',
      price: 1000,
      deliveryMode: 'instant_fixed',
      stockMode: 'unlimited',
      fixedContentType: 'text',
      fixedContent: 'FIXED-KEY',
      fixedFileId: null,
    }))
  })
})
