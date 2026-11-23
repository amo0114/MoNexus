import { useLayoutEffect, type ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import type { UserOrderDetail, UserOrderListItem } from '../types/order'

const { getOrdersPage, getOrderDetail, invalidationHandlers } = vi.hoisted(() => ({
  getOrdersPage: vi.fn(),
  getOrderDetail: vi.fn(),
  invalidationHandlers: new Map<string, () => void>(),
}))

vi.mock('../api/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/orders')>()
  return {
    ...actual,
    getOrdersPage,
    getOrderDetail,
    getOrderAttentionCount: vi.fn().mockResolvedValue(0),
  }
})
vi.mock('../hooks/useNotificationInvalidation', () => ({
  useNotificationInvalidation: (scope: string, handler: () => void) => {
    invalidationHandlers.set(scope, handler)
  },
}))

import OrdersPage from './OrdersPage'

function makeJwt(userId: number, sid: string, exp = 4102444800): string {
  const payload = btoa(JSON.stringify({ userId, sid, exp })).replace(/=+$/, '')
  return `header.${payload}.sig`
}

function signIn(userId: number, sid: string, authEpoch: number) {
  useAuthStore.setState({
    user: {
      id: userId,
      email: `user-${userId}@synthetic.test`,
      role: 'user',
      status: 'active',
      points: 500,
      merchant: null,
    },
    accessToken: makeJwt(userId, sid),
    sessionId: sid,
    isLoggedIn: true,
    authEpoch,
  })
}

