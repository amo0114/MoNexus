import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import MerchantProductFormModal from './MerchantProductFormModal'
import { createCatalogAdapter } from '../../api/catalog'
import {
  catalogFixtureCategories,
  createCatalogFixtureTransport,
} from '../../api/catalog.fixtures'
import type { MerchantProduct } from '../../types/merchant'
import { useAppStore } from '../../stores/appStore'

/**
 * MerchantProductFormModal edit-path wiring (T-CAT-FE-001B).
 *
 * Asserts the modal is orthogonal (categoryId never auto-switches the
 * deliveryMode and vice versa) and that the submitted payload is the explicit
 * whitelist: categoryId instead of the legacy type, no isHot, no stock.
 */
const deliveryModes = [
  { value: 'instant_inventory', label: '交付库存' },
  { value: 'instant_fixed', label: '固定内容' },
  { value: 'manual_service', label: '人工服务' },
]

function seedRegistry() {
  useAppStore.setState({
    registry: {
      productTypes: [],
      deliveryModes,
      orderStatuses: [],
      settlementStatuses: [],
      pagination: { defaultPageSize: 20, maxPageSize: 100 },
      inventory: { lowStockThreshold: 5 },
    },
  })
}

/** Legacy product: no categoryId — resolved from the historical type label. */
const product: MerchantProduct = {
  id: 1,
  merchantId: 7,
  name: '节点套餐',
  description: '简介',
  richDescription: '<p>详情</p>',
  type: '网络节点',
  icon: 'Globe',
  imageUrl: '/uploads/a.webp',
  images: ['/uploads/a.webp'],
  price: 100,
  originalPrice: 120,
  stock: 0,
  sales: 0,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  deliveryMode: 'instant_inventory',
  stockMode: 'limited',
  purchaseForm: [],
}

function renderModal(onSubmit: ReturnType<typeof vi.fn>) {
  const transport = createCatalogFixtureTransport({
    get: { '/config/registry': { productCategories: catalogFixtureCategories } },
  })
  render(
    <MerchantProductFormModal
      isOpen
      onClose={vi.fn()}
      onSubmit={onSubmit}
      product={product}
      adapter={createCatalogAdapter(transport)}
    />,
  )
  return transport
}

describe('MerchantProductFormModal edit path (T-CAT-FE-001B)', () => {
  beforeEach(() => {
    seedRegistry()
  })

  it('submits a categoryId-based whitelist payload with no type/isHot/stock', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    renderModal(onSubmit)

    // Async category registry resolves the legacy type label → categoryId 1.
    const categorySelect = screen.getByTestId('product-category-select')
    await waitFor(() => expect(categorySelect).not.toBeDisabled())
    await waitFor(() => expect(categorySelect).toHaveValue('1'))

    fireEvent.submit(document.querySelector('#productForm') as HTMLFormElement)

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const payload = onSubmit.mock.calls[0][0] as Record<string, unknown>
    expect(payload.name).toBe('节点套餐')
    expect(payload.categoryId).toBe(1)
    expect(payload.deliveryMode).toBe('instant_inventory')
    expect(payload.originalPrice).toBe(120)
    // Explicit whitelist: categoryId replaces type; isHot/stock are removed.
    expect('type' in payload).toBe(false)
    expect('isHot' in payload).toBe(false)
    expect('stock' in payload).toBe(false)
  })

  it('keeps category and delivery mode orthogonal (D-CAT-05)', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    renderModal(onSubmit)

    const categorySelect = screen.getByTestId('product-category-select')
    await waitFor(() => expect(categorySelect).not.toBeDisabled())
    await waitFor(() => expect(categorySelect).toHaveValue('1'))

    // Changing the category must not touch the delivery mode.
    fireEvent.change(categorySelect, { target: { value: '2' } }) // 共享账号
    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="deliveryMode"]'))
    expect(radios.find(r => r.checked)?.value).toBe('instant_inventory')

    // Changing the delivery mode must not touch the category.
    fireEvent.change(radios.find(r => r.value === 'manual_service')!, { target: { value: 'manual_service' } })
    expect(screen.getByTestId('product-category-select')).toHaveValue('2')
  })
})
