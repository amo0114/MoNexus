import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminProductPanel from './AdminProductPanel'
import * as adminApi from '../../api/admin'
import { useAppStore } from '../../stores/appStore'

vi.mock('../../api/admin', async () => {
  const actual = await vi.importActual<typeof import('../../api/admin')>('../../api/admin')
  return {
    ...actual,
    getAdminProducts: vi.fn(),
    archiveAdminProduct: vi.fn(),
    restoreAdminProduct: vi.fn(),
    unpublishAdminProduct: vi.fn(),
    setAdminFakaCapacity: vi.fn(),
  }
})

vi.mock('../catalog/AdminPlatformProductWizard', () => ({
  default: ({ open, onCreated }: { open: boolean; onCreated?: () => void }) =>
    open ? (
      <div data-testid="mock-platform-wizard">
        <button type="button" data-testid="mock-wizard-created" onClick={onCreated}>
          Trigger Created
        </button>
      </div>
    ) : null,
}))

vi.mock('../catalog/AdminFakaImportPreview', () => ({
  default: () => null,
}))
vi.mock('../catalog/AdminProductPublicationDialog', () => ({
  default: () => null,
}))
vi.mock('../catalog/AdminProductEditDialog', () => ({
  default: () => null,
}))
vi.mock('../catalog/AdminOfferManagerModal', () => ({
  default: () => null,
}))
vi.mock('../catalog/AdminFakaSyncDialog', () => ({
  default: () => null,
}))
vi.mock('../catalog/AdminInventoryImportPreview', () => ({
  default: () => null,
}))

const sampleProductList: adminApi.AdminProductListItem[] = [
  {
    id: 1,
    name: 'Standard VPN Node',
    type: '网络节点',
    price: 100,
    stock: 10,
    status: 'active',
    merchantId: null,
    offers: [{ id: 101, name: 'Monthly', price: 100, isDefault: true }],
  },
  {
    id: 2,
    name: 'Premium Cloud Server',
    type: '云主机',
    price: 500,
    stock: 5,
    status: 'draft',
    merchantId: null,
    offers: [{ id: 102, name: 'Yearly', price: 500, isDefault: true }],
  },
]

