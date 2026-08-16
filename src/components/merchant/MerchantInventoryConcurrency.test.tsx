import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import MerchantInventoryImportModal from './MerchantInventoryImportModal'
import MerchantInventoryLogModal from './MerchantInventoryLogModal'
import type { InventoryLog, InventoryPreview } from '../../api/merchant'
import type { MerchantProduct, Offer } from '../../types/merchant'

const apiMocks = vi.hoisted(() => ({
  getLogs: vi.fn(),
  preview: vi.fn(),
}))

vi.mock('../../api/merchant', async () => {
  const actual = await vi.importActual<typeof import('../../api/merchant')>('../../api/merchant')
  return {
    ...actual,
    getMerchantInventoryLogs: apiMocks.getLogs,
    previewMerchantOfferInventory: apiMocks.preview,
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const offers: Offer[] = [
  { id: 41, name: '旧规格', price: 10, originalPrice: null, status: 'active', deliveryMode: 'instant_inventory', stockMode: 'limited', stock: 0 },
  { id: 42, name: '新规格', price: 20, originalPrice: null, status: 'active', deliveryMode: 'instant_inventory', stockMode: 'limited', stock: 0 },
]

function product(id: number, name: string): MerchantProduct {
  return {
    id,
    merchantId: 9,
    name,
    description: null,
    richDescription: null,
    type: '测试',
    icon: 'package',
    imageUrl: null,
    price: 10,
    originalPrice: null,
    stock: 0,
    availableStock: 0,
    sales: 0,
    status: 'active',
    createdAt: '2026-08-09T00:00:00.000Z',
    stockMode: 'limited',
    offers,
  }
}

function log(id: number, productId: number, reason: string): InventoryLog {
  return {
    id,
    productId,
    offerId: 42,
    merchantId: 9,
    actorUserId: 8,
    action: 'import',
    delta: 1,
    reason,
    orderId: null,
    batchId: null,
    createdAt: '2026-08-09T00:00:00.000Z',
  }
}

describe('merchant availability request commit ordering', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not publish an obsolete preview after the Offer or source text changes', async () => {
    const oldPreview = deferred<InventoryPreview>()
    const newPreview = deferred<InventoryPreview>()
    apiMocks.preview.mockReturnValueOnce(oldPreview.promise).mockReturnValueOnce(newPreview.promise)

    render(
      <MerchantInventoryImportModal
        isOpen
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        productName="测试商品"
        productId={7}
        offers={offers}
      />,
    )

    fireEvent.change(screen.getByLabelText('交付单元内容'), { target: { value: 'old-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '预览导入内容' }))
    fireEvent.change(screen.getByTestId('import-offer-select'), { target: { value: '42' } })
    fireEvent.change(screen.getByLabelText('交付单元内容'), { target: { value: 'new-one\nnew-two' } })
    fireEvent.click(screen.getByRole('button', { name: '预览导入内容' }))

    await act(async () => {
      newPreview.resolve({ totalRows: 2, validRows: 2, emptyRows: 0, duplicateRows: 0, existingDuplicateRows: 0, canImport: true })
    })
    expect(await screen.findByRole('button', { name: '确认导入 2 个' })).toBeInTheDocument()

    await act(async () => {
      oldPreview.resolve({ totalRows: 1, validRows: 1, emptyRows: 0, duplicateRows: 0, existingDuplicateRows: 0, canImport: true })
    })
    expect(screen.getByRole('button', { name: '确认导入 2 个' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '确认导入 1 个' })).not.toBeInTheDocument()
  })

  it('does not let an older product log response overwrite the current product', async () => {
    const oldLogs = deferred<{ items: InventoryLog[]; total: number; page: number; pageSize: number }>()
    const newLogs = deferred<{ items: InventoryLog[]; total: number; page: number; pageSize: number }>()
    apiMocks.getLogs.mockReturnValueOnce(oldLogs.promise).mockReturnValueOnce(newLogs.promise)

    const { rerender } = render(
      <MerchantInventoryLogModal isOpen onClose={vi.fn()} product={product(7, '旧商品')} />,
    )
    rerender(<MerchantInventoryLogModal isOpen onClose={vi.fn()} product={product(8, '新商品')} />)

    await act(async () => {
      newLogs.resolve({ items: [log(2, 8, 'new-log')], total: 1, page: 1, pageSize: 10 })
    })
    expect(await screen.findByText('new-log')).toBeInTheDocument()

    await act(async () => {
      oldLogs.resolve({ items: [log(1, 7, 'old-log')], total: 1, page: 1, pageSize: 10 })
    })
    await waitFor(() => expect(screen.queryByText('old-log')).not.toBeInTheDocument())
    expect(screen.getByText('new-log')).toBeInTheDocument()
  })
})
