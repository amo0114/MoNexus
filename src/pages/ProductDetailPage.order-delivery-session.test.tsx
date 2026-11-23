import { useLayoutEffect, type ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { CheckoutPreview } from '../api/orders'
import { getAuthSessionContext } from '../auth/sessionContext'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import OrderSuccessIsland from '../components/OrderSuccessIsland'

const { apiGet, createOrder, getCheckoutPreview, viewportState } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  createOrder: vi.fn(),
  getCheckoutPreview: vi.fn(),
  viewportState: { mobile: false, desktop: true },
}))

vi.mock('../components/purchaseConfirmArm', () => ({ CONFIRM_ARM_MS: 0 }))
vi.mock('../hooks/useMediaQuery', () => ({
  useIsMobileViewport: () => viewportState.mobile,
  useIsDesktopViewport: () => viewportState.desktop,
  useMediaQuery: (query: string) => {
    if (query === '(prefers-reduced-motion: reduce)') return false
    if (query === '(max-width: 767px)') return viewportState.mobile
    if (query === '(min-width: 1024px)') return viewportState.desktop
    return false
  },
}))
vi.mock('../api/client', () => ({
  default: { get: apiGet, post: vi.fn(), patch: vi.fn() },
}))
vi.mock('../api/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/orders')>()
  return {
    ...actual,
    createOrder,
    getCheckoutPreview,
    getOrderAttentionCount: vi.fn().mockResolvedValue(0),
    getOrderDetail: vi.fn(),
  }
})

import ProductDetailPage from './ProductDetailPage'

function makeJwt(userId: number, sid: string, exp = 4102444800): string {
  const payload = btoa(JSON.stringify({ userId, sid, exp })).replace(/=+$/, '')
  return `header.${payload}.sig`
}

