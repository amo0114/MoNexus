import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import AdminFakaImportPreview from './AdminFakaImportPreview'
import AdminInventoryImportPreview from './AdminInventoryImportPreview'
import AdminPlatformProductWizard from './AdminPlatformProductWizard'
import { useAppStore } from '../../stores/appStore'

const mocks = vi.hoisted(() => ({
  categories: vi.fn(),
  adminCategories: vi.fn(),
  createPlatform: vi.fn(),
  getCatalog: vi.fn(),
  importFaka: vi.fn(),
  importInventory: vi.fn(),
  previewFaka: vi.fn(),
  previewInventory: vi.fn(),
  upload: vi.fn(),
}))

vi.mock('../../api/catalog', () => ({ catalogApi: { listActiveCategories: mocks.categories } }))
vi.mock('../../api/catalogGovernance', () => ({ catalogGovernanceApi: { listCategories: mocks.adminCategories } }))
vi.mock('../../api/admin', async () => {
  const actual = await vi.importActual<typeof import('../../api/admin')>('../../api/admin')
  return {
    ...actual,
    createAdminPlatformProduct: mocks.createPlatform,
    getAdminFakaCatalog: mocks.getCatalog,
    importAdminFakaPlan: mocks.importFaka,
    importAdminOfferInventory: mocks.importInventory,
    previewAdminFakaPlan: mocks.previewFaka,
    previewAdminOfferInventory: mocks.previewInventory,
  }
})
vi.mock('../../api/uploads', async () => {
  const actual = await vi.importActual<typeof import('../../api/uploads')>('../../api/uploads')
  return { ...actual, uploadImage: mocks.upload }
})

const categories = [{ id: 7, code: 'tools', label: '工具', iconKey: null, sortOrder: 1 }]
const catalog = {
  plans: [{
    plan_id: 42,
    name: 'Basic',
    show: true,
    sell: true,
    capacity_limit: 100,
    active_users: 2,
    remaining: 98,
    periods: [{ period: 'monthly', price: 1, sku_alias: 'plan-42-monthly' }],
    named_skus: [{ period: 'monthly', sku: 'basic-monthly' }],
  }],
}
const fakaPreview = {
  sourceHash: 'a'.repeat(64),
  capacity: { limit: 100, activeUsers: 2, remaining: 98, sellable: true },
  productName: 'Basic',
  plainDescription: 'Safe summary',
  richDescription: '<p>Safe content</p><img src="https://evil.example/a.png"><script>alert(1)</script>',
  cover: { imageUrl: '/assets/default.webp', images: ['/assets/default.webp'] },
  offers: [{ period: 'monthly', sku: 'basic-monthly', offerName: '月付', pricePoints: 100, validityDays: 30 }],
  issues: [],
  canConfirm: true,
}

