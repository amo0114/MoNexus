import { useLayoutEffect, type ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { getAuthSessionContext } from '../auth/sessionContext'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import type { CheckoutPreview } from '../api/orders'
import type { UserOrderDetail } from '../types/order'

const {
  copyToClipboard,
  getOrderDetail,
  getMe,
  createOrder,
  getCheckoutPreview,
  renewOrder,
  issueOrderFileDownloadUrl,
} = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  getOrderDetail: vi.fn(),
  getMe: vi.fn(),
  createOrder: vi.fn(),
  getCheckoutPreview: vi.fn(),
  renewOrder: vi.fn(),
  issueOrderFileDownloadUrl: vi.fn(),
}))

vi.mock('./purchaseConfirmArm', () => ({ CONFIRM_ARM_MS: 0 }))
vi.mock('../utils/clipboard', () => ({ copyToClipboard }))
vi.mock('../api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/auth')>()
  return { ...actual, getMe }
})
vi.mock('../api/orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/orders')>()
  return {
    ...actual,
    getOrderDetail,
    createOrder,
    getCheckoutPreview,
    renewOrder,
    issueOrderFileDownloadUrl,
    getOrderAttentionCount: vi.fn().mockResolvedValue(0),
  }
})

import SuccessModal from './SuccessModal'
import OrderDetailModal from './OrderDetailModal'

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

interface Snapshot {
  isLoggedIn: boolean
  userId: number | null
  sessionId: string | null
  bodyText: string
  hasSuccessTitle: boolean
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
      hasSuccessTitle: document.body.querySelector('[data-testid="success-modal-title"]') !== null,
    })
  })
  return <>{children}</>
}