function signIn(userId: number, sid: string, authEpoch: number, points = 500, exp = 4102444800) {
  useAuthStore.setState({
    user: {
      id: userId,
      email: `user-${userId}@synthetic.test`,
      role: 'user',
      status: 'active',
      points,
      merchant: null,
    },
    accessToken: makeJwt(userId, sid, exp),
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

const PUBLIC_PRODUCT = {
  id: 42,
  name: '合成公开商品',
  description: '公开商品描述',
  type: '充值卡密',
  icon: 'box',
  imageUrl: '',
  price: 100,
  stock: 10,
  stockMode: 'limited',
  sales: 1,
  visibility: 'public',
  merchant: null,
  offers: [
    {
      id: 7,
      name: '默认规格',
      price: 100,
      originalPrice: null,
      status: 'active',
      deliveryMode: 'instant_inventory',
      stockMode: 'limited',
      stock: 10,
      sales: 1,
      availability: { status: 'available' },
    },
  ],
}

function makePreview(overrides: Partial<CheckoutPreview> = {}): CheckoutPreview {
  return {
    productId: 42,
    productName: '合成公开商品',
    offerId: 7,
    offerName: '默认规格',
    price: 100,
    deliveryMode: 'instant_inventory',
    chargeType: 'debit',
    balanceBefore: 500,
    balanceAfter: 400,
    sufficient: true,
    purchasable: true,
    purchaseForm: [],
    purchaseFormVersion: 'pf-v1',
    checkoutVersion: 'co-v1',
    requiresVerification: false,
    autoProvision: false,
    productContentVersion: 1,
    assuranceGrantId: null,
    ...overrides,
  }
}

interface CommitSnapshot {
  isLoggedIn: boolean
  userId: number | null
  sessionId: string | null
  authEpoch: number
  bodyText: string
  hasSuccessModalTitle: boolean
  hasOrderIslandAction: boolean
  mobileCtaText: string | null
}

function CommitObserver({
  snapshots,
  children,
}: {
  snapshots: CommitSnapshot[]
  children: ReactNode
}) {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn)
  const userId = useAuthStore((s) => s.user?.id ?? null)
  const sessionId = useAuthStore((s) => s.sessionId)
  const authEpoch = useAuthStore((s) => s.authEpoch)

  useLayoutEffect(() => {
    const mobileCta = document.body.querySelector('[data-testid="mobile-buy-bar-cta"]')
    snapshots.push({
      isLoggedIn,
      userId,
      sessionId,
      authEpoch,
      bodyText: document.body.textContent ?? '',
      hasSuccessModalTitle: document.body.querySelector('[data-testid="success-modal-title"]') !== null,
      hasOrderIslandAction: document.body.querySelector('[data-testid="order-success-island"]') !== null,
      mobileCtaText: mobileCta?.textContent ?? null,
    })
  })

  return <>{children}</>
}

function MobileIslandHost() {
  const notice = useAppStore((s) => s.islandNotice)
  const orderNotice = notice?.kind === 'order_processing' || notice?.kind === 'order_success' ? notice : null
  return (
    <OrderSuccessIsland
      notice={orderNotice}
      obscured={false}
      onOpenChange={() => {}}
      onHeightChange={() => {}}
      onPhaseChange={() => {}}
    />
  )
}

function OrdersRouteSpy() {
  const location = useLocation()
  return <div data-testid="orders-route">{`${location.pathname}${location.search}`}</div>
}

function renderDetail(snapshots: CommitSnapshot[], includeMobileIsland = false) {
  return render(
    <MemoryRouter initialEntries={['/product/42']}>
      <CommitObserver snapshots={snapshots}>
        {includeMobileIsland && <MobileIslandHost />}
        <Routes>
          <Route path="/product/:id" element={<ProductDetailPage />} />
          <Route path="/orders" element={<OrdersRouteSpy />} />
          <Route path="/login" element={<div data-testid="login-route" />} />
        </Routes>
      </CommitObserver>
    </MemoryRouter>,
  )
}

async function openPurchaseAndConfirm() {
  fireEvent.click(screen.getAllByRole('button', { name: '立即兑换' })[0])
  await screen.findByTestId('purchase-modal')
  await screen.findByTestId('preview-price')
  fireEvent.click(screen.getByRole('button', { name: '确认支付' }))
}

describe('ProductDetailPage order delivery session isolation (P0)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    viewportState.mobile = false
    viewportState.desktop = true
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    useAppStore.setState({
      toasts: [],
      islandNotice: null,
      islandQueue: [],
      islandNoticeAvailable: true,
      modalDepth: 0,
    })
    signIn(101, 'sess-a-1', 1, 500)
    apiGet.mockImplementation((url: string) => {
      if (url === '/products/42') return Promise.resolve({ data: PUBLIC_PRODUCT })
      if (typeof url === 'string' && url.startsWith('/products/42/reviews')) {
        return Promise.resolve({ data: { items: [], total: 0, page: 1, pageSize: 20 } })
      }
      if (url === '/product-templates') return Promise.resolve({ data: { templates: [] } })
      return Promise.reject(new Error(`unexpected GET ${url}`))
    })
    getCheckoutPreview.mockResolvedValue(makePreview())
    createOrder.mockResolvedValue({
      orderId: 5001,
      productName: '合成公开商品',
      price: 100,
      status: 'delivered',
      deliveryMode: 'instant_inventory',
      deliveryContent: 'SYNTH-SECRET-DELIVERY-A1',
      deliveryContentType: 'text',
      balanceAfter: 400,
      merchantId: null,
      merchantName: '合成测试商家A',
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('A -> guest: removes delivery content on the very first DOM commit and never remounts SuccessModal after guest reloads the public product', async () => {
    const guestReload = deferred<{ data: typeof PUBLIC_PRODUCT }>()
    let productCalls = 0
    apiGet.mockImplementation((url: string) => {
      if (url === '/products/42') {
        productCalls += 1
        // 1: initial load for A, 2: post-purchase refresh for A, 3: guest reload after session expires
        if (productCalls === 3) return guestReload.promise
        return Promise.resolve({ data: PUBLIC_PRODUCT })
      }
      if (typeof url === 'string' && url.startsWith('/products/42/reviews')) {
        return Promise.resolve({ data: { items: [], total: 0, page: 1, pageSize: 20 } })
      }
      if (url === '/product-templates') return Promise.resolve({ data: { templates: [] } })
      return Promise.reject(new Error(`unexpected GET ${url}`))
    })

    const snapshots: CommitSnapshot[] = []
    renderDetail(snapshots)
    await screen.findByRole('heading', { level: 1, name: '合成公开商品' })

    await openPurchaseAndConfirm()
    expect(await screen.findByTestId('success-modal-title')).toBeInTheDocument()
    expect(screen.getByTestId('delivery-text-content')).toHaveTextContent('SYNTH-SECRET-DELIVERY-A1')

    const beforeLogoutIdx = snapshots.length
    act(() => {
      useAuthStore.getState().invalidateLocalSessionFromAnotherTab()
    })

    const firstGuestCommit = snapshots.slice(beforeLogoutIdx).find((s) => !s.isLoggedIn)
    expect(firstGuestCommit).toBeDefined()
    expect(firstGuestCommit!.hasSuccessModalTitle).toBe(false)
    expect(firstGuestCommit!.bodyText).not.toContain('SYNTH-SECRET-DELIVERY-A1')
    expect(firstGuestCommit!.bodyText).not.toContain('合成测试商家A')

    await act(async () => {
      guestReload.resolve({ data: PUBLIC_PRODUCT })
    })

    expect(await screen.findByRole('heading', { level: 1, name: '合成公开商品' })).toBeInTheDocument()
    expect(screen.queryByTestId('success-modal-title')).toBeNull()
    expect(screen.queryByText('SYNTH-SECRET-DELIVERY-A1')).toBeNull()
    expect(screen.getAllByRole('button', { name: '登录后兑换' }).length).toBeGreaterThan(0)
  })

  it('A -> guest: clears structured and file delivery payloads on first commit and after public reload', async () => {
    createOrder.mockResolvedValueOnce({
      orderId: 5002,
      productName: '合成公开商品',
      price: 100,
      status: 'delivered',
      deliveryMode: 'instant_inventory',
      deliveryStructuredContent: {
        fields: [{ key: 'secret_key', label: '访问密钥', type: 'text', sensitive: false }],
        values: { secret_key: 'SYNTH-STRUCTURED-VALUE-A2' },
      },
      deliveryFile: { fileName: 'synth-private-package-a2.zip', size: 4096 },
      balanceAfter: 400,
      merchantId: null,
      merchantName: null,
    })

    const snapshots: CommitSnapshot[] = []
    renderDetail(snapshots)
    await screen.findByRole('heading', { level: 1, name: '合成公开商品' })

    await openPurchaseAndConfirm()
    expect(await screen.findByTestId('success-modal-title')).toBeInTheDocument()
    expect(document.body.textContent).toContain('SYNTH-STRUCTURED-VALUE-A2')
    expect(document.body.textContent).toContain('synth-private-package-a2.zip')

    const beforeIdx = snapshots.length
    act(() => {
      signOut(2)
    })

    const firstGuestCommit = snapshots.slice(beforeIdx).find((s) => !s.isLoggedIn)
    expect(firstGuestCommit).toBeDefined()
    expect(firstGuestCommit!.hasSuccessModalTitle).toBe(false)
    expect(firstGuestCommit!.bodyText).not.toContain('SYNTH-STRUCTURED-VALUE-A2')
    expect(firstGuestCommit!.bodyText).not.toContain('synth-private-package-a2.zip')

    await screen.findByRole('heading', { level: 1, name: '合成公开商品' })
    expect(screen.queryByTestId('success-modal-title')).toBeNull()
    expect(document.body.textContent).not.toContain('SYNTH-STRUCTURED-VALUE-A2')
    expect(document.body.textContent).not.toContain('synth-private-package-a2.zip')
  })

  it('A -> B: removes delivery modal and content on the very first DOM commit for user B', async () => {
    const snapshots: CommitSnapshot[] = []
    renderDetail(snapshots)
    await screen.findByRole('heading', { level: 1, name: '合成公开商品' })

    await openPurchaseAndConfirm()
    expect(await screen.findByTestId('success-modal-title')).toBeInTheDocument()
    expect(screen.getByTestId('delivery-text-content')).toHaveTextContent('SYNTH-SECRET-DELIVERY-A1')

    const beforeSwitchIdx = snapshots.length
    act(() => {
      signIn(202, 'sess-b-1', 2, 800)
    })

    const firstBCommit = snapshots.slice(beforeSwitchIdx).find((s) => s.userId === 202)
    expect(firstBCommit).toBeDefined()
    expect(firstBCommit!.hasSuccessModalTitle).toBe(false)
    expect(firstBCommit!.bodyText).not.toContain('SYNTH-SECRET-DELIVERY-A1')
    expect(screen.queryByTestId('success-modal-title')).toBeNull()
  })

  it('same account with new sessionId: removes delivery modal and content on the very first DOM commit', async () => {
    const snapshots: CommitSnapshot[] = []
    renderDetail(snapshots)
    await screen.findByRole('heading', { level: 1, name: '合成公开商品' })

    await openPurchaseAndConfirm()
    expect(await screen.findByTestId('success-modal-title')).toBeInTheDocument()
    expect(screen.getByTestId('delivery-text-content')).toHaveTextContent('SYNTH-SECRET-DELIVERY-A1')

    const beforeChangeIdx = snapshots.length
    act(() => {
      // Same userId=101, same authEpoch=1, but rotated to a brand new sessionId
      signIn(101, 'sess-a-2', 1, 400)
    })

    const firstNewSessionCommit = snapshots.slice(beforeChangeIdx).find((s) => s.sessionId === 'sess-a-2')
    expect(firstNewSessionCommit).toBeDefined()
    expect(firstNewSessionCommit!.hasSuccessModalTitle).toBe(false)
    expect(firstNewSessionCommit!.bodyText).not.toContain('SYNTH-SECRET-DELIVERY-A1')
    expect(screen.queryByTestId('success-modal-title')).toBeNull()
  })

  it.each([
    ['A -> guest', () => signOut(2), null],
    ['A -> B', () => signIn(202, 'sess-b-late', 2, 999), 999],
    ['same account new sessionId', () => signIn(101, 'sess-a-late-2', 1, 777), 777],
  ])('late createOrder response after %s cannot open SuccessModal or overwrite current user points', async (_label, transition, expectedPoints) => {
    const lateOrder = deferred<Record<string, unknown>>()
    createOrder.mockReturnValueOnce(lateOrder.promise)

    const snapshots: CommitSnapshot[] = []
    renderDetail(snapshots)
    await screen.findByRole('heading', { level: 1, name: '合成公开商品' })

    await openPurchaseAndConfirm()
    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(1))

    act(() => {
      transition()
    })

    await act(async () => {
      lateOrder.resolve({
        orderId: 5009,
        productName: '合成公开商品',
        price: 100,
        status: 'delivered',
        deliveryMode: 'instant_inventory',
        deliveryContent: 'SYNTH-LATE-ORDER-SECRET',
        deliveryContentType: 'text',
        balanceAfter: 123,
        merchantId: null,
        merchantName: null,
      })
    })

    expect(screen.queryByTestId('success-modal-title')).toBeNull()
    expect(document.body.textContent).not.toContain('SYNTH-LATE-ORDER-SECRET')
    expect(useAuthStore.getState().user?.points ?? null).toBe(expectedPoints)
  })

  it('mobile order island notice and recent-order CTA are scoped to the originating session (immediate clear + late response blocked)', async () => {
    viewportState.mobile = true
    viewportState.desktop = false

    const snapshots: CommitSnapshot[] = []
    renderDetail(snapshots, true)
    await screen.findByRole('heading', { level: 1, name: '合成公开商品' })

    await openPurchaseAndConfirm()
    await waitFor(() => expect(useAppStore.getState().islandNotice?.kind).toBe('order_success'))
    expect(screen.getByTestId('mobile-buy-bar-cta')).toHaveTextContent('查看本次订单')
    expect(screen.getByTestId('order-success-island')).toBeInTheDocument()

    // Switch session A -> B: first DOM commit must drop BOTH OrderSuccessIsland content and "查看本次订单"
    const beforeSwitchIdx = snapshots.length
    act(() => {
      signIn(202, 'sess-b-mobile', 2, 700)
    })

    const firstBCommit = snapshots.slice(beforeSwitchIdx).find((s) => s.userId === 202)
    expect(firstBCommit).toBeDefined()
    expect(firstBCommit!.hasOrderIslandAction).toBe(false)
    expect(firstBCommit!.mobileCtaText).not.toContain('查看本次订单')
    expect(useAppStore.getState().islandNotice).toBeNull()
    expect(screen.queryByTestId('order-success-island')).toBeNull()
    expect(screen.getByTestId('mobile-buy-bar-cta')).toHaveTextContent('立即兑换')

    // Now test late mobile order response: B starts purchase, switches to guest before response arrives
    const lateMobileOrder = deferred<Record<string, unknown>>()
    createOrder.mockReturnValueOnce(lateMobileOrder.promise)

    fireEvent.click(screen.getByTestId('mobile-buy-bar-cta'))
    await screen.findByTestId('purchase-modal')
    await screen.findByTestId('preview-price')
    fireEvent.click(screen.getByRole('button', { name: '确认支付' }))
    await waitFor(() => expect(createOrder).toHaveBeenCalledTimes(2))

    act(() => {
      signOut(3)
    })

    await act(async () => {
      lateMobileOrder.resolve({
        orderId: 5010,
        productName: '合成公开商品',
        price: 100,
        status: 'delivered',
        deliveryMode: 'instant_inventory',
        deliveryContent: 'SYNTH-LATE-MOBILE-SECRET',
        deliveryContentType: 'text',
        balanceAfter: 600,
        merchantId: null,
        merchantName: null,
      })
    })

    await screen.findByRole('heading', { level: 1, name: '合成公开商品' })
    expect(useAppStore.getState().islandNotice).toBeNull()
    expect(screen.queryByTestId('order-success-island')).toBeNull()
    expect(screen.getByTestId('mobile-buy-bar-cta')).toHaveTextContent('登录后兑换')
  })

  it('normal same-session token rotation keeps SuccessModal open on desktop and preserves mobile order notice and recent-order CTA', async () => {
    const snapshots: CommitSnapshot[] = []
    const desktopView = renderDetail(snapshots)
    await screen.findByRole('heading', { level: 1, name: '合成公开商品' })

    await openPurchaseAndConfirm()
    expect(await screen.findByTestId('success-modal-title')).toBeInTheDocument()
    expect(screen.getByTestId('delivery-text-content')).toHaveTextContent('SYNTH-SECRET-DELIVERY-A1')

    // Reveal the scratch coating so we also verify no remount resets local modal state
    fireEvent.click(screen.getByTestId('scratch-reveal-button'))
    expect(screen.getByTestId('scratch-reveal')).toHaveAttribute('data-revealed', 'true')

    const ctx = getAuthSessionContext(useAuthStore.getState())!
    expect(ctx).not.toBeNull()
    act(() => {
      const rotated = useAuthStore
        .getState()
        .setAccessTokenForSession(makeJwt(101, 'sess-a-1', 4102448400), ctx)
      expect(rotated).toBe(true)
    })

    expect(screen.getByTestId('success-modal-title')).toBeInTheDocument()
    expect(screen.getByTestId('delivery-text-content')).toHaveTextContent('SYNTH-SECRET-DELIVERY-A1')
    expect(screen.getByTestId('scratch-reveal')).toHaveAttribute('data-revealed', 'true')
    desktopView.unmount()

    // Mobile flow: token rotation keeps island notice & "查看本次订单" active
    viewportState.mobile = true
    viewportState.desktop = false
    const mobileSnapshots: CommitSnapshot[] = []
    renderDetail(mobileSnapshots, true)
    await screen.findByRole('heading', { level: 1, name: '合成公开商品' })

    await openPurchaseAndConfirm()
    await waitFor(() => expect(useAppStore.getState().islandNotice?.kind).toBe('order_success'))
    expect(screen.getByTestId('mobile-buy-bar-cta')).toHaveTextContent('查看本次订单')

    const mobileCtx = getAuthSessionContext(useAuthStore.getState())!
    act(() => {
      const rotated = useAuthStore
        .getState()
        .setAccessTokenForSession(makeJwt(101, 'sess-a-1', 4102452000), mobileCtx)
      expect(rotated).toBe(true)
    })

    expect(useAppStore.getState().islandNotice?.kind).toBe('order_success')
    expect(screen.getByTestId('mobile-buy-bar-cta')).toHaveTextContent('查看本次订单')
    fireEvent.click(screen.getByTestId('mobile-buy-bar-cta'))
    expect(await screen.findByTestId('orders-route')).toHaveTextContent('/orders?focus=5001')
  })
})