describe('Catalog admin workflows (T-CAT-FE-004)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [], islandNotice: null })
    mocks.categories.mockResolvedValue(categories)
    mocks.adminCategories.mockResolvedValue({
      items: categories.map(c => ({
        ...c,
        normalizedLabel: c.label,
        description: null,
        defaultCoverUrl: '/assets/default.webp',
        status: 'active',
        createdByUserId: 1,
        updatedByUserId: 1,
        createdAt: '',
        updatedAt: '',
      })),
      total: categories.length,
      page: 1,
      pageSize: 100,
    })
    mocks.getCatalog.mockResolvedValue(catalog)
    mocks.createPlatform.mockResolvedValue({ id: 9, merchantId: null, status: 'draft' })
    mocks.previewInventory.mockResolvedValue({ totalRows: 1, validRows: 1, emptyRows: 0, duplicateRows: 0, existingDuplicateRows: 0, canImport: true })
    mocks.importInventory.mockResolvedValue({ imported: 1 })
    mocks.previewFaka.mockResolvedValue(fakaPreview)
    mocks.importFaka.mockResolvedValue({ productId: 10, offerCount: 1, replayed: false })
  })

  it('creates only a platform draft payload and keeps category orthogonal to delivery mode', async () => {
    const onCreated = vi.fn()
    render(<AdminPlatformProductWizard open onClose={vi.fn()} onCreated={onCreated} />)
    await screen.findByRole('option', { name: '工具' })

    fireEvent.change(screen.getByTestId('admin-platform-name'), { target: { value: '平台工具' } })
    fireEvent.change(screen.getByTestId('admin-platform-delivery'), { target: { value: 'manual_service' } })
    fireEvent.change(screen.getByTestId('product-category-select'), { target: { value: '7' } })
    expect(screen.getByTestId('admin-platform-delivery')).toHaveValue('manual_service')
    fireEvent.change(screen.getByTestId('admin-platform-price'), { target: { value: '100' } })
    fireEvent.click(screen.getByTestId('admin-platform-submit'))

    await waitFor(() => expect(mocks.createPlatform).toHaveBeenCalled())
    const payload = mocks.createPlatform.mock.calls[0][0]
    expect(payload).toMatchObject({ name: '平台工具', categoryId: 7, price: 100, deliveryMode: 'manual_service', stockMode: 'limited' })
    expect(payload).not.toHaveProperty('merchantId')
    expect(payload).not.toHaveProperty('isHot')
    expect(payload).not.toHaveProperty('stock')
    expect(onCreated).toHaveBeenCalledWith(9)
    expect(screen.queryByText(/认证开关|热卖开关|精选开关/)).not.toBeInTheDocument()
  })

  it('requires explicit Offer preview before admin inventory confirm', async () => {
    render(<AdminInventoryImportPreview open onClose={vi.fn()} onImported={vi.fn()} product={{
      id: 7,
      name: '多规格商品',
      offers: [
        { id: 41, name: '月卡', status: 'active' },
        { id: 42, name: '季卡', status: 'active' },
      ],
    }} />)
    fireEvent.change(screen.getByTestId('admin-import-offer-select'), { target: { value: '42' } })
    fireEvent.change(screen.getByTestId('admin-import-inventory-text'), { target: { value: 'secret-one' } })
    expect(screen.queryByTestId('admin-import-inventory-confirm')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('admin-import-inventory-preview'))
    await waitFor(() => expect(mocks.previewInventory).toHaveBeenCalledWith(7, 42, { text: 'secret-one' }))
    await screen.findByTestId('admin-import-inventory-confirm')
    fireEvent.change(screen.getByTestId('admin-import-inventory-text'), { target: { value: 'secret-two' } })
    expect(screen.queryByTestId('admin-import-inventory-confirm')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('admin-import-inventory-preview'))
    fireEvent.click(await screen.findByTestId('admin-import-inventory-confirm'))
    await waitFor(() => expect(mocks.importInventory).toHaveBeenCalledWith(7, 42, { items: ['secret-two'] }))
  })

  it('invalidates Xboard preview after any source request edit and confirms with one idempotency key', async () => {
    const onImported = vi.fn()
    render(<AdminFakaImportPreview open onClose={vi.fn()} onImported={onImported} />)
    await screen.findByRole('option', { name: /#42 Basic/ })
    fireEvent.change(screen.getByTestId('admin-faka-import-plan'), { target: { value: '42' } })
    fireEvent.change(screen.getByTestId('product-category-select'), { target: { value: '7' } })
    fireEvent.click(screen.getByTestId('admin-faka-import-preview-submit'))

    const result = await screen.findByTestId('admin-faka-preview-result')
    const rich = within(result).getByTestId('admin-faka-rich-preview')
    expect(rich).toHaveTextContent('Safe content')
    expect(rich.querySelector('script')).toBeNull()
    expect(rich.querySelector('img')).toBeNull()
    expect(mocks.importFaka).not.toHaveBeenCalled()

    fireEvent.change(screen.getByTestId('admin-faka-import-name'), { target: { value: 'Changed' } })
    expect(screen.queryByTestId('admin-faka-preview-result')).not.toBeInTheDocument()
    expect(screen.queryByTestId('admin-faka-import-submit')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('admin-faka-import-preview-submit'))
    fireEvent.click(await screen.findByTestId('admin-faka-import-submit'))
    await waitFor(() => expect(mocks.importFaka).toHaveBeenCalled())
    const [request, key] = mocks.importFaka.mock.calls[0]
    expect(request).toMatchObject({
      planId: 42,
      productName: 'Changed',
      categoryId: 7,
      cover: { mode: 'category_default' },
      sourceHash: 'a'.repeat(64),
    })
    expect(key).toMatch(/^[A-Za-z0-9._:-]{1,128}$/)
    expect(onImported).toHaveBeenCalledWith(10)
  })

  it('forces a new preview when Xboard reports source change', async () => {
    mocks.importFaka.mockRejectedValueOnce({ response: { data: { error: { code: 'FAKA_SOURCE_CHANGED', message: 'changed' } } } })
    render(<AdminFakaImportPreview open onClose={vi.fn()} onImported={vi.fn()} />)
    await screen.findByRole('option', { name: /#42 Basic/ })
    fireEvent.change(screen.getByTestId('admin-faka-import-plan'), { target: { value: '42' } })
    fireEvent.change(screen.getByTestId('product-category-select'), { target: { value: '7' } })
    fireEvent.click(screen.getByTestId('admin-faka-import-preview-submit'))
    fireEvent.click(await screen.findByTestId('admin-faka-import-submit'))
    await waitFor(() => expect(screen.queryByTestId('admin-faka-preview-result')).not.toBeInTheDocument())
    expect(screen.getByTestId('admin-faka-import-preview-submit')).toBeInTheDocument()
  })

  it('disables Xboard confirm when preview has no valid cover', async () => {
    mocks.previewFaka.mockResolvedValueOnce({
      ...fakaPreview,
      cover: null,
      issues: [{ code: 'COVER_INVALID', field: 'cover', message: '分类没有默认封面', action: 'set_category_cover' }],
      canConfirm: false,
    })
    render(<AdminFakaImportPreview open onClose={vi.fn()} onImported={vi.fn()} />)
    await screen.findByRole('option', { name: /#42 Basic/ })
    fireEvent.change(screen.getByTestId('admin-faka-import-plan'), { target: { value: '42' } })
    fireEvent.change(screen.getByTestId('product-category-select'), { target: { value: '7' } })
    fireEvent.click(screen.getByTestId('admin-faka-import-preview-submit'))
    expect(await screen.findByTestId('admin-faka-import-submit')).toBeDisabled()
    // AC-UX-022: the default DOM shows the projected user message, never the
    // raw stable code; the code stays available on the data attribute.
    const issues = screen.getByTestId('admin-faka-preview-issues')
    expect(issues).not.toHaveTextContent('COVER_INVALID')
    expect(issues).toHaveTextContent('所选分类还没有默认封面')
    expect(issues.querySelector('[data-code="COVER_INVALID"]')).not.toBeNull()
  })

  it('surfaces the existing Product returned by an external identity conflict', async () => {
    mocks.importFaka.mockRejectedValueOnce({
      response: { data: { error: {
        code: 'CONFLICT',
        message: '该 Xboard 套餐已导入',
        details: [{ field: 'existingProductId', message: '55' }],
      } } },
    })
    const onImported = vi.fn()
    render(<AdminFakaImportPreview open onClose={vi.fn()} onImported={onImported} />)
    await screen.findByRole('option', { name: /#42 Basic/ })
    fireEvent.change(screen.getByTestId('admin-faka-import-plan'), { target: { value: '42' } })
    fireEvent.change(screen.getByTestId('product-category-select'), { target: { value: '7' } })
    fireEvent.click(screen.getByTestId('admin-faka-import-preview-submit'))
    fireEvent.click(await screen.findByTestId('admin-faka-import-submit'))
    const existing = await screen.findByTestId('admin-faka-existing-product')
    expect(existing).toHaveTextContent('#55')
    fireEvent.click(existing)
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(55))
  })

  it('treats an idempotent replay as success without asking for a new request', async () => {
    mocks.importFaka.mockResolvedValueOnce({ productId: 77, replayed: true })
    const onImported = vi.fn()
    render(<AdminFakaImportPreview open onClose={vi.fn()} onImported={onImported} />)
    await screen.findByRole('option', { name: /#42 Basic/ })
    fireEvent.change(screen.getByTestId('admin-faka-import-plan'), { target: { value: '42' } })
    fireEvent.change(screen.getByTestId('product-category-select'), { target: { value: '7' } })
    fireEvent.click(screen.getByTestId('admin-faka-import-preview-submit'))
    fireEvent.click(await screen.findByTestId('admin-faka-import-submit'))
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(77))
    expect(useAppStore.getState().toasts.some((toast) => toast.message.includes('幂等重放'))).toBe(true)
    expect(mocks.importFaka).toHaveBeenCalledTimes(1)
  })
})

describe('Xboard cover loop (SPEC-CMI-UX-001 §5.5, T-UX-004)', () => {
  it('sends the uploaded objectKey (never a URL) in the preview request (AC-UX-010)', async () => {
    mocks.upload.mockResolvedValue({ key: 'uploaded-cover.webp', url: 'http://localhost:3000/uploads/uploaded-cover.webp' })
    render(<AdminFakaImportPreview open onClose={vi.fn()} onImported={vi.fn()} />)
    await screen.findByRole('option', { name: /#42 Basic/ })
    fireEvent.change(screen.getByTestId('admin-faka-import-plan'), { target: { value: '42' } })
    fireEvent.change(screen.getByTestId('product-category-select'), { target: { value: '7' } })
    fireEvent.click(await screen.findByLabelText('上传平台托管封面'))
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [new File(['x'], 'cover.webp', { type: 'image/webp' })] } })
    // Wait until the upload draft is committed (coverMode=uploaded + preview).
    await waitFor(() => expect(screen.getByTestId('admin-faka-uploaded-cover-preview')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('admin-faka-import-preview-submit'))
    await waitFor(() => expect(mocks.previewFaka).toHaveBeenCalled())
    const payload = mocks.previewFaka.mock.calls.at(-1)![0]
    expect(payload.cover).toEqual({ mode: 'uploaded', objectKey: 'uploaded-cover.webp' })
    expect(JSON.stringify(payload)).not.toContain('http://localhost:3000')
  })

  it('explicit cancel clears the uploaded-cover draft (D-UX-13)', async () => {
    mocks.upload.mockResolvedValue({ key: 'draft-cover.webp', url: 'http://localhost:3000/uploads/draft-cover.webp' })
    function Harness() {
      const [open, setOpen] = React.useState(true)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>reopen</button>
          <AdminFakaImportPreview open={open} onClose={() => setOpen(false)} onImported={vi.fn()} />
        </>
      )
    }
    render(<Harness />)
    await screen.findByRole('option', { name: /#42 Basic/ })
    fireEvent.change(screen.getByTestId('admin-faka-import-plan'), { target: { value: '42' } })
    fireEvent.change(screen.getByTestId('product-category-select'), { target: { value: '7' } })
    fireEvent.click(await screen.findByLabelText('上传平台托管封面'))
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(fileInput, { target: { files: [new File(['x'], 'cover.webp', { type: 'image/webp' })] } })
    await waitFor(() => expect(screen.getByTestId('admin-faka-uploaded-cover-preview')).toBeInTheDocument())

    // Explicit 取消 → draft cleared + dialog closes.
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.click(screen.getByRole('button', { name: 'reopen' }))
    await screen.findByRole('option', { name: /#42 Basic/ })
    fireEvent.change(screen.getByTestId('admin-faka-import-plan'), { target: { value: '42' } })
    fireEvent.change(screen.getByTestId('product-category-select'), { target: { value: '7' } })
    fireEvent.click(await screen.findByLabelText('上传平台托管封面'))
    expect(screen.queryByTestId('admin-faka-uploaded-cover-preview')).not.toBeInTheDocument()
  })
})
