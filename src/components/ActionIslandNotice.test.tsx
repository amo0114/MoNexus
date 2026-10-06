import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ActionIslandNotice from './ActionIslandNotice'
import { useAppStore } from '../stores/appStore'

const visible = vi.fn()
function Host({ suppressed = false }) {
  const notice = useAppStore((s) => s.islandNotice)
  return <ActionIslandNotice notice={notice} suppressed={suppressed} onVisibleChange={visible} />
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({ matches: media.includes('767'), media, addEventListener() {}, removeEventListener() {} }) as MediaQueryList)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  useAppStore.setState({ islandNotice: null, islandQueue: [], islandNoticeAvailable: true, modalDepth: 0 })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('shows reward breakdown and executes its action once; dismissing does not execute it', () => {
  const action = vi.fn()
  useAppStore.getState().triggerIslandActivity({ kind: 'points', title: '签到成功 +15 积分', subtitle: '基础奖励 10 积分 · 等级加成 5 积分', actionLabel: '查看积分流水', onAction: action })
  render(<Host />)
  expect(screen.getByTestId('action-island-notice')).toHaveTextContent('基础奖励 10 积分 · 等级加成 5 积分')
  fireEvent.click(screen.getByRole('button', { name: '查看积分流水' }))
  expect(action).toHaveBeenCalledOnce()
  expect(useAppStore.getState().islandNotice).toBeNull()
  act(() => { useAppStore.getState().triggerIslandActivity({ kind: 'notification', title: '订单已交付', onAction: action }) })
  fireEvent.click(screen.getByRole('button', { name: '收起通知' }))
  expect(action).toHaveBeenCalledOnce()
})

it('pauses expiry behind search/modal and during keyboard interaction', () => {
  useAppStore.getState().triggerIslandActivity({ kind: 'notification', title: '订单已发货', actionLabel: '查看订单', onAction: vi.fn(), durationMs: 2000 })
  const { rerender } = render(<Host />)
  act(() => vi.advanceTimersByTime(500))
  rerender(<Host suppressed />)
  act(() => vi.advanceTimersByTime(5000))
  expect(useAppStore.getState().islandNotice).not.toBeNull()
  expect(screen.queryByTestId('action-island-notice')).toBeNull()
  rerender(<Host />)
  fireEvent.focus(screen.getByRole('button', { name: '查看订单' }))
  act(() => vi.advanceTimersByTime(5000))
  expect(useAppStore.getState().islandNotice).not.toBeNull()
  fireEvent.blur(screen.getByRole('button', { name: '查看订单' }))
  act(() => vi.advanceTimersByTime(1501))
  expect(useAppStore.getState().islandNotice).toBeNull()
})

it('reports presentation once across suppression and does not persist timeout as dismissal', () => {
  const presented = vi.fn(), dismissed = vi.fn()
  useAppStore.getState().triggerIslandActivity({ kind: 'notification', title: '普通公告', durationMs: 1000, onPresented: presented, onDismiss: dismissed })
  const view = render(<Host suppressed />)
  expect(presented).not.toHaveBeenCalled()
  view.rerender(<Host />)
  expect(presented).toHaveBeenCalledOnce()
  view.rerender(<Host suppressed />)
  view.rerender(<Host />)
  expect(presented).toHaveBeenCalledOnce()
  act(() => vi.advanceTimersByTime(1001))
  expect(useAppStore.getState().islandNotice).toBeNull()
  expect(dismissed).not.toHaveBeenCalled()
})

it('keeps the live region mounted and silent while obscured, with complete text on presentation', () => {
  const view = render(<Host suppressed />)
  const region = screen.getByRole('status')
  expect(region).toBeEmptyDOMElement()
  act(() => { useAppStore.getState().triggerIslandActivity({ kind: 'notification', title: '名额已调整', subtitle: '长商品名与实际剩余数量', durationMs: 1000 }) })
  expect(region).toBeEmptyDOMElement()
  view.rerender(<Host />)
  expect(screen.getByRole('status')).toBe(region)
  expect(region).toHaveTextContent('名额已调整，长商品名与实际剩余数量')
  expect(region).toHaveAttribute('aria-live', 'polite')
})

it('a same-group update does not restart expiry while keyboard focus remains on its action', () => {
  const update = (title: string) => useAppStore.getState().triggerIslandActivity({ kind: 'notification', groupKey: 'order:1', title, actionLabel: '查看订单', onAction: vi.fn(), durationMs: 1000 })
  update('订单已发货')
  render(<Host />)
  const button = screen.getByRole('button', { name: '查看订单' })
  act(() => button.focus())
  act(() => { update('订单已关闭'); vi.advanceTimersByTime(10_000) })
  expect(useAppStore.getState().islandNotice?.title).toBe('订单已关闭')
  act(() => vi.advanceTimersByTime(10_000))
  expect(button).toHaveFocus()
  expect(useAppStore.getState().islandNotice?.title).toBe('订单已关闭')
  fireEvent.keyDown(button, { key: 'Escape' })
  expect(useAppStore.getState().islandNotice).toBeNull()
})

it('pauses the active result in a background tab and clears the live region', () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  useAppStore.getState().triggerIslandActivity({ kind: 'notification', title: '操作已完成', durationMs: 1000 })
  render(<Host />)
  act(() => vi.advanceTimersByTime(300))
  visibility.mockReturnValue('hidden')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  act(() => vi.advanceTimersByTime(60_000))
  expect(screen.getByRole('status')).toBeEmptyDOMElement()
  expect(useAppStore.getState().islandNotice).not.toBeNull()
  visibility.mockReturnValue('visible')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  act(() => vi.advanceTimersByTime(701))
  expect(useAppStore.getState().islandNotice).toBeNull()
})
