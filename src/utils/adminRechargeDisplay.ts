import type { RechargeOrderStatus } from '../pages/recharge/status'

export interface StatusBadgeConfig {
  label: string
  description?: string
  className: string
}

/**
 * 管理端充值订单 11 个状态的精确业务映射（audit 规范 §6.1）。
 * 绝不复用用户端的合并标签（如将 paid / credited 合并，或将 closure_pending 简写为关闭）。
 */
export const ADMIN_RECHARGE_STATUS_CONFIG: Record<RechargeOrderStatus, StatusBadgeConfig> = {
  created: {
    label: '已创建',
    description: '订单已创建，等待用户发起支付',
    className: 'bg-[var(--color-primary)]/10 text-[var(--color-primary)] border-[var(--color-primary)]/25',
  },
  pending_payment: {
    label: '等待支付',
    description: '等待完成渠道支付',
    className: 'bg-[var(--color-warning)]/10 text-[var(--color-warning)] border-[var(--color-warning)]/25',
  },
  closure_pending: {
    label: '关闭确认中',
    description: '正在核实渠道是否已支付或关闭，结果尚未确定',
    className: 'bg-[var(--color-warning)]/10 text-[var(--color-warning)] border-[var(--color-warning)]/25',
  },
  paid: {
    label: '已支付，待积分入账',
    description: '渠道支付已成功，等待系统发放积分',
    className: 'bg-[var(--color-info)]/10 text-[var(--color-info)] border-[var(--color-info)]/25',
  },
  credited: {
    label: '积分已入账',
    description: '本次充值积分已发放完毕',
    className: 'bg-[var(--color-cta)]/10 text-[var(--color-cta)] border-[var(--color-cta)]/25',
  },
  failed: {
    label: '充值失败',
    description: '支付或入账流程失败',
    className: 'bg-[var(--color-danger)]/10 text-[var(--color-danger)] border-[var(--color-danger)]/20',
  },
  expired: {
    label: '已过期',
    description: '超出支付有效时间窗口',
    className: 'bg-[var(--color-text-muted)]/10 text-[var(--color-text-muted)] border-[var(--color-border)]',
  },
  cancelled: {
    label: '已取消',
    description: '主动取消的充值单',
    className: 'bg-[var(--color-text-muted)]/10 text-[var(--color-text-muted)] border-[var(--color-border)]',
  },
  refund_pending: {
    label: '退款处理中',
    description: '退款流程进行中，款项尚未完全退回',
    className: 'bg-[var(--color-warning)]/10 text-[var(--color-warning)] border-[var(--color-warning)]/25',
  },
  refunded: {
    label: '已退款',
    description: '款项已退回，涉及积分已完成处理',
    className: 'bg-[var(--color-text-muted)]/15 text-[var(--color-text)] border-[var(--color-border)]',
  },
  reconcile_required: {
    label: '待核对',
    description: '平台与渠道结果不一致，需人工核对',
    className: 'bg-[var(--color-danger)]/10 text-[var(--color-danger)] border-[var(--color-danger)]/30',
  },
}

export function getAdminRechargeStatusConfig(status: string): StatusBadgeConfig {
  if (status in ADMIN_RECHARGE_STATUS_CONFIG) {
    return ADMIN_RECHARGE_STATUS_CONFIG[status as RechargeOrderStatus]
  }
  return {
    label: status,
    description: '未知状态',
    className: 'bg-[var(--color-text-muted)]/10 text-[var(--color-text-muted)] border-[var(--color-border)]',
  }
}

/** 支付尝试状态映射（audit §6.2） */
export const ATTEMPT_STATUS_LABEL: Record<string, string> = {
  created: '已创建',
  requires_action: '待完成支付步骤',
  processing: '渠道处理中',
  succeeded: '支付成功',
  failed: '支付失败',
  cancelled: '已取消',
  unknown: '待核实',
}

/** 充值退款状态映射（audit §6.2） */
export const REFUND_STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  requested: { label: '已申请', className: 'bg-[var(--color-warning)]/10 text-[var(--color-warning)] border-[var(--color-warning)]/25' },
  points_held: { label: '积分已冻结', className: 'bg-[var(--color-info)]/10 text-[var(--color-info)] border-[var(--color-info)]/25' },
  processing: { label: '处理中', className: 'bg-[var(--color-primary)]/10 text-[var(--color-primary)] border-[var(--color-primary)]/25' },
  succeeded: { label: '已退款', className: 'bg-[var(--color-cta)]/10 text-[var(--color-cta)] border-[var(--color-cta)]/25' },
  failed: { label: '退款失败', className: 'bg-[var(--color-danger)]/10 text-[var(--color-danger)] border-[var(--color-danger)]/20' },
  cancelled: { label: '已取消', className: 'bg-[var(--color-text-muted)]/10 text-[var(--color-text-muted)] border-[var(--color-border)]' },
  manual_review: { label: '待人工审核', className: 'bg-[var(--color-danger)]/15 text-[var(--color-danger)] border-[var(--color-danger)]/30' },
}

/** 支付事件来源映射（audit §6.2） */
export const PAYMENT_EVENT_SOURCE_LABEL: Record<string, string> = {
  webhook: '渠道通知',
  provider_query: '渠道查询',
  provider_complete: '支付完成确认',
  reconciliation: '对账核验',
}

/** 格式化佣金百分比展示：去除末尾无意义的 0，如 12.5% -> 12.5%，10.0% -> 10% */
export function formatCommissionRate(rate: number): string {
  if (!Number.isFinite(rate)) return '0%'
  const percent = rate * 100
  const formatted = percent.toFixed(2).replace(/\.?0+$/, '')
  return `${formatted}%`
}
