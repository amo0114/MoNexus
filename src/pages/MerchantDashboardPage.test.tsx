/**
 * MerchantDashboardPage 商品上架/下架接线（CMI）——真实页面 + 真实 useAppStore，
 * 仅 mock ../api/merchant 与 ../api/catalog。被测的上架/下架按钮是页面真实渲染
 * 的 LinkAction（含真实 disabled），不替换成假组件。
 *
 * 覆盖：
 *  1. active 点「下架」→ catalogApi.unpublishProduct(product.id)，且不调用旧
 *     updateMerchantProduct status 路径；
 *  2. inactive 点「上架」→ catalogApi.publishProduct(product.id)；
 *  3. typed deferred promise 下同商品重复点击仅一个请求，按钮进行中真实 disabled，
 *     且不锁其他商品；
 *  4. 失败不伪造成功（只显示错误提示），按钮恢复后可 retry，retry 成功并刷新列表。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useAppStore } from '../stores/appStore'
import MerchantDashboardPage from './MerchantDashboardPage'
import type {
  CreateMerchantProductRequest,
  ListEnvelope,
  Merchant,
  MerchantOrder,
  MerchantProduct,
  MerchantProductListParams,
  MerchantStats,
  Settlement,
  UpdateMerchantProductRequest,
  UpdateMerchantRequest,
} from '../types/merchant'
import type { DeliveryMode } from '../types/merchant'
import type { PublishActionResult } from '../types/catalog'

// ---------------------------------------------------------------------------
// Typed deferred harness — 禁止 any：promise 与 resolve/reject 全部具名类型。
// ---------------------------------------------------------------------------
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------------------
// Module mocks：merchant + catalog。全部方法具名类型化，避免 any。
// ---------------------------------------------------------------------------
const { merchantApi, catalogApi } = vi.hoisted(() => {
  const merchantApi = {
    getMerchantStats: vi.fn<() => Promise<MerchantStats>>(),
    getMerchantProducts: vi.fn<(params?: MerchantProductListParams) => Promise<ListEnvelope<MerchantProduct>>>(),
    getMerchantOrders: vi.fn<
      (params?: { page?: number; pageSize?: number; status?: string; sort?: 'booking' }) => Promise<ListEnvelope<MerchantOrder>>
    >(),
    getMerchantSettlements: vi.fn<() => Promise<Settlement[]>>(),
    getMerchantMe: vi.fn<() => Promise<Merchant>>(),
    createMerchantProduct: vi.fn<(payload: CreateMerchantProductRequest) => Promise<MerchantProduct>>(),
    updateMerchantProduct: vi.fn<(id: number, payload: UpdateMerchantProductRequest) => Promise<MerchantProduct>>(),
    updateMerchantMe: vi.fn<(payload: UpdateMerchantRequest) => Promise<Merchant>>(),
    startFulfillment: vi.fn<(id: number, payload?: { publicNote?: string }) => Promise<void>>(),
    deliverOrder: vi.fn<(id: number, payload: Record<string, unknown>) => Promise<void>>(),
    respondDispute: vi.fn<
      (id: number, payload: { resolution: 'resume' | 'close'; publicNote?: string }) => Promise<void>
    >(),
    rejectOrder: vi.fn<(id: number, payload?: { publicNote?: string; internalNote?: string }) => Promise<void>>(),
    postOrderProgress: vi.fn<(id: number, note: string) => Promise<{ ok: true }>>(),
    getMerchantOrderDetail: vi.fn<(id: number) => Promise<MerchantOrder>>(),
    getMerchantInventoryLogs: vi.fn<(id: number, params?: { page?: number; pageSize?: number }) => Promise<unknown>>(),
    getMerchantOffers: vi.fn<(productId: number) => Promise<unknown>>(),
    createMerchantOffer: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    updateMerchantOffer: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    deleteMerchantOffer: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    uploadDeliveryFile: vi.fn<(file: File) => Promise<{ id: number; fileName: string; size: number }>>(),
    getMyWebhookConfig: vi.fn<() => Promise<unknown>>(),
    saveMyWebhookConfig: vi.fn<(config: unknown) => Promise<unknown>>(),
    deleteMyWebhookConfig: vi.fn<() => Promise<unknown>>(),
    testMyWebhookConfig: vi.fn<() => Promise<unknown>>(),
    adjustMerchantOfferCapacity: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    importMerchantInventory: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    importMerchantOfferInventory: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    voidMerchantOfferInventory: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    previewMerchantOfferInventory: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  }
  const catalogApi = {
    listActiveCategories: vi.fn<() => Promise<unknown>>(),
    createDraftProduct: vi.fn<(payload: unknown) => Promise<unknown>>(),
    listProductOffers: vi.fn<(productId: number) => Promise<unknown>>(),
    getPublicationReadiness: vi.fn<(productId: number) => Promise<unknown>>(),
    publishProduct: vi.fn<(productId: number) => Promise<PublishActionResult>>(),
    unpublishProduct: vi.fn<(productId: number) => Promise<PublishActionResult>>(),
    adjustCapacity: vi.fn<(productId: number, request: unknown) => Promise<void>>(),
    voidInventory: vi.fn<(productId: number, request: unknown) => Promise<unknown>>(),
  }
  return { merchantApi, catalogApi }
})

vi.mock('../api/merchant', () => merchantApi)
vi.mock('../api/catalog', () => ({
  catalogApi,
  // ProductAvailabilityStep 仅在本测试从不打开的规格模态里使用；占位避免裸 import。
  getCapacityLabel: vi.fn<(deliveryMode: DeliveryMode) => string>(),
  getOfferActionLabel: vi.fn<(action: unknown) => string>(),
  getOfferAvailabilityAction: vi.fn<(offer: unknown) => unknown>(),
}))

vi.mock('../components/catalog/CategoryApplicationPanel', () => ({
  default: () => <div data-testid="category-application-panel-host-probe">分类申请面板</div>,
}))

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
const STATS: MerchantStats = {
  productCount: 1,
  orderCount: 0,
  totalRevenue: 0,
  pendingSettlement: 0,
  todo: { pending: 0, processing: 0, slaExceeded: 0 },
}

function makeProduct(id: number, name: string, status: 'active' | 'inactive'): MerchantProduct {
  return {
    id,
    merchantId: 1,
    name,
    description: null,
    richDescription: null,
    type: 'default',
    icon: '',
    imageUrl: null,
    price: 100,
    originalPrice: null,
    stock: 0,
    sales: 0,
    status,
    createdAt: '2024-01-01T00:00:00.000Z',
    deliveryMode: 'instant_fixed',
    stockMode: 'unlimited',
  }
}

const PRODUCTS: MerchantProduct[] = [
  makeProduct(1, '商品A', 'active'),
  makeProduct(2, '商品B', 'inactive'),
]

function productsEnvelope(): ListEnvelope<MerchantProduct> {
  return { items: PRODUCTS, total: PRODUCTS.length, page: 1, pageSize: 20 }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function renderPage() {
  return render(
    <MemoryRouter>
      <MerchantDashboardPage />
    </MemoryRouter>,
  )
}

async function openProductsTab() {
  fireEvent.click(screen.getByRole('button', { name: '商品管理' }))
  await screen.findByTestId('merchant-product-filters')
}

function hasToast(message: string, type: 'success' | 'error'): boolean {
  return useAppStore.getState().toasts.some((t) => t.message === message && t.type === type)
}

afterEach(() => vi.restoreAllMocks())
beforeEach(() => {
  vi.resetAllMocks()
  useAppStore.setState({ toasts: [], islandNotice: null, islandQueue: [], islandNoticeAvailable: false, modalDepth: 0 })
  merchantApi.getMerchantStats.mockResolvedValue(STATS)
  merchantApi.getMerchantProducts.mockResolvedValue(productsEnvelope())
})

it('opens the exact order from a notification route and returns to the order list', async () => {
  const order: MerchantOrder = {
    id: 77, userId: 1, productId: 1, merchantId: 1, price: 100,
    commissionRate: '0.1', commissionAmount: 10, settlementAmount: 90,
    status: 'pending', createdAt: '2026-10-06T00:00:00Z',
    product: { id: 1, name: '通知关联商品', type: 'default', icon: '' },
    availableActions: ['start_fulfillment'],
  }
  merchantApi.getMerchantOrderDetail.mockResolvedValue(order)
  merchantApi.getMerchantOrders.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 })
  render(<MemoryRouter initialEntries={['/merchant/orders/77']}><MerchantDashboardPage /></MemoryRouter>)
  await screen.findByText('通知关联商品')
  expect(merchantApi.getMerchantOrderDetail).toHaveBeenCalledWith(77)
  expect(screen.getByTestId('merchant-focused-order')).toHaveTextContent('#77')
  expect(merchantApi.getMerchantOrders).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '全部订单' }))
  await waitFor(() => expect(merchantApi.getMerchantOrders).toHaveBeenCalled())
  expect(screen.queryByTestId('merchant-focused-order')).toBeNull()
})

describe('MerchantDashboardPage 商品上架/下架接线', () => {
  it('active 商品点「下架」调用 catalogApi.unpublishProduct(id)，不调用旧 updateMerchantProduct，成功提示并刷新', async () => {
    catalogApi.unpublishProduct.mockResolvedValue({ id: 1, status: 'inactive', publishedAt: '2024-01-01T00:00:00.000Z' })
    renderPage()
    await openProductsTab()

    const unpublishBtn = await screen.findByTestId('merchant-product-toggle-status-1')
    expect(unpublishBtn).toHaveTextContent('下架')

    const productsCallsBefore = merchantApi.getMerchantProducts.mock.calls.length
    fireEvent.click(unpublishBtn)

    await waitFor(() => {
      expect(catalogApi.unpublishProduct).toHaveBeenCalledWith(1)
    })
    expect(catalogApi.publishProduct).not.toHaveBeenCalled()
    // 不调用旧 updateMerchantProduct status 路径
    expect(merchantApi.updateMerchantProduct).not.toHaveBeenCalled()

    await waitFor(() => {
      expect(hasToast('商品已下架', 'success')).toBe(true)
    })
    // 成功后刷新列表
    await waitFor(() => {
      expect(merchantApi.getMerchantProducts.mock.calls.length).toBeGreaterThan(productsCallsBefore)
    })
  })

  it('inactive 商品点「上架」调用 catalogApi.publishProduct(id)', async () => {
    catalogApi.publishProduct.mockResolvedValue({ id: 2, status: 'active', publishedAt: '2024-01-01T00:00:00.000Z' })
    renderPage()
    await openProductsTab()

    const publishBtn = await screen.findByTestId('merchant-product-toggle-status-2')
    expect(publishBtn).toHaveTextContent('上架')

    fireEvent.click(publishBtn)

    await waitFor(() => {
      expect(catalogApi.publishProduct).toHaveBeenCalledWith(2)
    })
    expect(catalogApi.unpublishProduct).not.toHaveBeenCalled()
    expect(merchantApi.updateMerchantProduct).not.toHaveBeenCalled()

    await waitFor(() => {
      expect(hasToast('商品已上架', 'success')).toBe(true)
    })
  })

  it('typed deferred：disabled commit 前同步连续点击三次仅一个请求，真实按钮 disabled 且不锁其他商品', async () => {
    const deferred = createDeferred<PublishActionResult>()
    catalogApi.unpublishProduct.mockReturnValueOnce(deferred.promise)
    renderPage()
    await openProductsTab()

    const unpublishBtn = await screen.findByTestId('merchant-product-toggle-status-1')
    const otherBtn = screen.getByTestId('merchant-product-toggle-status-2')

    // 在等待 disabled re-render 之前，同一同步 act 内连续点击三次真实按钮：
    // 三次点击都发生在同一个 React commit 内（fireEvent 同步派发 + act 批量 flush），
    // 覆盖 state commit 前的快速重复触发；per-product guard 用 ref 原子拦截。
    act(() => {
      fireEvent.click(unpublishBtn)
      fireEvent.click(unpublishBtn)
      fireEvent.click(unpublishBtn)
    })

    // 紧接着断言：commit 前连续触发也仅发出一个请求。
    expect(catalogApi.unpublishProduct).toHaveBeenCalledTimes(1)
    expect(catalogApi.publishProduct).not.toHaveBeenCalled()

    // mutation 进行中：该商品按钮真实 disabled；其他商品按钮不受影响。
    await waitFor(() => expect(unpublishBtn).toBeDisabled())
    expect(otherBtn).not.toBeDisabled()

    await act(async () => {
      deferred.resolve({ id: 1, status: 'inactive', publishedAt: '2024-01-01T00:00:00.000Z' })
    })

    await waitFor(() => {
      expect(catalogApi.unpublishProduct).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(unpublishBtn).not.toBeDisabled()
    })
  })

  it('失败不伪造成功（只显示错误），按钮恢复可 retry，retry 成功并刷新', async () => {
    const failDeferred = createDeferred<PublishActionResult>()
    catalogApi.unpublishProduct.mockReturnValueOnce(failDeferred.promise)
    catalogApi.unpublishProduct.mockResolvedValueOnce({ id: 1, status: 'inactive', publishedAt: '2024-01-01T00:00:00.000Z' })
    renderPage()
    await openProductsTab()

    const unpublishBtn = await screen.findByTestId('merchant-product-toggle-status-1')

    // 第一次尝试：服务失败。
    fireEvent.click(unpublishBtn)
    await waitFor(() => expect(unpublishBtn).toBeDisabled())
    await act(async () => {
      failDeferred.reject({ response: { data: { error: { message: '服务不可用' } } } })
    })

    await waitFor(() => {
      expect(hasToast('服务不可用', 'error')).toBe(true)
    })
    // 不伪造成功提示。
    expect(hasToast('商品已下架', 'success')).toBe(false)
    // 失败后按钮恢复，允许 retry。
    await waitFor(() => expect(unpublishBtn).not.toBeDisabled())

    const productsCallsBefore = merchantApi.getMerchantProducts.mock.calls.length

    // retry：第二次成功。
    fireEvent.click(unpublishBtn)
    await waitFor(() => {
      expect(catalogApi.unpublishProduct).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(hasToast('商品已下架', 'success')).toBe(true)
    })
    // 成功后刷新列表。
    await waitFor(() => {
      expect(merchantApi.getMerchantProducts.mock.calls.length).toBeGreaterThan(productsCallsBefore)
    })
  })

  it('分类申请 tab：渲染 CategoryApplicationPanel 且不触发 merchant 列表 mock', async () => {
    renderPage()
    // 初始在 dashboard，probe 不应存在
    expect(screen.queryByTestId('category-application-panel-host-probe')).not.toBeInTheDocument()

    // 等初始 stats 完成后，记录各 merchant 列表 mock 的调用次数
    await waitFor(() => {
      expect(merchantApi.getMerchantStats).toHaveBeenCalled()
    })
    const productsCallsBefore = merchantApi.getMerchantProducts.mock.calls.length
    const ordersCallsBefore = merchantApi.getMerchantOrders.mock.calls.length
    const settlementsCallsBefore = merchantApi.getMerchantSettlements.mock.calls.length
    const profileCallsBefore = merchantApi.getMerchantMe.mock.calls.length

    // 点击「分类申请」后 probe 出现
    fireEvent.click(screen.getByRole('button', { name: '分类申请' }))
    expect(await screen.findByTestId('category-application-panel-host-probe')).toBeInTheDocument()

    // 切换仅展示面板，不新增任何 merchant 列表调用
    expect(merchantApi.getMerchantProducts.mock.calls.length).toBe(productsCallsBefore)
    expect(merchantApi.getMerchantOrders.mock.calls.length).toBe(ordersCallsBefore)
    expect(merchantApi.getMerchantSettlements.mock.calls.length).toBe(settlementsCallsBefore)
    expect(merchantApi.getMerchantMe.mock.calls.length).toBe(profileCallsBefore)
  })
})

function enableMobileIsland() {
  vi.spyOn(window, 'matchMedia').mockImplementation(media => ({ matches: media.includes('767'), media, addEventListener() {}, removeEventListener() {} }) as MediaQueryList)
  useAppStore.setState({ islandNoticeAvailable: true })
}
function fulfillmentOrder(): MerchantOrder {
  return {
    id: 77, userId: 1, productId: 1, merchantId: 1, price: 100,
    commissionRate: '0.1', commissionAmount: 10, settlementAmount: 90,
    status: 'processing', createdAt: '2026-10-06T00:00:00Z',
    product: { id: 1, name: '履约测试商品', type: 'default', icon: '' },
    availableActions: ['deliver', 'post_progress'],
  }
}
async function openFulfillmentOrders() {
  const order = fulfillmentOrder()
  merchantApi.getMerchantOrders.mockResolvedValue({items:[order],total:1,page:1,pageSize:20})
  merchantApi.getMerchantOrderDetail.mockResolvedValue(order)
  render(<MemoryRouter initialEntries={['/merchant/orders']}><MerchantDashboardPage /></MemoryRouter>)
  await screen.findByTestId('merchant-post-progress-77')
}

it.each(['deliver', 'progress'] as const)('mobile %s completion links the exact order without publishing submitted content', async (kind) => {
  enableMobileIsland()
  merchantApi.deliverOrder.mockResolvedValue(undefined)
  merchantApi.postOrderProgress.mockResolvedValue({ok:true})
  await openFulfillmentOrders()
  if (kind === 'deliver') {
    fireEvent.click(screen.getByRole('button', {name:'发货',exact:true}))
    fireEvent.change(await screen.findByTestId('merchant-deliver-content'), {target:{value:'private-delivery-secret'}})
    fireEvent.click(screen.getByTestId('merchant-deliver-submit'))
  } else {
    fireEvent.click(screen.getByTestId('merchant-post-progress-77'))
    fireEvent.change(await screen.findByTestId('merchant-progress-note'), {target:{value:'private-progress-note'}})
    fireEvent.click(screen.getByTestId('merchant-progress-submit'))
  }
  await waitFor(() => expect(useAppStore.getState().islandNotice?.title).toBe(kind === 'deliver' ? '发货成功' : '进度已更新'))
  await waitFor(() => expect(useAppStore.getState().modalDepth).toBe(0))
  const notice = useAppStore.getState().islandNotice!
  expect(notice.subtitle).toContain('#77')
  expect(notice.groupKey).toBe('merchant:order:77')
  expect(JSON.stringify(notice)).not.toContain('private-')
  act(() => notice.onAction?.())
  await waitFor(() => expect(screen.getByTestId('merchant-focused-order')).toHaveTextContent('#77'))
})

it('failed progress retains the form and creates no success island', async () => {
  enableMobileIsland()
  merchantApi.postOrderProgress.mockRejectedValue(new Error('offline'))
  await openFulfillmentOrders()
  fireEvent.click(screen.getByTestId('merchant-post-progress-77'))
  fireEvent.change(await screen.findByTestId('merchant-progress-note'), {target:{value:'保留这条进度'}})
  fireEvent.click(screen.getByTestId('merchant-progress-submit'))
  await waitFor(() => expect(hasToast('进度更新失败','error')).toBe(true))
  expect(screen.getByTestId('merchant-progress-note')).toHaveValue('保留这条进度')
  expect(useAppStore.getState().islandNotice).toBeNull()
})

it('inventory completion uses the server count and opens records for the imported product', async () => {
  enableMobileIsland()
  merchantApi.getMerchantProducts.mockResolvedValue({items:[{...PRODUCTS[0],deliveryMode:'instant_inventory',offers:[{
    id:11,productId:1,name:'标准规格',price:100,status:'active',deliveryMode:'instant_inventory',stockMode:'limited',stock:0,
  }]}],total:1,page:1,pageSize:20})
  merchantApi.previewMerchantOfferInventory.mockResolvedValue({canImport:true,totalRows:2,validRows:2,emptyRows:0,duplicateRows:0,existingDuplicateRows:0})
  merchantApi.importMerchantInventory.mockResolvedValue({imported:1,totalRows:2,validRows:1,skippedEmptyRows:0,duplicateRows:0,existingDuplicateRows:0})
  merchantApi.getMerchantInventoryLogs.mockResolvedValue({items:[],total:0,page:1,pageSize:10})
  renderPage()
  await openProductsTab()
  fireEvent.click(screen.getByText('管理交付库存'))
  fireEvent.change(await screen.findByTestId('merchant-inventory-content'),{target:{value:'secret-one\nsecret-two'}})
  fireEvent.click(screen.getByRole('button',{name:'预览导入内容'}))
  fireEvent.click(await screen.findByRole('button',{name:'确认导入 2 个'}))
  await waitFor(() => expect(useAppStore.getState().islandNotice?.title).toBe('成功导入 1 个交付单元'))
  await waitFor(() => expect(useAppStore.getState().modalDepth).toBe(0))
  const notice=useAppStore.getState().islandNotice!
  expect(JSON.stringify(notice)).not.toContain('secret-one')
  act(()=>notice.onAction?.())
  await screen.findByTestId('inventory-log-modal')
  await waitFor(()=>expect(merchantApi.getMerchantInventoryLogs).toHaveBeenCalledWith(1,{page:1,pageSize:10}))
})
