import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { applyMerchant } from '../api/merchant'
import { getMe } from '../api/auth'
import { useAuthStore } from '../stores/authStore'
import { useAppStore } from '../stores/appStore'
import type { AuthUser, Merchant } from '../types/merchant'
import MerchantApplyPage from './MerchantApplyPage'

vi.mock('../api/merchant', () => ({ applyMerchant: vi.fn() }))
vi.mock('../api/auth', () => ({ getMe: vi.fn() }))

const user: AuthUser = { id: 1, email: 'apply@example.test', role: 'user', status: 'active', points: 10, merchant: null }
const application: Merchant = {
  id: 7, userId: 1, name: '接口返回的商家名', status: 'pending', commissionRate: '0.1',
  description: null, contactEmail: null, contactPhone: null, createdAt: '', updatedAt: '', approvedAt: null, approvedBy: null,
}
const pendingUser: AuthUser = { ...user, merchant: application }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
function LocationProbe() { return <output data-testid="route">{useLocation().pathname}{useLocation().search}</output> }
function renderPage(path = '/merchant/apply') {
  return render(<MemoryRouter initialEntries={[path]}><MerchantApplyPage /><LocationProbe /></MemoryRouter>)
}
function submit() {
  fireEvent.change(screen.getByLabelText(/商家名称/), { target: { value: '  提交的商家名  ' } })
  fireEvent.change(screen.getByLabelText('联系邮箱'), { target: { value: 'private@example.test' } })
  fireEvent.click(screen.getByRole('button', { name: '提交入驻申请' }))
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(window, 'matchMedia').mockImplementation(media => ({ matches: media.includes('767'), media }) as MediaQueryList)
  const token = `e30.${btoa(JSON.stringify({ userId: 1, sid: 'apply-session' }))}.test`
  useAuthStore.setState({ user, accessToken: token, sessionId: 'apply-session', authEpoch: 1, isLoggedIn: true })
  useAppStore.setState({ islandNoticeAvailable: true, islandNotice: null, islandQueue: [], modalDepth: 0, toasts: [] })
  vi.mocked(applyMerchant).mockResolvedValue(application)
  vi.mocked(getMe).mockResolvedValue(pendingUser)
})
afterEach(() => vi.restoreAllMocks())

it('uses the confirmed application and refreshes current status when its island action is followed', async () => {
  renderPage()
  submit()
  await screen.findByRole('heading', { name: '商家申请审核中' })
  await waitFor(() => expect(screen.getByRole('button', { name: '刷新申请状态' })).toBeEnabled())
  expect(applyMerchant).toHaveBeenCalledWith(expect.objectContaining({ name: '提交的商家名' }))
  const notice = useAppStore.getState().islandNotice!
  expect(notice.title).toBe('入驻申请已提交，待审核')
  expect(notice.subtitle).toBe(application.name)
  expect(notice.groupKey).toBe('merchant-application:7')
  expect(JSON.stringify(notice)).not.toContain('private@example.test')
  vi.mocked(getMe).mockResolvedValue({ ...user, role: 'merchant', merchant: { ...application, status: 'active' } })
  act(() => notice.onAction?.())
  await screen.findByRole('heading', { name: '您已经是商家了' })
  expect(screen.getByTestId('route')).toHaveTextContent('/merchant/apply?view=status')
  expect(getMe).toHaveBeenCalledTimes(2)
  expect(applyMerchant).toHaveBeenCalledOnce()
})

it('keeps successful submission if account refresh fails and retries only the read', async () => {
  vi.mocked(getMe).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(pendingUser)
  renderPage()
  submit()
  expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法刷新申请状态')
  expect(screen.getByRole('heading', { name: '商家申请审核中' })).toBeVisible()
  expect(useAuthStore.getState().user?.merchant?.id).toBe(7)
  expect(useAppStore.getState().islandNotice?.title).toContain('已提交')
  expect(screen.queryByRole('button', { name: '提交入驻申请' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '刷新申请状态' }))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(getMe).toHaveBeenCalledTimes(2)
  expect(applyMerchant).toHaveBeenCalledOnce()
})

it('blocks repeated submission and preserves failed input for retry', async () => {
  const request = deferred<Merchant>()
  vi.mocked(applyMerchant).mockReturnValueOnce(request.promise)
  renderPage()
  submit()
  const form = screen.getByLabelText(/商家名称/).closest('form')!
  fireEvent.submit(form)
  expect(applyMerchant).toHaveBeenCalledOnce()
  expect(useAppStore.getState().islandNotice).toBeNull()
  await act(async () => request.reject(new Error('offline')))
  expect(screen.getByRole('alert')).toHaveTextContent('入驻申请失败')
  expect(screen.getByLabelText('联系邮箱')).toHaveValue('private@example.test')
  expect(getMe).not.toHaveBeenCalled()
  fireEvent.submit(form)
  await screen.findByRole('heading', { name: '商家申请审核中' })
  expect(applyMerchant).toHaveBeenCalledTimes(2)
})

it('drops a late application after session replacement and resets the form', async () => {
  const request = deferred<Merchant>()
  vi.mocked(applyMerchant).mockReturnValue(request.promise)
  renderPage()
  submit()
  act(() => useAuthStore.setState({ authEpoch: 2 }))
  expect(screen.getByLabelText(/商家名称/)).toHaveValue('')
  await act(async () => request.resolve(application))
  expect(getMe).not.toHaveBeenCalled()
  expect(useAuthStore.getState().user?.merchant).toBeNull()
  expect(useAppStore.getState().islandNotice).toBeNull()
})

it('ignores an old status response after a session change', async () => {
  const request = deferred<AuthUser>()
  vi.mocked(getMe).mockReturnValueOnce(request.promise)
  renderPage()
  submit()
  await screen.findByRole('heading', { name: '商家申请审核中' })
  act(() => useAuthStore.setState({ authEpoch: 2, user }))
  await act(async () => request.resolve(pendingUser))
  expect(useAuthStore.getState().user?.merchant).toBeNull()
  expect(screen.getByLabelText(/商家名称/)).toHaveValue('')
})

it.each(['desktop', 'without-island'])('preserves inline success on %s', async mode => {
  if (mode === 'desktop') vi.mocked(window.matchMedia).mockReturnValue({ matches: false } as MediaQueryList)
  else useAppStore.setState({ islandNoticeAvailable: false })
  renderPage()
  submit()
  await screen.findByRole('heading', { name: '商家申请审核中' })
  expect(useAppStore.getState().islandNotice).toBeNull()
  expect(useAppStore.getState().toasts).toHaveLength(0)
})

it('shows a rejected application without offering an unsupported repeat registration', () => {
  useAuthStore.setState({ user: { ...pendingUser, merchant: { ...application, status: 'rejected' } } })
  renderPage()
  expect(screen.getByRole('heading', { name: '商家申请未通过' })).toBeVisible()
  expect(screen.queryByRole('button', { name: '提交入驻申请' })).toBeNull()
  expect(applyMerchant).not.toHaveBeenCalled()
})

it('does not announce an unconfirmed response as a successful application', async () => {
  vi.mocked(applyMerchant).mockResolvedValue({ ...application, userId: 99 })
  vi.mocked(getMe).mockResolvedValue(user)
  renderPage()
  submit()
  expect(await screen.findByRole('alert')).toHaveTextContent('申请结果待确认')
  expect(useAppStore.getState().islandNotice).toBeNull()
})
