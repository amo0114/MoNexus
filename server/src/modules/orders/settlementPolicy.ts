import { normalizeOrderStatus } from './statusPolicy.js'

export function getSettlementEligibility(orderStatus: string) {
  const status = normalizeOrderStatus(orderStatus)

  if (status === 'delivered' || status === 'closed') {
    return { payable: true, blockReason: null }
  }

  const blockReasons: Record<string, string> = {
    pending: '订单待处理，暂不可结算',
    processing: '订单履约中，暂不可结算',
    disputed: '订单争议中，暂不可结算',
    refunded: '订单已退款，不可结算',
  }

  return {
    payable: false,
    blockReason: blockReasons[status] ?? '订单状态不可结算',
  }
}
