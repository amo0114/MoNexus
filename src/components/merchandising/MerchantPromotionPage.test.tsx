import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import MerchantPromotionPage from './MerchantPromotionPage'
import { campaignFixture, packageFixture } from './promotionFixtures'
import type { PromotionCampaignDTO } from '../../types/merchandising'
import * as api from '../../api/merchandising'
import { getMe } from '../../api/auth'
import type { AuthUser } from '../../types/merchant'
import { useAppStore } from '../../stores/appStore'
import { useAuthStore } from '../../stores/authStore'

vi.mock('../../api/merchandising', async () => ({
  ...await vi.importActual<typeof import('../../api/merchandising')>('../../api/merchandising'),
  listPromotionPackages: vi.fn(), listPromotionCampaigns: vi.fn(),
  createPromotionCampaign: vi.fn(), cancelPromotionCampaign: vi.fn(), retryPromotionPayment: vi.fn(),
}))
vi.mock('../../api/auth', async () => ({
  ...await vi.importActual<typeof import('../../api/auth')>('../../api/auth'), getMe: vi.fn(),
}))
const fetchProducts = async () => [{ id: 42, name: '测试商品' }]
function LocationProbe() { const location = useLocation(); return <span data-testid="location">{location.pathname}{location.search}</span> }
function mount(path = '/merchant/promotions') {
  return render(<MemoryRouter initialEntries={[path]}><MerchantPromotionPage fetchProducts={fetchProducts} /><LocationProbe /></MemoryRouter>)
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
function list(campaigns: PromotionCampaignDTO[] = [], total = campaigns.length) {
  return { items: campaigns, total, page: 1, pageSize: 10 }
}
async function fillRequest() {
  fireEvent.change(await screen.findByLabelText('选择商品'), { target: { value: '42' } })
  fireEvent.click(screen.getByRole('radio', { name: /首页推广 7 天/ }))
  return screen.getByRole('button', { name: '提交申请' })
}
async function startAction(kind: 'cancel' | 'retry') {
  const button = await screen.findByRole('button', { name: kind === 'cancel' ? '取消申请' : '重试支付' })
  fireEvent.click(button)
  return screen.getByRole('button', { name: kind === 'cancel' ? '确认取消' : '确认重试' })
}

beforeEach(() => {
  vi.resetAllMocks()
  sessionStorage.clear()
  localStorage.clear()
  useAuthStore.setState({ user: null, accessToken: null, sessionId: null })
  vi.spyOn(window, 'matchMedia').mockImplementation(media => ({ matches: media.includes('767'), media, addEventListener() {}, removeEventListener() {} }) as MediaQueryList)
  Element.prototype.scrollIntoView = vi.fn()
  useAppStore.setState({ islandNoticeAvailable: true, islandNotice: null, islandQueue: [], toasts: [], modalDepth: 0 })
  vi.mocked(api.listPromotionPackages).mockResolvedValue([packageFixture()])
  vi.mocked(api.listPromotionCampaigns).mockResolvedValue(list())
})
afterEach(() => vi.restoreAllMocks())

describe('merchant promotion mobile completions', () => {
  it('submits once, preserves current filters, then opens an unfiltered first-page history from the island', async () => {
    sessionStorage.setItem('monexus.merch.promotion.filter', JSON.stringify('active'))
    sessionStorage.setItem('monexus.merch.promotion.page', '2')
    vi.mocked(api.listPromotionCampaigns).mockResolvedValue(list([], 30))
    const gate = deferred<PromotionCampaignDTO>()
    vi.mocked(api.createPromotionCampaign).mockReturnValue(gate.promise)
    mount()
    const submit = await fillRequest()
    act(() => { fireEvent.click(submit); fireEvent.click(submit) })
    expect(api.createPromotionCampaign).toHaveBeenCalledOnce()
    expect(submit).toBeDisabled()
    expect(useAppStore.getState().islandNotice).toBeNull()
    await act(async () => gate.resolve(campaignFixture('pending_review', { id: 9001 })))
    const notice = useAppStore.getState().islandNotice!
    expect(notice.title).toBe('推广申请已提交，待审核')
    expect(notice.subtitle).toContain('审核通过前不扣积分')
    expect(notice.groupKey).toBe('merchant-promotion:9001')
    expect(api.listPromotionCampaigns).toHaveBeenLastCalledWith({ status: 'active', page: 2, pageSize: 10 })
    act(() => notice.onAction?.())
    await waitFor(() => expect(api.listPromotionCampaigns).toHaveBeenLastCalledWith({ status: 'all', page: 1, pageSize: 10 }))
    expect(screen.getByTestId('location')).toHaveTextContent('/merchant/promotions?view=records')
    await waitFor(() => expect(screen.getByTestId('merchant-promotion-records')).toHaveFocus())
    expect(useAppStore.getState().toasts).toHaveLength(0)
  })

  it('cancels only after confirmation, blocks repeat writes and reports no charge', async () => {
    vi.mocked(api.listPromotionCampaigns).mockResolvedValue(list([campaignFixture('pending_review')]))
    const gate = deferred<PromotionCampaignDTO>()
    vi.mocked(api.cancelPromotionCampaign).mockReturnValueOnce(gate.promise)
    mount()
    const confirm = await startAction('cancel')
    expect(api.cancelPromotionCampaign).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '返回', exact: true }))
    expect(api.cancelPromotionCampaign).not.toHaveBeenCalled()
    const again = await startAction('cancel')
    act(() => { fireEvent.click(again); fireEvent.click(again) })
    expect(api.cancelPromotionCampaign).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled()
    await act(async () => gate.resolve(campaignFixture('cancelled', { chargedPoints: 0, refundedPoints: 0 })))
    expect(useAppStore.getState().islandNotice).toMatchObject({ title: '推广申请已取消', type: 'success' })
    expect(useAppStore.getState().islandNotice?.subtitle).toContain('取消时未扣积分')
    expect(confirm).not.toBeInTheDocument()
  })

  it.each(['active', 'scheduled', 'payment_failed'] as const)('uses the returned %s state after retry instead of assuming HTTP success means charged', async status => {
    vi.mocked(api.listPromotionCampaigns).mockResolvedValue(list([campaignFixture('payment_failed')]))
    vi.mocked(api.retryPromotionPayment).mockResolvedValue(campaignFixture(status, { chargedPoints: status === 'payment_failed' ? 0 : 73 }))
    mount()
    const confirm = await startAction('retry')
    expect(api.retryPromotionPayment).not.toHaveBeenCalled()
    expect(screen.getByText('确认重试支付？将按已批准的 100 积分扣款。')).toBeInTheDocument()
    fireEvent.click(confirm)
    if (status === 'payment_failed') {
      expect(await screen.findByRole('alert')).toHaveTextContent('推广尚未扣费')
      expect(useAppStore.getState().islandNotice).toBeNull()
      expect(useAppStore.getState().toasts).toEqual(expect.arrayContaining([expect.objectContaining({ message: '余额不足，推广未扣费', type: 'warning' })]))
      return
    }
    await waitFor(() => expect(useAppStore.getState().islandNotice).not.toBeNull())
    const notice = useAppStore.getState().islandNotice!
    expect(notice.title).toBe(status === 'active' ? '推广已生效' : '推广已排期')
    expect(notice.type).toBe('success')
    expect(notice.subtitle).toContain('已扣 73 积分')
  })

  it('keeps a failed request editable and reuses its idempotency key on retry', async () => {
    vi.mocked(api.createPromotionCampaign).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(campaignFixture('pending_review'))
    mount()
    fireEvent.click(await fillRequest())
    expect(await screen.findByRole('alert')).toHaveTextContent('网络异常')
    expect(useAppStore.getState().islandNotice).toBeNull()
    expect(screen.getByLabelText('选择商品')).toHaveValue('42')
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }))
    await waitFor(() => expect(useAppStore.getState().islandNotice?.title).toBe('推广申请已提交，待审核'))
    const calls = vi.mocked(api.createPromotionCampaign).mock.calls
    expect(calls[1][1]).toBe(calls[0][1])
  })

  it.each(['cancel', 'retry'] as const)('keeps %s failure recoverable without a completion island', async kind => {
    vi.mocked(api.listPromotionCampaigns).mockResolvedValue(list([campaignFixture(kind === 'cancel' ? 'pending_review' : 'payment_failed')]))
    const mutation = kind === 'cancel' ? vi.mocked(api.cancelPromotionCampaign) : vi.mocked(api.retryPromotionPayment)
    mutation.mockRejectedValueOnce(new Error('offline'))
    mutation.mockResolvedValueOnce(campaignFixture(kind === 'cancel' ? 'cancelled' : 'active'))
    mount()
    fireEvent.click(await startAction(kind))
    expect(await screen.findByRole('alert')).toHaveTextContent('网络异常')
    expect(useAppStore.getState().islandNotice).toBeNull()
    fireEvent.click(await startAction(kind))
    await waitFor(() => expect(useAppStore.getState().islandNotice).not.toBeNull())
    expect(mutation).toHaveBeenCalledTimes(2)
  })

  it.each(['create', 'cancel', 'retry'] as const)('drops late %s responses after the owning session changes', async kind => {
    const gate = deferred<PromotionCampaignDTO>()
    vi.mocked(api.listPromotionCampaigns).mockResolvedValue(list(kind === 'create' ? [] : [campaignFixture(kind === 'cancel' ? 'pending_review' : 'payment_failed')]))
    const mutation = kind === 'create' ? vi.mocked(api.createPromotionCampaign) : kind === 'cancel' ? vi.mocked(api.cancelPromotionCampaign) : vi.mocked(api.retryPromotionPayment)
    mutation.mockReturnValue(gate.promise)
    mount()
    fireEvent.click(kind === 'create' ? await fillRequest() : await startAction(kind))
    act(() => useAuthStore.setState({ authEpoch: useAuthStore.getState().authEpoch + 1 }))
    await waitFor(() => expect(screen.getByRole('button', { name: '提交申请' })).toBeInTheDocument())
    const loads = vi.mocked(api.listPromotionCampaigns).mock.calls.length
    await act(async () => gate.resolve(campaignFixture('active')))
    expect(useAppStore.getState().islandNotice).toBeNull()
    expect(api.listPromotionCampaigns).toHaveBeenCalledTimes(loads)
    expect(useAppStore.getState().toasts).toHaveLength(0)
  })

  it('never converts a successful create into a resubmit prompt if list refresh fails', async () => {
    vi.mocked(api.listPromotionCampaigns).mockResolvedValueOnce(list()).mockRejectedValueOnce(new Error('offline'))
    vi.mocked(api.createPromotionCampaign).mockResolvedValue(campaignFixture('pending_review'))
    mount()
    fireEvent.click(await fillRequest())
    await waitFor(() => expect(useAppStore.getState().islandNotice?.title).toBe('推广申请已提交，待审核'))
    expect(screen.getByRole('status')).toHaveTextContent('申请已提交')
    expect(await screen.findByRole('button', { name: '重新加载' })).toBeInTheDocument()
    expect(api.createPromotionCampaign).toHaveBeenCalledOnce()
  })

  it('ignores an older list response after filters change', async () => {
    const old = deferred<ReturnType<typeof list>>()
    vi.mocked(api.listPromotionCampaigns).mockReturnValueOnce(old.promise).mockResolvedValueOnce(list([campaignFixture('active')]))
    mount()
    fireEvent.click(screen.getByRole('button', { name: '展示中', exact: true }))
    await screen.findByText('测试商品')
    await act(async () => old.resolve(list([campaignFixture('pending_review', { productName: '旧筛选商品' })])))
    expect(screen.queryByText('旧筛选商品')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '展示中', exact: true })).toHaveAttribute('aria-pressed', 'true')
  })

  it('waits for the purchase form layout before focusing a directly opened history', async () => {
    const packages = deferred<ReturnType<typeof packageFixture>[]>()
    vi.mocked(api.listPromotionPackages).mockReturnValueOnce(packages.promise)
    mount('/merchant/promotions?view=records')
    await screen.findByText('没有符合条件的推广申请。')
    expect(screen.getByTestId('merchant-promotion-records')).not.toHaveFocus()
    await act(async () => packages.resolve([packageFixture()]))
    expect(screen.getByTestId('merchant-promotion-records')).toHaveFocus()
  })

  it('keeps desktop inline feedback and correctly describes an idempotent create replay', async () => {
    vi.mocked(window.matchMedia).mockImplementation(media => ({ matches: false, media, addEventListener() {}, removeEventListener() {} }) as MediaQueryList)
    vi.mocked(api.createPromotionCampaign).mockResolvedValue(campaignFixture('active'))
    mount()
    fireEvent.click(await fillRequest())
    expect(await screen.findByRole('status')).toHaveTextContent('推广正在展示中')
    expect(screen.getByRole('status')).not.toHaveTextContent('等待平台审核')
    expect(useAppStore.getState().islandNotice).toBeNull()
    expect(useAppStore.getState().toasts).toHaveLength(0)
  })

  it.each(['success', 'failure', 'session-change'] as const)('refreshes authoritative balance after charging: %s', async outcome => {
    const user: AuthUser = { id: 9, email: 'merchant@example.test', role: 'merchant', status: '正常', points: 150, merchant: null }
    const accessToken = `e30.${btoa(JSON.stringify({ userId: 9, sid: 'promotion-session' }))}.test`
    useAuthStore.setState({ user, accessToken, sessionId: 'promotion-session' })
    const gate = deferred<AuthUser>()
    vi.mocked(getMe).mockReturnValueOnce(gate.promise)
    vi.mocked(api.listPromotionCampaigns).mockResolvedValue(list([campaignFixture('payment_failed')]))
    vi.mocked(api.retryPromotionPayment).mockResolvedValue(campaignFixture('active'))
    mount()
    fireEvent.click(await startAction('retry'))
    await waitFor(() => expect(getMe).toHaveBeenCalledOnce())
    expect(useAppStore.getState().islandNotice?.title).toBe('推广已生效')
    if (outcome === 'session-change') {
      act(() => useAuthStore.setState({ user: null, accessToken: null, sessionId: null, authEpoch: useAuthStore.getState().authEpoch + 1 }))
    }
    await act(async () => {
      if (outcome === 'failure') gate.reject(new Error('offline'))
      else gate.resolve({ ...user, points: 31 })
    })
    if (outcome === 'success') expect(useAuthStore.getState().user?.points).toBe(31)
    else if (outcome === 'session-change') expect(useAuthStore.getState().user).toBeNull()
    else {
      expect(screen.getByRole('alert')).toHaveTextContent('推广已扣费，但余额刷新失败')
      expect(useAppStore.getState().islandNotice?.title).toBe('推广已生效')
      expect(useAuthStore.getState().user?.points).toBe(150)
    }
  })
})