describe('SuccessModal & renewal delivery session isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    copyToClipboard.mockResolvedValue(true)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    useAppStore.setState({
      toasts: [],
      islandNotice: null,
      islandQueue: [],
      islandNoticeAvailable: false,
      modalDepth: 0,
    })
    signIn(101, 'sess-modal-1', 1, 500)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('never renders delivery content or starts polling when mounted in a guest session', async () => {
    vi.useFakeTimers()
    signOut(2)

    render(
      <SuccessModal
        deliveryContent="SYNTH-GUEST-MUST-NOT-SEE"
        deliveryContentType="text"
        orderId={701}
        provisionPending
        onClose={() => {}}
      />,
    )

    expect(screen.queryByTestId('success-modal-title')).toBeNull()
    expect(document.body.textContent).not.toContain('SYNTH-GUEST-MUST-NOT-SEE')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(getOrderDetail).not.toHaveBeenCalled()
  })

  it.each([
    ['A -> guest', () => signOut(2), (s: Snapshot) => !s.isLoggedIn],
    ['A -> B', () => signIn(202, 'sess-b-poll', 2, 600), (s: Snapshot) => s.userId === 202],
    ['same account new sessionId', () => signIn(101, 'sess-modal-2', 1, 500), (s: Snapshot) => s.sessionId === 'sess-modal-2'],
  ])('drops in-flight provision polling result and hides modal on first DOM commit (%s)', async (_label, transition, matchCommit) => {
    vi.useFakeTimers()
    const inFlightPoll = deferred<Record<string, unknown>>()
    getOrderDetail.mockReturnValueOnce(inFlightPoll.promise)

    const snapshots: Snapshot[] = []
    render(
      <Observer snapshots={snapshots}>
        <SuccessModal deliveryContent="" orderId={702} provisionPending onClose={() => {}} />
      </Observer>,
    )

    expect(screen.getByTestId('success-provision-pending')).toBeInTheDocument()

    // Trigger initial poll (800ms)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800)
    })
    expect(getOrderDetail).toHaveBeenCalledTimes(1)

    const beforeIdx = snapshots.length
    act(() => {
      transition()
    })

    const firstCommit = snapshots.slice(beforeIdx).find(matchCommit)
    expect(firstCommit).toBeDefined()
    expect(firstCommit!.hasSuccessTitle).toBe(false)

    // Late poll arrives with sensitive delivery data
    await act(async () => {
      inFlightPoll.resolve({
        status: 'delivered',
        delivery: { content: 'SYNTH-LATE-POLL-SECRET', contentType: 'text' },
      })
    })

    expect(screen.queryByTestId('success-modal-title')).toBeNull()
    expect(document.body.textContent).not.toContain('SYNTH-LATE-POLL-SECRET')

    // No further polling is scheduled
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(getOrderDetail).toHaveBeenCalledTimes(1)
    expect(getMe).not.toHaveBeenCalled()
  })

  it('drops a late refunded provision poll after session switch without calling getMe or showing refunded UI', async () => {
    vi.useFakeTimers()
    const inFlightPoll = deferred<Record<string, unknown>>()
    getOrderDetail.mockReturnValueOnce(inFlightPoll.promise)

    render(<SuccessModal deliveryContent="" orderId={704} provisionPending onClose={() => {}} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800)
    })
    expect(getOrderDetail).toHaveBeenCalledTimes(1)

    act(() => {
      signIn(202, 'sess-b-refund', 2, 900)
    })

    await act(async () => {
      inFlightPoll.resolve({ status: 'refunded' })
    })

    expect(screen.queryByTestId('success-provision-refunded')).toBeNull()
    expect(screen.queryByTestId('success-modal-title')).toBeNull()
    expect(getMe).not.toHaveBeenCalled()
    expect(useAuthStore.getState().user?.points).toBe(900)
  })

  it('restores buyer points when /auth/me resolves after refunded poll stops in the same session', async () => {
    vi.useFakeTimers()
    signIn(101, 'sess-refund-same', 1, 400)
    const lateMe = deferred<{ id: number; points: number }>()
    getOrderDetail.mockResolvedValueOnce({ status: 'refunded' })
    getMe.mockReturnValueOnce(lateMe.promise)

    render(<SuccessModal deliveryContent="" orderId={705} provisionPending onClose={() => {}} />)

    // Trigger poll -> receives refunded -> sets awaitingProvision=false -> runs polling effect cleanup
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800)
    })
    expect(screen.getByTestId('success-provision-refunded')).toBeInTheDocument()
    expect(getMe).toHaveBeenCalledTimes(1)

    // Same-session token rotation while /auth/me is still in flight
    const ctx = getAuthSessionContext(useAuthStore.getState())!
    act(() => {
      expect(
        useAuthStore.getState().setAccessTokenForSession(makeJwt(101, 'sess-refund-same', 4102460000), ctx),
      ).toBe(true)
    })

    // Late /auth/me finally resolves in the same session: balance must restore 400 -> 500
    await act(async () => {
      lateMe.resolve({ id: 101, points: 500 })
    })
    expect(useAuthStore.getState().user?.points).toBe(500)
  })

  it('drops late /auth/me balance refresh after refunded poll if session changed while /auth/me was in flight', async () => {
    vi.useFakeTimers()
    signIn(101, 'sess-refund-switch', 1, 400)
    const lateMe = deferred<{ id: number; points: number }>()
    getOrderDetail.mockResolvedValueOnce({ status: 'refunded' })
    getMe.mockReturnValueOnce(lateMe.promise)

    render(<SuccessModal deliveryContent="" orderId={706} provisionPending onClose={() => {}} />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800)
    })
    expect(getMe).toHaveBeenCalledTimes(1)

    act(() => {
      signIn(202, 'sess-b-after-refund', 2, 950)
    })

    await act(async () => {
      lateMe.resolve({ id: 101, points: 500 })
    })
    expect(useAuthStore.getState().user?.points).toBe(950)
  })

  it.each([
    ['A -> guest', () => signOut(2)],
    ['A -> B', () => signIn(202, 'sess-b-file', 2, 600)],
    ['same account new sessionId', () => signIn(101, 'sess-modal-2', 1, 500)],
  ])('blocks file download navigation when grant resolves after session change (%s)', async (_label, transition) => {
    const lateGrant = deferred<{ url: string }>()
    issueOrderFileDownloadUrl.mockReturnValueOnce(lateGrant.promise)
    const assignMock = vi.fn()
    vi.stubGlobal('location', { assign: assignMock })

    render(
      <SuccessModal
        deliveryContent=""
        deliveryFile={{ fileName: 'synth-secret.zip', size: 1024 }}
        orderId={707}
        onClose={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('file-delivery-download'))
    expect(issueOrderFileDownloadUrl).toHaveBeenCalledWith(707)

    // Session changes (unmounting SuccessModal / FileDeliveryCard) before grant is consumed
    act(() => {
      transition()
    })
    expect(screen.queryByTestId('file-delivery-download')).toBeNull()

    await act(async () => {
      lateGrant.resolve({ url: 'https://download.synthetic.test/signed-secret-a.zip' })
    })

    expect(assignMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('allows file download navigation when token rotates within the same session while grant is in flight', async () => {
    const inFlightGrant = deferred<{ url: string }>()
    issueOrderFileDownloadUrl.mockReturnValueOnce(inFlightGrant.promise)
    const assignMock = vi.fn()
    vi.stubGlobal('location', { assign: assignMock })

    render(
      <SuccessModal
        deliveryContent=""
        deliveryFile={{ fileName: 'synth-ok.zip', size: 1024 }}
        orderId={708}
        onClose={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('file-delivery-download'))
    expect(issueOrderFileDownloadUrl).toHaveBeenCalledWith(708)

    const ctx = getAuthSessionContext(useAuthStore.getState())!
    act(() => {
      expect(
        useAuthStore.getState().setAccessTokenForSession(makeJwt(101, 'sess-modal-1', 4102464000), ctx),
      ).toBe(true)
    })

    await act(async () => {
      inFlightGrant.resolve({ url: 'https://download.synthetic.test/signed-ok.zip' })
    })

    expect(assignMock).toHaveBeenCalledTimes(1)
    expect(assignMock).toHaveBeenCalledWith('https://download.synthetic.test/signed-ok.zip')
    vi.unstubAllGlobals()
  })

  it('continues provision polling and displays delivery after normal same-session token rotation', async () => {
    vi.useFakeTimers()
    getOrderDetail
      .mockResolvedValueOnce({ status: 'processing' })
      .mockResolvedValueOnce({
        status: 'delivered',
        delivery: { content: 'SYNTH-ROTATED-POLL-DELIVERY', contentType: 'text' },
      })

    render(<SuccessModal deliveryContent="" orderId={703} provisionPending onClose={() => {}} />)
    expect(screen.getByTestId('success-provision-pending')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800)
    })
    expect(getOrderDetail).toHaveBeenCalledTimes(1)

    const ctx = getAuthSessionContext(useAuthStore.getState())!
    act(() => {
      expect(
        useAuthStore.getState().setAccessTokenForSession(makeJwt(101, 'sess-modal-1', 4102455600), ctx),
      ).toBe(true)
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    expect(getOrderDetail).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('delivery-text-content')).toHaveTextContent('SYNTH-ROTATED-POLL-DELIVERY')
  })

  it('OrderDetailModal renewal SuccessModal hides immediately on session change', async () => {
    const order: UserOrderDetail = {
      id: 50,
      price: 100,
      status: 'delivered',
      deliveryMode: 'instant_inventory',
      createdAt: '2026-09-01T00:00:00.000Z',
      merchant: null,
      product: {
        id: 42,
        name: '续费测试商品',
        type: '网络节点',
        icon: 'box',
        imageUrl: null,
        deliveryMode: 'instant_inventory',
      },
      delivery: {
        status: 'delivered',
        content: 'SYNTH-ORIG-ORDER-SECRET',
        expiresAt: '2026-10-01T00:00:00.000Z',
        expired: false,
      },
      timeline: [],
      renewable: true,
    }
    const preview: CheckoutPreview = {
      productId: 42,
      productName: '续费测试商品',
      offerId: 11,
      offerName: '月卡',
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
      productContentVersion: 4,
      assuranceGrantId: null,
    }
    renewOrder.mockResolvedValue({
      productId: 42,
      offerId: 11,
      offerName: '月卡',
      price: 100,
      validityDays: 30,
      currentExpiresAt: '2026-10-01T00:00:00.000Z',
    })
    getCheckoutPreview.mockResolvedValue(preview)
    createOrder.mockResolvedValue({
      orderId: 808,
      productName: '续费测试商品',
      price: 100,
      status: 'delivered',
      deliveryMode: 'instant_inventory',
      deliveryContent: 'SYNTH-RENEW-DELIVERY-SECRET',
      deliveryContentType: 'text',
      balanceAfter: 400,
      merchantId: null,
      merchantName: null,
    })

    const snapshots: Snapshot[] = []
    render(
      <MemoryRouter>
        <Observer snapshots={snapshots}>
          <OrderDetailModal order={order} onClose={() => {}} />
        </Observer>
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByTestId('order-renew-button'))
    await screen.findByTestId('purchase-modal')
    await screen.findByTestId('preview-price')
    fireEvent.click(screen.getByRole('button', { name: '确认支付' }))

    expect(await screen.findByTestId('success-modal-title')).toBeInTheDocument()
    expect(document.body.textContent).toContain('SYNTH-RENEW-DELIVERY-SECRET')

    const beforeIdx = snapshots.length
    act(() => {
      signIn(202, 'sess-b-renew', 2, 700)
    })

    const firstBCommit = snapshots.slice(beforeIdx).find((s) => s.userId === 202)
    expect(firstBCommit).toBeDefined()
    expect(firstBCommit!.hasSuccessTitle).toBe(false)
    expect(firstBCommit!.bodyText).not.toContain('SYNTH-RENEW-DELIVERY-SECRET')
    expect(firstBCommit!.bodyText).not.toContain('SYNTH-ORIG-ORDER-SECRET')
    expect(screen.queryByTestId('success-modal-title')).toBeNull()
    expect(document.body.textContent).not.toContain('SYNTH-ORIG-ORDER-SECRET')
  })
})