describe('AdminProductPanel (PR 04)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState({ toasts: [] })
  })

  it('renders loading skeleton and loads initial products with default pagination', async () => {
    vi.mocked(adminApi.getAdminProducts).mockResolvedValueOnce({
      items: sampleProductList,
      total: 2,
      page: 1,
      pageSize: 20,
    })

    render(<AdminProductPanel active={true} />)

    expect(await screen.findByText('Standard VPN Node')).toBeInTheDocument()
    expect(screen.getByText('Premium Cloud Server')).toBeInTheDocument()
    expect(screen.getByTestId('admin-products-pagination')).toBeInTheDocument()

    expect(adminApi.getAdminProducts).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
      archived: 'exclude',
    })
  })

  it('preserves draft filters and only queries on clicking search button', async () => {
    vi.mocked(adminApi.getAdminProducts).mockResolvedValue({
      items: sampleProductList,
      total: 2,
      page: 1,
      pageSize: 20,
    })

    render(<AdminProductPanel active={true} />)
    expect(await screen.findByText('Standard VPN Node')).toBeInTheDocument()
    expect(adminApi.getAdminProducts).toHaveBeenCalledTimes(1)

    // Edit search inputs (draft state)
    const searchInput = screen.getByTestId('admin-products-search-input')
    const statusFilter = screen.getByTestId('admin-products-status-filter')
    const archivedFilter = screen.getByTestId('admin-products-archived-filter')

    fireEvent.change(searchInput, { target: { value: 'VPN' } })
    fireEvent.change(statusFilter, { target: { value: 'active' } })
    fireEvent.change(archivedFilter, { target: { value: 'only' } })

    // No immediate extra API call
    expect(adminApi.getAdminProducts).toHaveBeenCalledTimes(1)

    // Click search button
    const searchBtn = screen.getByTestId('admin-products-search-btn')
    fireEvent.click(searchBtn)

    await waitFor(() => {
      expect(adminApi.getAdminProducts).toHaveBeenCalledTimes(2)
      expect(adminApi.getAdminProducts).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 20,
        q: 'VPN',
        status: 'active',
        archived: 'only',
      })
    })
  })

  it('resets all draft inputs and applied filters to defaults on reset button click', async () => {
    vi.mocked(adminApi.getAdminProducts).mockResolvedValue({
      items: sampleProductList,
      total: 2,
      page: 1,
      pageSize: 20,
    })

    render(<AdminProductPanel active={true} />)
    expect(await screen.findByText('Standard VPN Node')).toBeInTheDocument()

    const searchInput = screen.getByTestId('admin-products-search-input')
    const statusFilter = screen.getByTestId('admin-products-status-filter')
    const archivedFilter = screen.getByTestId('admin-products-archived-filter')

    fireEvent.change(searchInput, { target: { value: 'Server' } })
    fireEvent.change(statusFilter, { target: { value: 'draft' } })
    fireEvent.change(archivedFilter, { target: { value: 'all' } })

    const resetBtn = screen.getByTestId('admin-products-reset-btn')
    fireEvent.click(resetBtn)

    expect(searchInput).toHaveValue('')
    expect(statusFilter).toHaveValue('')
    expect(archivedFilter).toHaveValue('exclude')

    await waitFor(() => {
      expect(adminApi.getAdminProducts).toHaveBeenLastCalledWith({
        page: 1,
        pageSize: 20,
        archived: 'exclude',
      })
    })
  })

  it('triggers page change through pagination controls', async () => {
    vi.mocked(adminApi.getAdminProducts).mockResolvedValueOnce({
      items: sampleProductList,
      total: 50,
      page: 1,
      pageSize: 20,
    })

    render(<AdminProductPanel active={true} />)
    expect(await screen.findByText('Standard VPN Node')).toBeInTheDocument()

    vi.mocked(adminApi.getAdminProducts).mockResolvedValueOnce({
      items: [
        {
          id: 3,
          name: 'Page 2 Product',
          type: '网络节点',
          price: 150,
          stock: 3,
          status: 'active',
          merchantId: null,
          offers: [],
        },
      ],
      total: 50,
      page: 2,
      pageSize: 20,
    })

    // Click Next page button in pagination
    const nextBtn = screen.getByLabelText('下一页')
    fireEvent.click(nextBtn)

    await waitFor(() => {
      expect(adminApi.getAdminProducts).toHaveBeenLastCalledWith(
        expect.objectContaining({
          page: 2,
          pageSize: 20,
        }),
      )
    })
    expect(await screen.findByText('Page 2 Product')).toBeInTheDocument()
  })

  it('shows error banner when getAdminProducts fails and allows retry', async () => {
    vi.mocked(adminApi.getAdminProducts).mockRejectedValueOnce(new Error('Fail-closed malformed envelope'))

    render(<AdminProductPanel active={true} />)

    expect(await screen.findByTestId('admin-products-refresh-error')).toHaveTextContent('商品列表刷新失败')

    vi.mocked(adminApi.getAdminProducts).mockResolvedValueOnce({
      items: sampleProductList,
      total: 2,
      page: 1,
      pageSize: 20,
    })

    const retryBtn = screen.getByTestId('admin-products-refresh-retry')
    fireEvent.click(retryBtn)

    expect(await screen.findByText('Standard VPN Node')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-products-refresh-error')).not.toBeInTheDocument()
  })

  it('automatically falls back to previous valid page when current page becomes empty', async () => {
    // Page 1 initial
    vi.mocked(adminApi.getAdminProducts).mockResolvedValueOnce({
      items: sampleProductList,
      total: 21,
      page: 1,
      pageSize: 20,
    })

    render(<AdminProductPanel active={true} />)
    expect(await screen.findByText('Standard VPN Node')).toBeInTheDocument()

    // Go to page 2: initially 1 item
    vi.mocked(adminApi.getAdminProducts).mockResolvedValueOnce({
      items: [
        {
          id: 21,
          name: 'Solo Item On Page 2',
          type: '网络节点',
          price: 99,
          stock: 1,
          status: 'active',
          merchantId: null,
          offers: [],
        },
      ],
      total: 21,
      page: 2,
      pageSize: 20,
    })

    fireEvent.click(screen.getByLabelText('下一页'))
    expect(await screen.findByText('Solo Item On Page 2')).toBeInTheDocument()

    // Now archiving that last item on page 2 leaves page 2 with 0 items, total 20
    vi.mocked(adminApi.getAdminProducts)
      .mockResolvedValueOnce({
        items: [],
        total: 20,
        page: 2,
        pageSize: 20,
      })
      .mockResolvedValueOnce({
        items: sampleProductList,
        total: 20,
        page: 1,
        pageSize: 20,
      })

    // Trigger reload (e.g. by retry or mutation)
    const retryOrQuery = screen.getByTestId('admin-products-search-btn')
    fireEvent.click(retryOrQuery)

    // The component should detect page 2 returning 0 items with total 20, and auto reload page 1
    await waitFor(() => {
      expect(adminApi.getAdminProducts).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1 }),
      )
    })
    expect(await screen.findByText('Standard VPN Node')).toBeInTheDocument()
  })

  it('protects against out-of-order race conditions', async () => {
    let resolveFirst: ((val: any) => void) | undefined
    let resolveSecond: ((val: any) => void) | undefined

    vi.mocked(adminApi.getAdminProducts)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))

    render(<AdminProductPanel active={true} />)

    // Second query is fired via form submit
    const searchInput = screen.getByTestId('admin-products-search-input')
    fireEvent.change(searchInput, { target: { value: 'NewerQuery' } })
    fireEvent.submit(screen.getByTestId('admin-products-filter-form'))

    // Second request resolves first with newer data
    resolveSecond?.({
      items: [
        {
          id: 99,
          name: 'NEW_PRODUCT_NAME',
          type: '网络节点',
          price: 200,
          stock: 5,
          status: 'active',
          merchantId: null,
          offers: [],
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    })

    expect(await screen.findByText('NEW_PRODUCT_NAME')).toBeInTheDocument()

    // First request resolves later with old stale data
    resolveFirst?.({
      items: [
        {
          id: 1,
          name: 'OLD_STALE_NAME',
          type: '网络节点',
          price: 10,
          stock: 1,
          status: 'active',
          merchantId: null,
          offers: [],
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    })

    // Stale data must NOT overwrite newer data
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getByText('NEW_PRODUCT_NAME')).toBeInTheDocument()
    expect(screen.queryByText('OLD_STALE_NAME')).not.toBeInTheDocument()
  })

  it('resets to page 1 on platform product creation', async () => {
    vi.mocked(adminApi.getAdminProducts).mockResolvedValue({
      items: sampleProductList,
      total: 2,
      page: 1,
      pageSize: 20,
    })

    render(<AdminProductPanel active={true} />)
    expect(await screen.findByText('Standard VPN Node')).toBeInTheDocument()

    // Open wizard
    fireEvent.click(screen.getByTestId('admin-platform-product-open'))
    expect(screen.getByTestId('mock-platform-wizard')).toBeInTheDocument()

    // Trigger created callback
    fireEvent.click(screen.getByTestId('mock-wizard-created'))

    await waitFor(() => {
      expect(adminApi.getAdminProducts).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1 }),
      )
    })
  })

  it('displays filtered empty state and allows clearing filters', async () => {
    vi.mocked(adminApi.getAdminProducts).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    })

    render(<AdminProductPanel active={true} />)
    expect(await screen.findByText('暂无商品')).toBeInTheDocument()

    // Trigger search with query
    const searchInput = screen.getByTestId('admin-products-search-input')
    fireEvent.change(searchInput, { target: { value: 'Nonexistent' } })
    fireEvent.click(screen.getByTestId('admin-products-search-btn'))

    expect(await screen.findByText('未找到匹配的商品')).toBeInTheDocument()
    expect(screen.getByTestId('admin-products-empty-reset')).toBeInTheDocument()

    // Click clear filters button
    vi.mocked(adminApi.getAdminProducts).mockResolvedValueOnce({
      items: sampleProductList,
      total: 2,
      page: 1,
      pageSize: 20,
    })

    fireEvent.click(screen.getByTestId('admin-products-empty-reset'))

    expect(await screen.findByText('Standard VPN Node')).toBeInTheDocument()
    expect(searchInput).toHaveValue('')
  })
})