function signOut(authEpoch: number) {
  useAuthStore.setState({
    user: null,
    accessToken: null,
    sessionId: null,
    isLoggedIn: false,
    authEpoch,
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const ORDER_ITEM_A: UserOrderListItem = {
  id: 901,
  orderNo: 'ORD-SYNTH-A-901',
  price: 100,
  status: 'delivered',
  deliveryMode: 'instant_inventory',
  createdAt: '2026-09-01T00:00:00.000Z',
  merchant: null,
  product: {
    id: 42,
    name: '用户A专属商品',
    type: '充值卡密',
    icon: 'box',
    imageUrl: null,
    deliveryMode: 'instant_inventory',
  },
}

const ORDER_DETAIL_A: UserOrderDetail = {
  ...ORDER_ITEM_A,
  delivery: {
    status: 'delivered',
    content: 'SYNTH-ORDERS-PAGE-SECRET-A',
    contentType: 'text',
    expired: false,
  },
  timeline: [],
}

interface Snapshot {
  isLoggedIn: boolean
  userId: number | null
  sessionId: string | null
  bodyText: string
}

function Observer({ snapshots, children }: { snapshots: Snapshot[]; children: ReactNode }) {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn)
  const userId = useAuthStore((s) => s.user?.id ?? null)
  const sessionId = useAuthStore((s) => s.sessionId)
  useLayoutEffect(() => {
    snapshots.push({
      isLoggedIn,
      userId,
      sessionId,
      bodyText: document.body.textContent ?? '',
    })
  })
  return <>{children}</>
}

describe('OrdersPage session isolation for order detail & list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getOrdersPage.mockReset()
    getOrderDetail.mockReset()
    invalidationHandlers.clear()
    useAppStore.setState({ toasts: [], islandNotice: null, islandQueue: [], modalDepth: 0 })
    signIn(101, 'sess-orders-a1', 1)
    getOrdersPage.mockResolvedValue({
      items: [ORDER_ITEM_A],
      total: 1,
      page: 1,
      pageSize: 10,
      counts: { all: 1, active: 0, delivered: 1, done: 0 },
    })
    getOrderDetail.mockResolvedValue(ORDER_DETAIL_A)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['A -> guest', () => signOut(2), (s: Snapshot) => !s.isLoggedIn],
    ['A -> B', () => signIn(202, 'sess-orders-b1', 2), (s: Snapshot) => s.userId === 202],
    ['same account new sessionId', () => signIn(101, 'sess-orders-a2', 1), (s: Snapshot) => s.sessionId === 'sess-orders-a2'],
  ])('clears open OrderDetailModal and list on the very first DOM commit (%s)', async (_label, transition, matchCommit) => {
    const snapshots: Snapshot[] = []
    render(
      <MemoryRouter initialEntries={['/orders']}>
        <Observer snapshots={snapshots}>
          <Routes>
            <Route path="/orders" element={<OrdersPage />} />
          </Routes>
        </Observer>
      </MemoryRouter>,
    )

    const cardBtn = await screen.findByText('用户A专属商品')
    fireEvent.click(cardBtn)
    expect(await screen.findByText('SYNTH-ORDERS-PAGE-SECRET-A')).toBeInTheDocument()

    getOrdersPage.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 10,
      counts: { all: 0, active: 0, delivered: 0, done: 0 },
    })

    const beforeIdx = snapshots.length
    act(() => {
      transition()
    })

    const firstCommit = snapshots.slice(beforeIdx).find(matchCommit)
    expect(firstCommit).toBeDefined()
    expect(firstCommit!.bodyText).not.toContain('SYNTH-ORDERS-PAGE-SECRET-A')
    expect(firstCommit!.bodyText).not.toContain('用户A专属商品')
    expect(document.body.textContent).not.toContain('SYNTH-ORDERS-PAGE-SECRET-A')
  })

  it('drops a late getOrderDetail response after switching from A to B', async () => {
    const lateDetail = deferred<UserOrderDetail>()
    getOrderDetail.mockReturnValueOnce(lateDetail.promise)

    const snapshots: Snapshot[] = []
    render(
      <MemoryRouter initialEntries={['/orders']}>
        <Observer snapshots={snapshots}>
          <Routes>
            <Route path="/orders" element={<OrdersPage />} />
          </Routes>
        </Observer>
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByText('用户A专属商品'))
    await waitFor(() => expect(getOrderDetail).toHaveBeenCalledWith(901))

    getOrdersPage.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 10,
      counts: { all: 0, active: 0, delivered: 0, done: 0 },
    })

    act(() => {
      signIn(202, 'sess-orders-b-late', 2)
    })

    await act(async () => {
      lateDetail.resolve(ORDER_DETAIL_A)
    })

    expect(document.body.textContent).not.toContain('SYNTH-ORDERS-PAGE-SECRET-A')
  })

  it('exits skeleton loading into a recoverable error state when initial orders load fails and recovers on retry', async () => {
    const initialFail = deferred<never>()
    getOrdersPage
      .mockReturnValueOnce(initialFail.promise)
      .mockResolvedValueOnce({
        items: [ORDER_ITEM_A],
        total: 1,
        page: 1,
        pageSize: 10,
        counts: { all: 1, active: 0, delivered: 1, done: 0 },
      })

    render(
      <MemoryRouter initialEntries={['/orders']}>
        <Routes>
          <Route path="/orders" element={<OrdersPage />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(document.body.querySelector('.animate-pulse')).not.toBeNull()

    await act(async () => {
      initialFail.reject(new Error('network error'))
    })

    expect(await screen.findByTestId('orders-load-error')).toBeInTheDocument()
    expect(screen.queryByText('还没有订单')).toBeNull()
    expect(useAppStore.getState().toasts.some((t) => t.type === 'error')).toBe(true)
    expect(document.body.querySelector('.animate-pulse')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('用户A专属商品')).toBeInTheDocument()
    expect(screen.queryByTestId('orders-load-error')).toBeNull()
  })

  it('exits skeleton into recoverable error state without leaking A list or detail when B first load fails after A -> B switch', async () => {
    const orderItemB: UserOrderListItem = {
      ...ORDER_ITEM_A,
      id: 902,
      orderNo: 'ORD-SYNTH-B-902',
      product: {
        ...ORDER_ITEM_A.product,
        id: 43,
        name: '用户B专属商品',
      },
    }

    const snapshots: Snapshot[] = []
    render(
      <MemoryRouter initialEntries={['/orders']}>
        <Observer snapshots={snapshots}>
          <Routes>
            <Route path="/orders" element={<OrdersPage />} />
          </Routes>
        </Observer>
      </MemoryRouter>,
    )

    // Open A's order detail modal too so we prove neither list nor detail leaks
    fireEvent.click(await screen.findByText('用户A专属商品'))
    expect(await screen.findByText('SYNTH-ORDERS-PAGE-SECRET-A')).toBeInTheDocument()

    getOrdersPage
      .mockRejectedValueOnce(new Error('network error for B'))
      .mockResolvedValueOnce({
        items: [orderItemB],
        total: 1,
        page: 1,
        pageSize: 10,
        counts: { all: 1, active: 0, delivered: 1, done: 0 },
      })

    const beforeIdx = snapshots.length
    act(() => {
      signIn(202, 'sess-orders-b-fail', 2)
    })

    const firstBCommit = snapshots.slice(beforeIdx).find((s) => s.userId === 202)
    expect(firstBCommit).toBeDefined()
    expect(firstBCommit!.bodyText).not.toContain('用户A专属商品')
    expect(firstBCommit!.bodyText).not.toContain('SYNTH-ORDERS-PAGE-SECRET-A')

    expect(await screen.findByTestId('orders-load-error')).toBeInTheDocument()
    expect(screen.queryByText('还没有订单')).toBeNull()
    expect(document.body.textContent).not.toContain('用户A专属商品')
    expect(document.body.textContent).not.toContain('SYNTH-ORDERS-PAGE-SECRET-A')
    expect(document.body.querySelector('.animate-pulse')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('用户B专属商品')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('用户A专属商品')
  })

  it('keeps existing orders when a background refresh fails and updates when a subsequent refresh succeeds', async () => {
    const updatedItemA: UserOrderListItem = {
      ...ORDER_ITEM_A,
      id: 903,
      orderNo: 'ORD-SYNTH-A-903',
      product: {
        ...ORDER_ITEM_A.product,
        id: 44,
        name: '用户A更新后商品',
      },
    }

    render(
      <MemoryRouter initialEntries={['/orders']}>
        <Routes>
          <Route path="/orders" element={<OrdersPage />} />
        </Routes>
      </MemoryRouter>,
    )

    expect(await screen.findByText('用户A专属商品')).toBeInTheDocument()
    const triggerBackgroundReload = invalidationHandlers.get('buyer.orders')
    expect(triggerBackgroundReload).toBeTypeOf('function')

    // Background refresh fails -> existing data stays visible, no skeleton, no error state, no toast
    const failedBg = deferred<never>()
    getOrdersPage.mockReturnValueOnce(failedBg.promise)
    act(() => {
      triggerBackgroundReload!()
    })
    await act(async () => {
      failedBg.reject(new Error('transient background failure'))
    })

    expect(screen.getByText('用户A专属商品')).toBeInTheDocument()
    expect(screen.queryByTestId('orders-load-error')).toBeNull()
    expect(document.body.querySelector('.animate-pulse')).toBeNull()
    expect(useAppStore.getState().toasts).toHaveLength(0)

    // Subsequent background refresh succeeds -> updates list cleanly
    getOrdersPage.mockResolvedValueOnce({
      items: [updatedItemA],
      total: 1,
      page: 1,
      pageSize: 10,
      counts: { all: 1, active: 0, delivered: 1, done: 0 },
    })
    await act(async () => {
      triggerBackgroundReload!()
    })

    expect(await screen.findByText('用户A更新后商品')).toBeInTheDocument()
    expect(screen.queryByTestId('orders-load-error')).toBeNull()
  })
})
