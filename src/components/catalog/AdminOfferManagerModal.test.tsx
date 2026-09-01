import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AdminOfferManagerModal from './AdminOfferManagerModal'
import type { AdminProductListItem } from '../../api/admin'

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
  archiveAdminOffer: vi.fn(),
  makeDefaultAdminOffer: vi.fn(),
  patchAdminOffer: vi.fn(),
  restoreAdminOffer: vi.fn(),
}))

const product: AdminProductListItem = {
  id: 7,
  name: '规格商品',
  status: 'inactive',
  archivedAt: null,
  offers: [
    { id: 1, name: '在售', price: 1000, status: 'active', isDefault: true, validityDays: 30 },
    { id: 2, name: '已归档', price: 2000, status: 'inactive', isDefault: false, validityDays: 90 },
    { id: 3, name: '可设默认', price: 1500, status: 'active', isDefault: false, validityDays: 60 },
  ],
} as AdminProductListItem

describe('AdminOfferManagerModal', () => {
  it('hides 设为默认 on archived offers', () => {
    render(<AdminOfferManagerModal product={product} onClose={() => undefined} onChanged={() => undefined} />)
    expect(screen.queryByTestId('admin-offer-make-default-2')).toBeNull()
    expect(screen.getByTestId('admin-offer-make-default-3')).toBeTruthy()
  })
})
