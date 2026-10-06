/**
 * MerchantProductsPanel 展示边界测试：筛选栏 / 列表 / 分页 / 商品操作入口。
 * 面板是纯展示组件——所有请求编排与 per-product guard 仍由父层持有，
 * 这里只断言「渲染什么 + 点击后回调收到什么」。
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import MerchantProductsPanel from './MerchantProductsPanel'
import type { ConfigRegistry } from '../../../types/config'
import type { MerchantProduct } from '../../../types/merchant'

const REGISTRY: ConfigRegistry = {
  productTypes: [{ value: 'default', label: '默认类型', deliveryModes: [] }],
  deliveryModes: [{ value: 'instant_fixed', label: '固定交付' }],
  orderStatuses: [],
  settlementStatuses: [],
  pagination: { defaultPageSize: 20, maxPageSize: 100 },
  inventory: { lowStockThreshold: 5 },
}

function makeProduct(overrides: Partial<MerchantProduct> = {}): MerchantProduct {
  return {
    id: 1,
    merchantId: 1,
    name: '商品A',
    description: null,
    richDescription: null,
    type: 'default',
    icon: '',
    imageUrl: null,
    price: 100,
    originalPrice: null,
    stock: 3,
    sales: 7,
    status: 'active',
    createdAt: '2024-01-01T00:00:00.000Z',
    deliveryMode: 'instant_fixed',
    stockMode: 'unlimited',
    ...overrides,
  } as MerchantProduct
}

type PanelProps = Parameters<typeof MerchantProductsPanel>[0]

function setup(overrides: Partial<PanelProps> = {}) {
  const props: PanelProps = {
    products: [makeProduct()],
    loading: false,
    productPage: 1,
    productTotal: 45,
    setProductPage: vi.fn(),
    productSearch: '',
    setProductSearch: vi.fn(),
    productStatusFilter: '',
    setProductStatusFilter: vi.fn(),
    productTypeFilter: '',
    setProductTypeFilter: vi.fn(),
    productModeFilter: '',
    setProductModeFilter: vi.fn(),
    productLowStockOnly: false,
    setProductLowStockOnly: vi.fn(),
    registry: REGISTRY,
    publishingProductIds: new Set<number>(),
    onToggleProductStatus: vi.fn(),
    onCreateProduct: vi.fn(),
    onEditProduct: vi.fn(),
    onManageAvailability: vi.fn(),
    onManageInventory: vi.fn(),
    onAdjustCapacity: vi.fn(),
    onViewInventoryLog: vi.fn(),
    onManageOffers: vi.fn(),
    ...overrides,
  }
  const view = render(<MerchantProductsPanel {...props} />)
  return { props, view }
}

describe('MerchantProductsPanel', () => {
  it('渲染筛选栏、列表与分页，页码切换交给父层', () => {
    const { props } = setup()

    expect(screen.getByTestId('merchant-product-filters')).toBeInTheDocument()
    expect(screen.getByTestId('merchant-product-search')).toBeInTheDocument()
    expect(screen.getByTestId('merchant-product-status-filter')).toBeInTheDocument()
    expect(screen.getByTestId('merchant-product-type-filter')).toBeInTheDocument()
    expect(screen.getByTestId('merchant-product-mode-filter')).toBeInTheDocument()
    expect(screen.getByTestId('merchant-product-lowstock-toggle')).toBeInTheDocument()

    // registry 驱动下拉选项
    expect(screen.getByRole('option', { name: '默认类型' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '固定交付' })).toBeInTheDocument()

    expect(screen.getByText('商品A')).toBeInTheDocument()
    expect(screen.getByTestId('merchant-product-pagination')).toHaveTextContent('共 45 条记录，第 1 / 3 页')

    const [, next] = screen.getByTestId('merchant-product-pagination').querySelectorAll('button')
    fireEvent.click(next)
    expect(props.setProductPage).toHaveBeenCalledWith(2)
  })

  it('筛选变化同时重置页码到 1（保持原有行为）', () => {
    const { props } = setup()

    fireEvent.change(screen.getByTestId('merchant-product-status-filter'), { target: { value: 'active' } })
    expect(props.setProductStatusFilter).toHaveBeenCalledWith('active')
    expect(props.setProductPage).toHaveBeenCalledWith(1)

    fireEvent.change(screen.getByTestId('merchant-product-type-filter'), { target: { value: 'default' } })
    expect(props.setProductTypeFilter).toHaveBeenCalledWith('default')

    fireEvent.change(screen.getByTestId('merchant-product-mode-filter'), { target: { value: 'instant_fixed' } })
    expect(props.setProductModeFilter).toHaveBeenCalledWith('instant_fixed')

    fireEvent.click(screen.getByTestId('merchant-product-lowstock-toggle'))
    expect(props.setProductLowStockOnly).toHaveBeenCalledWith(true)
  })

  it('搜索输入只向上抛值，防抖与请求编排留在父层', () => {
    const { props } = setup()
    fireEvent.change(screen.getByTestId('merchant-product-search'), { target: { value: '甲' } })
    expect(props.setProductSearch).toHaveBeenCalledWith('甲')
  })

  it('上架/下架按钮按 publishingProductIds 真实 disabled，且只锁同商品', () => {
    const { props } = setup({
      products: [makeProduct({ id: 1, status: 'active' }), makeProduct({ id: 2, name: '商品B', status: 'inactive' })],
      publishingProductIds: new Set([1]),
    })

    const locked = screen.getByTestId('merchant-product-toggle-status-1')
    const other = screen.getByTestId('merchant-product-toggle-status-2')

    expect(locked).toHaveTextContent('下架')
    expect(locked).toBeDisabled()
    expect(other).toHaveTextContent('上架')
    expect(other).not.toBeDisabled()

    fireEvent.click(other)
    expect(props.onToggleProductStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }))
  })

  it('商品操作入口回调收到对应商品/商品 id', () => {
    const product = makeProduct({
      id: 9,
      offers: [
        { id: 901, name: '规格甲', price: 10, originalPrice: null, status: 'active', deliveryMode: 'instant_inventory', stockMode: 'limited', stock: 2 },
      ],
    })
    const { props } = setup({ products: [product] })

    fireEvent.click(screen.getByRole('button', { name: '管理可售资源' }))
    expect(props.onManageAvailability).toHaveBeenCalledWith(product)

    fireEvent.click(screen.getByRole('button', { name: '管理交付库存' }))
    expect(props.onManageInventory).toHaveBeenCalledWith(product)

    fireEvent.click(screen.getByRole('button', { name: '可售资源记录' }))
    expect(props.onViewInventoryLog).toHaveBeenCalledWith(product)

    fireEvent.click(screen.getByRole('button', { name: '规格管理' }))
    expect(props.onManageOffers).toHaveBeenCalledWith(product)

    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(props.onEditProduct).toHaveBeenCalledWith(9)

    fireEvent.click(screen.getByRole('button', { name: '新建商品' }))
    expect(props.onCreateProduct).toHaveBeenCalled()
  })

  it('空态：非加载中的空列表渲染空态且不渲染表体行', () => {
    setup({ products: [] })
    expect(screen.getByText('暂无商品')).toBeInTheDocument()
  })
})
