import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminPage from './AdminPage'
import { useAppStore } from '../stores/appStore'

const mocks = vi.hoisted(() => ({
  getProducts: vi.fn(),
  readiness: vi.fn(),
  publish: vi.fn(),
  unpublish: vi.fn(),
  archive: vi.fn(),
  restore: vi.fn(),
}))

vi.mock('../components/merchandising/AdminMerchandisingPage', () => ({
  default: function MockAdminMerchandisingPage() {
    return <div data-testid="merchandising-page-marker">AdminMerchandisingPage</div>
  },
}))

vi.mock('../components/catalog/AdminCategoryManager', () => ({
  default: function MockAdminCategoryManager() {
    return <div data-testid="catalog-governance-page-marker">AdminCategoryManager</div>
  },
}))

vi.mock('../components/catalog/AdminFakaImportPreview', () => ({
  default: function MockAdminFakaImportPreview({
    open,
    onImported,
  }: {
    open: boolean
    onImported: (result: { productId: number; productName: string; origin: 'xboard-import' }) => void
  }) {
    if (!open) return null
    return (
      <button
        type="button"
        data-testid="mock-faka-imported"
        onClick={() => onImported({
          productId: 11,
          productName: 'Gold Plan',
          origin: 'xboard-import',
        })}
      >
        mock imported
      </button>
    )
  },
}))

vi.mock('../api/client', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (url === '/admin/stats') {
        return Promise.resolve({ data: { users: 1, orders: 1, totalPoints: 1 } })
      }
      if (url === '/admin/reports/offers') {
        return Promise.resolve({ data: { items: [] } })
      }
      return Promise.resolve({ data: {} })
    }),
  },
}))

vi.mock('../api/admin', async () => {
  const actual = await vi.importActual<typeof import('../api/admin')>('../api/admin')
  return {
    ...actual,
    getAdminProducts: mocks.getProducts,
    getAdminProductReadiness: mocks.readiness,
    publishAdminProduct: mocks.publish,
    unpublishAdminProduct: mocks.unpublish,
    archiveAdminProduct: mocks.archive,
    restoreAdminProduct: mocks.restore,
  }
})

const products = [
  {
    id: 11,
    name: 'Gold Plan',
    status: 'draft',
    merchantId: null,
    type: '网络节点',
    price: 100,
    offers: [{ id: 42, name: '月付' }],
    fakaBridge: true,
  },
  {
    id: 12,
    name: '已上架平台商品',
    status: 'active',
    merchantId: null,
    type: '网络节点',
    price: 200,
    offers: [{ id: 43, name: '年付' }],
  },
  {
    id: 13,
    name: '已下架平台商品',
    status: 'inactive',
    merchantId: null,
    type: '网络节点',
    price: 150,
    offers: [{ id: 44, name: '季付' }],
  },
  {
    id: 14,
    name: '商家草稿',
    status: 'draft',
    merchantId: 9,
    type: '网络节点',
    price: 80,
    offers: [{ id: 45, name: '默认规格' }],
  },
  {
    id: 15,
    name: '未知状态商品',
    status: 'archived',
    merchantId: null,
    type: '网络节点',
    price: 10,
    offers: [],
  },
]

const toPaged = (items: typeof products) => ({ items, total: items.length, page: 1, pageSize: 20 })

async function openProducts() {
  render(<AdminPage />)
  expect(await screen.findByText('注册用户总数')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '商品与库存' }))
  expect(await screen.findByText('Gold Plan')).toBeInTheDocument()
}

