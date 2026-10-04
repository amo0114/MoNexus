/**
 * MerchantOrdersPanel 展示边界测试：待办卡 / 筛选 / 预约排序 / 列表 / 分页 / 履约操作入口。
 * 面板是纯展示组件——履约请求编排、进行中状态与订单弹窗刷新仍由父层持有，
 * 这里只断言「渲染什么 + 点击后回调收到什么」。
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import MerchantOrdersPanel from './MerchantOrdersPanel'
import type { ConfigRegistry } from '../../../types/config'
import type { MerchantOrder } from '../../../types/merchant'

const REGISTRY: ConfigRegistry = {
  productTypes: [],
  deliveryModes: [{ value: 'instant_fixed', label: '固定交付' }],
  orderStatuses: [{ value: 'pending', label: '待处理' }, { value: 'processing', label: '履约中' }],
  settlementStatuses: [],
  pagination: { defaultPageSize: 20, maxPageSize: 100 },
  inventory: { lowStockThreshold: 5 },
}

function makeOrder(overrides: Partial<MerchantOrder> = {}): MerchantOrder {
  return {
    id: 1001,
    product: { name: '商品A', deliveryMode: 'instant_fixed' },
    user: { email: 'a@example.com' },
    price: 100,
    commissionRate: 0.15,
    settlementAmount: 85,
    status: 'processing',
    availableActions: [],
    ...overrides,
  } as unknown as MerchantOrder
}

type PanelProps = Parameters<typeof MerchantOrdersPanel>[0]

function setup(overrides: Partial<PanelProps> = {}) {
  const props: PanelProps = {
    orders: [makeOrder()],
    loading: false,
    orderPage: 1,
    orderTotal: 45,
    setOrderPage: vi.fn(),
    orderStatusFilter: '',
    setOrderStatusFilter: vi.fn(),
    orderSortBooking: false,
    setOrderSortBooking: vi.fn(),
    todo: { pending: 2, processing: 1, slaExceeded: 3 },
    registry: REGISTRY,
    onOrderAction: vi.fn(),
    ...overrides,
  }
  const view = render(<MerchantOrdersPanel {...props} />)
  return { props, view }
}

describe('MerchantOrdersPanel', () => {
  it('待办卡渲染父层 stats.todo 计数，点击写入状态筛选并重置页码', () => {
    const { props } = setup()

    expect(screen.getByTestId('merchant-order-todo')).toHaveTextContent('2')
    expect(screen.getByTestId('merchant-order-todo')).toHaveTextContent('1')

    const [pendingBtn, processingBtn] = screen.getByTestId('merchant-order-todo').querySelectorAll('button')

    fireEvent.click(pendingBtn)
    expect(props.setOrderStatusFilter).toHaveBeenCalledWith('pending')
    expect(props.setOrderPage).toHaveBeenCalledWith(1)

    fireEvent.click(processingBtn)
    expect(props.setOrderStatusFilter).toHaveBeenCalledWith('processing')
  })

  it('todo 缺失时计数降级为 — （不清空可见结构）', () => {
    setup({ todo: undefined })
    const todo = screen.getByTestId('merchant-order-todo')
    expect(todo).toBeInTheDocument()
    expect(todo.textContent).toContain('—')
  })

  it('状态筛选与预约排序：排序用函数式切换并重置页码', () => {
    const { props } = setup()

    fireEvent.change(screen.getByTestId('merchant-order-status-filter'), { target: { value: 'processing' } })
    expect(props.setOrderStatusFilter).toHaveBeenCalledWith('processing')
    expect(props.setOrderPage).toHaveBeenCalledWith(1)

    fireEvent.click(screen.getByTestId('merchant-orders-sort-booking'))
    // 必须保留父层原有函数式更新语义（v => !v），避免闭包旧值覆盖
    expect(props.setOrderSortBooking).toHaveBeenCalledWith(expect.any(Function))
    expect(props.setOrderPage).toHaveBeenCalledWith(1)
  })

  it('排序按钮 aria-pressed 反映父层状态', () => {
    setup({ orderSortBooking: true })
    expect(screen.getByTestId('merchant-orders-sort-booking')).toHaveAttribute('aria-pressed', 'true')
  })

  it('列表渲染订单字段，分页页码切换交给父层', () => {
    const { props, view } = setup({
      orders: [makeOrder({ id: 1001, holdingPoints: 10, offerNameSnapshot: '规格甲', bookingDate: '2024-06-01' })],
    })

    expect(screen.getByText('1001')).toBeInTheDocument()
    expect(screen.getByText('商品A')).toBeInTheDocument()
    expect(screen.getByText('规格：规格甲')).toBeInTheDocument()
    expect(screen.getByTestId('merchant-order-booking-1001')).toBeInTheDocument()
    expect(screen.getByText('冻结 10')).toBeInTheDocument()
    expect(screen.getByText('a@example.com')).toBeInTheDocument()

    expect(screen.getByText('共 45 条记录，第 1 / 3 页')).toBeInTheDocument()

    // 分页控件是面板内最后一组按钮（上一页/下一页），点击下一页上报父层。
    const pagerButtons = view.container.querySelectorAll('.mt-4 button')
    expect(pagerButtons).toHaveLength(2)
    fireEvent.click(pagerButtons[1])
    expect(props.setOrderPage).toHaveBeenCalledWith(2)
  })

  it('履约操作入口按 availableActions 渲染，回调收到 action 与订单', () => {
    const order = makeOrder({
      id: 1001,
      availableActions: ['start_fulfillment', 'reject', 'post_progress', 'deliver', 'respond_dispute'],
    })
    const { props } = setup({ orders: [order] })

    fireEvent.click(screen.getByRole('button', { name: '开始履约' }))
    expect(props.onOrderAction).toHaveBeenCalledWith('start_fulfillment', order)

    fireEvent.click(screen.getByTestId('merchant-reject-order-1001'))
    expect(props.onOrderAction).toHaveBeenCalledWith('reject', order)

    fireEvent.click(screen.getByTestId('merchant-post-progress-1001'))
    expect(props.onOrderAction).toHaveBeenCalledWith('post_progress', order)

    fireEvent.click(screen.getByRole('button', { name: '发货' }))
    expect(props.onOrderAction).toHaveBeenCalledWith('deliver', order)

    fireEvent.click(screen.getByRole('button', { name: '处理争议' }))
    expect(props.onOrderAction).toHaveBeenCalledWith('respond_dispute', order)
  })

  it('availableActions 为空时不渲染任何履约操作按钮', () => {
    setup({ orders: [makeOrder({ availableActions: [] })] })
    expect(screen.queryByRole('button', { name: '开始履约' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '发货' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '处理争议' })).not.toBeInTheDocument()
  })

  it('SLA 超期标记按订单字段渲染', () => {
    setup({ orders: [makeOrder({ id: 1001, slaExceeded: true })] })
    expect(screen.getByTestId('sla-exceeded-badge-1001')).toBeInTheDocument()
  })

  it('空态：非加载中的空列表渲染空态', () => {
    setup({ orders: [] })
    expect(screen.getByText('你还没有订单')).toBeInTheDocument()
  })
})
