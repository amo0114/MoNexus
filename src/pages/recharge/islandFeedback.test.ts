import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRechargeIslandFeedback } from './islandFeedback'
import { useAppStore } from '../../stores/appStore'
import { useAuthStore } from '../../stores/authStore'
import type { RechargeOrder } from '../../api/recharge'
const order = (status: string, adminSandbox = false) => ({ orderId: 'r1', status, adminSandbox, totalPoints: '1200' }) as RechargeOrder
beforeEach(() => {
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => ({ matches: media.includes('767'), media }) as MediaQueryList)
  useAppStore.setState({ islandNotice: null, islandQueue: [], islandNoticeAvailable: true, toasts: [] })
})
afterEach(() => vi.restoreAllMocks())
it('does not treat a payment return as credit and updates to authoritative points once', () => {
  const action = vi.fn()
  const feedback = createRechargeIslandFeedback(action)
  feedback.update(order('pending_payment'), true)
  expect(useAppStore.getState().islandNotice?.title).toBe('正在核实充值结果')
  feedback.update(order('credited'), true)
  const notice = useAppStore.getState().islandNotice!
  expect(notice.title).toContain('1,200')
  expect(notice.kind).toBe('points')
  feedback.update(order('credited'), true)
  expect(useAppStore.getState().islandNotice?.id).toBe(notice.id)
  notice.onAction?.()
  expect(action).toHaveBeenCalledOnce()
})
it('removes stale queued progress after failure or departure without clearing another transaction', () => {
  const payment = useAppStore.getState().triggerIslandActivity({kind:'order_processing', title:'兑换中'})
  const feedback = createRechargeIslandFeedback(vi.fn())
  feedback.update(order('paid'), false)
  expect(useAppStore.getState().islandQueue).toHaveLength(1)
  feedback.update(order('failed'), true)
  expect(useAppStore.getState().islandQueue).toHaveLength(0)
  feedback.update(order('closure_pending'), false)
  feedback.dispose()
  expect(useAppStore.getState().islandQueue).toHaveLength(0)
  expect(useAppStore.getState().islandNotice?.id).toBe(payment)
})
it('keeps sandbox, desktop and stale-session responses out of the island', () => {
  const feedback = createRechargeIslandFeedback(vi.fn())
  feedback.update(order('credited', true), true)
  expect(useAppStore.getState().islandNotice).toBeNull()
  useAppStore.setState({islandNoticeAvailable:false})
  feedback.update(order('credited'), true)
  expect(useAppStore.getState().toasts).toHaveLength(0)
  useAppStore.setState({islandNoticeAvailable:true})
  useAuthStore.setState({authEpoch:useAuthStore.getState().authEpoch+1})
  feedback.update(order('credited'), true)
  expect(useAppStore.getState().islandNotice).toBeNull()
})