describe('AdminPage product publication workflow (T-APUB-004/005)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [], islandNotice: null })
    mocks.getProducts.mockResolvedValue(toPaged(products))
    mocks.readiness.mockResolvedValue({ ready: true, productId: 11, issues: [] })
    mocks.publish.mockResolvedValue({ id: 11, status: 'active', publishedAt: '2026-08-17T00:00:00.000Z' })
    mocks.unpublish.mockResolvedValue({ id: 12, status: 'inactive', publishedAt: '2026-08-17T00:00:00.000Z' })
    mocks.archive.mockResolvedValue({ mode: 'archived', productId: 12, status: 'inactive', archivedAt: '2026-09-01T00:00:00.000Z' })
    mocks.restore.mockResolvedValue({ productId: 12, status: 'inactive', archivedAt: null })
    vi.spyOn(window, 'confirm').mockReset()
  })

  it('shows user-facing statuses and only platform publication actions (AC-APUB-003/004)', async () => {
    await openProducts()

    expect(screen.getByTestId('admin-product-status-11')).toHaveTextContent('草稿')
    expect(screen.getByTestId('admin-product-status-12')).toHaveTextContent('已发布')
    expect(screen.getByTestId('admin-product-status-13')).toHaveTextContent('已下架')
    expect(screen.getByTestId('admin-product-status-15')).toHaveTextContent('状态未知')
    expect(screen.getByTestId('admin-product-status-15')).not.toHaveTextContent('archived')

    expect(screen.getByTestId('admin-product-publish-11')).toHaveTextContent('发布')
    expect(screen.getByTestId('admin-product-relist-13')).toHaveTextContent('重新上架')
    expect(screen.getByTestId('admin-product-unpublish-12')).toHaveTextContent('下架')
    expect(screen.getByTestId('admin-product-merchant-owned-14')).toHaveTextContent('由商家管理')
    expect(screen.queryByTestId('admin-product-publish-14')).not.toBeInTheDocument()
    expect(screen.queryByTestId('admin-product-unpublish-14')).not.toBeInTheDocument()
    expect(screen.queryByTestId('admin-product-relist-14')).not.toBeInTheDocument()
    expect(screen.getByTestId('admin-edit-product-11')).toHaveTextContent('编辑')
    expect(screen.getByTestId('admin-archive-product-11')).toHaveTextContent('归档')
    expect(screen.queryByTestId('admin-delete-product-11')).not.toBeInTheDocument()
  })

  it('archives from the product row and does not call delete', async () => {
    mocks.getProducts.mockResolvedValueOnce(toPaged(products)).mockResolvedValueOnce(toPaged(products.filter((item) => item.id !== 12)))
    await openProducts()
    fireEvent.click(screen.getByTestId('admin-archive-product-12'))
    fireEvent.click(await screen.findByRole('button', { name: '确认归档' }))
    await waitFor(() => expect(mocks.archive).toHaveBeenCalledWith(12))
    expect(useAppStore.getState().toasts.some((toast) => toast.message.includes('已归档'))).toBe(true)
  })

  it('opens readiness for a platform draft and reloads after publish (AC-APUB-005/006/011)', async () => {
    mocks.getProducts
      .mockResolvedValueOnce(toPaged(products))
      .mockResolvedValueOnce(toPaged(products.map((item) => (
        item.id === 11 ? { ...item, status: 'active' } : item
      ))))
    await openProducts()
    fireEvent.click(screen.getByTestId('admin-product-publish-11'))
    await waitFor(() => expect(mocks.readiness).toHaveBeenCalledWith(11))
    fireEvent.click(await screen.findByTestId('publication-publish'))
    await waitFor(() => expect(mocks.publish).toHaveBeenCalledWith(11))
    await waitFor(() => expect(mocks.getProducts).toHaveBeenCalledTimes(2))
    expect(await screen.findByTestId('admin-product-status-11')).toHaveTextContent('已发布')
    expect(useAppStore.getState().toasts.some((toast) => toast.message.includes('已发布到商城'))).toBe(true)
  })

  it('cancels unpublish with zero requests and confirms with a reload (AC-APUB-010/011)', async () => {
    await openProducts()
    fireEvent.click(screen.getByTestId('admin-product-unpublish-12'))
    expect(await screen.findByText(/下架后商品将从商城隐藏/)).toBeInTheDocument()
    expect(screen.getByText(/已有订单和可售资源不会删除/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(mocks.unpublish).not.toHaveBeenCalled()

    mocks.getProducts.mockResolvedValueOnce(toPaged(products.map((item) => (
      item.id === 12 ? { ...item, status: 'inactive' } : item
    ))))
    fireEvent.click(screen.getByTestId('admin-product-unpublish-12'))
    fireEvent.click(await screen.findByRole('button', { name: '确认下架' }))
    await waitFor(() => expect(mocks.unpublish).toHaveBeenCalledWith(12))
    await waitFor(() => expect(screen.getByTestId('admin-product-status-12')).toHaveTextContent('已下架'))
    expect(useAppStore.getState().toasts.some((toast) => toast.message.includes('已下架'))).toBe(true)
    expect(useAppStore.getState().toasts.some((toast) => /删除订单|删除资源/.test(toast.message))).toBe(false)
  })

  it('keeps unpublish in-flight to one request per product (AC-APUB-013)', async () => {
    let resolveUnpublish: ((value: unknown) => void) | undefined
    mocks.unpublish.mockImplementation(
      () => new Promise((resolve) => { resolveUnpublish = resolve }),
    )
    await openProducts()
    fireEvent.click(screen.getByTestId('admin-product-unpublish-12'))
    fireEvent.click(await screen.findByRole('button', { name: '确认下架' }))
    expect(screen.getByTestId('admin-product-publish-11')).toBeEnabled()
    expect(mocks.unpublish).toHaveBeenCalledTimes(1)
    resolveUnpublish?.({ id: 12, status: 'inactive', publishedAt: '2026-08-17T00:00:00.000Z' })
    await waitFor(() => expect(mocks.unpublish).toHaveBeenCalledTimes(1))
  })

  it('keeps the unpublish control locked until the list refresh finishes', async () => {
    let resolveList: ((value: unknown) => void) | undefined
    mocks.getProducts
      .mockResolvedValueOnce(toPaged(products))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveList = resolve }))
    await openProducts()
    fireEvent.click(screen.getByTestId('admin-product-unpublish-12'))
    fireEvent.click(await screen.findByRole('button', { name: '确认下架' }))
    await waitFor(() => expect(mocks.unpublish).toHaveBeenCalledTimes(1))
    const button = screen.getByTestId('admin-product-unpublish-12')
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('下架中…')
    expect(screen.getByTestId('admin-product-status-12')).toHaveTextContent('已发布')
    fireEvent.click(button)
    expect(mocks.unpublish).toHaveBeenCalledTimes(1)
    resolveList?.(toPaged(products.map((item) => (
      item.id === 12 ? { ...item, status: 'inactive' } : item
    ))))
    await waitFor(() => expect(screen.getByTestId('admin-product-status-12')).toHaveTextContent('已下架'))
    expect(screen.queryByTestId('admin-product-unpublish-12')).not.toBeInTheDocument()
  })

  it('ignores a stale products reload and disables retry while a newer refresh is in flight', async () => {
    let resolveStale: ((value: unknown) => void) | undefined
    mocks.getProducts
      .mockResolvedValueOnce(toPaged(products))
      .mockRejectedValueOnce(new Error('network'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve }))
      .mockResolvedValueOnce(toPaged(products.map((item) => (
        item.id === 12 ? { ...item, status: 'inactive' } : item
      ))))
    await openProducts()
    fireEvent.click(screen.getByTestId('admin-product-unpublish-12'))
    fireEvent.click(await screen.findByRole('button', { name: '确认下架' }))
    expect(await screen.findByTestId('admin-products-refresh-retry')).toBeEnabled()
    fireEvent.click(screen.getByTestId('admin-products-refresh-retry'))
    expect(screen.getByTestId('admin-products-refresh-retry')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '数据仪表盘' }))
    expect(await screen.findByText('注册用户总数')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '商品与库存' }))
    resolveStale?.(toPaged(products))
    await waitFor(() => expect(screen.getByTestId('admin-product-status-12')).toHaveTextContent('已下架'))
    expect(screen.queryByTestId('admin-products-refresh-error')).not.toBeInTheDocument()
  })

  it('hands a successful XBoard import to readiness and does not auto-publish (AC-APUB-001/002/009)', async () => {
    await openProducts()
    fireEvent.click(screen.getByTestId('admin-faka-import-open'))
    fireEvent.click(screen.getByTestId('mock-faka-imported'))
    await waitFor(() => expect(mocks.readiness).toHaveBeenCalledWith(11))
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(screen.getByTestId('admin-publication-dialog')).toHaveTextContent('商品已导入，准备发布')
    fireEvent.click(screen.getByTestId('admin-publication-later'))
    await waitFor(() => expect(screen.queryByTestId('admin-publication-dialog')).not.toBeInTheDocument())
    expect(screen.getByTestId('admin-product-publish-11')).toBeInTheDocument()
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it('does not close publish or keep stale write actions when list refresh fails', async () => {
    mocks.getProducts
      .mockResolvedValueOnce(toPaged(products))
      .mockRejectedValueOnce(new Error('network'))
    await openProducts()
    fireEvent.click(screen.getByTestId('admin-product-publish-11'))
    fireEvent.click(await screen.findByTestId('publication-publish'))
    expect(await screen.findByTestId('admin-publication-refresh-error')).toBeInTheDocument()
    expect(screen.getByTestId('admin-publication-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('admin-product-status-11')).toHaveTextContent('草稿')
    expect(useAppStore.getState().toasts.some((toast) => toast.message.includes('已发布到商城') && toast.message.includes('刷新失败'))).toBe(true)
  })

  it('disables stale write actions and retries the list after a successful unpublish refresh failure', async () => {
    mocks.getProducts
      .mockResolvedValueOnce(toPaged(products))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(toPaged(products.map((item) => (
        item.id === 12 ? { ...item, status: 'inactive' } : item
      ))))
    await openProducts()
    fireEvent.click(screen.getByTestId('admin-product-unpublish-12'))
    fireEvent.click(await screen.findByRole('button', { name: '确认下架' }))
    expect(await screen.findByTestId('admin-products-refresh-error')).toHaveTextContent('不是最新')
    expect(screen.getByTestId('admin-product-status-12')).toHaveTextContent('已发布')
    expect(screen.getByTestId('admin-product-unpublish-12')).toBeDisabled()
    expect(screen.getByTestId('admin-product-publish-11')).toBeDisabled()
    expect(useAppStore.getState().toasts.some((toast) => toast.message.includes('已下架') && toast.message.includes('刷新失败'))).toBe(true)

    fireEvent.click(screen.getByTestId('admin-products-refresh-retry'))
    await waitFor(() => expect(screen.getByTestId('admin-product-status-12')).toHaveTextContent('已下架'))
    expect(screen.queryByTestId('admin-products-refresh-error')).not.toBeInTheDocument()
    expect(screen.getByTestId('admin-product-publish-11')).toBeEnabled()
  })
})
