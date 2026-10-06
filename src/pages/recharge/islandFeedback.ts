import type { RechargeOrder } from '../../api/recharge'
import { useAppStore } from '../../stores/appStore'
import { captureFeedbackOwner } from '../../lib/completionFeedback'
import { formatPoints } from './money'

/** Uses only fetched order state. This helper does not poll or infer payment. */
export function createRechargeIslandFeedback(openHistory: () => void) {
  const isCurrent = captureFeedbackOwner()
  let lastStatus = ''
  let noticeId: number | undefined
  let credited = false
  const clear = () => {
    if (noticeId !== undefined) useAppStore.getState().removeIslandActivity(noticeId)
    noticeId = undefined
  }
  return {
    update(order: RechargeOrder, resumePayment: boolean) {
      if (!isCurrent() || order.adminSandbox) return
      const state = useAppStore.getState()
      if (!window.matchMedia('(max-width: 767px)').matches || !state.islandNoticeAvailable) return
      const status = `${order.orderId}:${order.status}`
      if (lastStatus === status) return
      lastStatus = status
      clear()
      credited = order.status === 'credited'
      if (credited) {
        noticeId = state.triggerIslandActivity({
          kind: 'points', title: `充值到账 +${formatPoints(order.totalPoints)} 积分`,
          subtitle: '积分已入账，可查看积分流水', type: 'success',
          groupKey: `recharge:${order.orderId}`, actionLabel: '查看积分流水',
          onAction: () => { if (isCurrent()) openHistory() },
        })
      } else if (order.status === 'paid' || order.status === 'closure_pending'
        || (resumePayment && (order.status === 'created' || order.status === 'pending_payment'))) {
        noticeId = state.triggerIslandActivity({
          kind: 'notification', title: '正在核实充值结果',
          subtitle: '到账后会显示实际积分，请以订单状态为准',
          groupKey: `recharge:${order.orderId}`, durationMs: 6000,
        })
      }
    },
    dispose() { if (!credited) clear() },
  }
}
