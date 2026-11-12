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
    className: 'bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] text-[var(--color-primary)] border-[color-mix(in_srgb,var(--color-primary)_25%,transparent)]',
  },
  pending_payment: {
    label: '等待支付',
    description: '等待完成渠道支付',
    className: 'bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] text-[var(--color-warning)] border-[color-mix(in_srgb,var(--color-warning)_25%,transparent)]',
  },
  closure_pending: {
    label: '关闭确认中',
    description: '正在核实渠道是否已支付或关闭，结果尚未确定',
    className: 'bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] text-[var(--color-warning)] border-[color-mix(in_srgb,var(--color-warning)_25%,transparent)]',
  },
  paid: {
    label: '已支付，待积分入账',
    description: '渠道支付已成功，等待系统发放积分',
    className: 'bg-[color-mix(in_srgb,var(--color-info)_10%,transparent)] text-[var(--color-info)] border-[color-mix(in_srgb,var(--color-info)_25%,transparent)]',
  },
  credited: {
    label: '积分已入账',
    description: '本次充值积分已发放完毕',
    className: 'bg-[color-mix(in_srgb,var(--color-cta)_10%,transparent)] text-[var(--color-cta)] border-[color-mix(in_srgb,var(--color-cta)_25%,transparent)]',
  },
  failed: {
    label: '充值失败',
    description: '支付或入账流程失败',
    className: 'bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] text-[var(--color-danger)] border-[color-mix(in_srgb,var(--color-danger)_20%,transparent)]',
  },
  expired: {
    label: '已过期',
    description: '超出支付有效时间窗口',
    className: 'bg-[color-mix(in_srgb,var(--color-text-muted)_10%,transparent)] text-[var(--color-text-muted)] border-[var(--color-border)]',
  },
  cancelled: {
    label: '已取消',
    description: '主动取消的充值单',
    className: 'bg-[color-mix(in_srgb,var(--color-text-muted)_10%,transparent)] text-[var(--color-text-muted)] border-[var(--color-border)]',
  },
  refund_pending: {
    label: '退款处理中',
    description: '退款流程进行中，款项尚未完全退回',
    className: 'bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] text-[var(--color-warning)] border-[color-mix(in_srgb,var(--color-warning)_25%,transparent)]',
  },
  refunded: {
    label: '已退款',
    description: '款项已退回，涉及积分已完成处理',
    className: 'bg-[color-mix(in_srgb,var(--color-text-muted)_15%,transparent)] text-[var(--color-text)] border-[var(--color-border)]',
  },
  reconcile_required: {
    label: '待核对',
    description: '平台与渠道结果不一致，需人工核对',
    className: 'bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] text-[var(--color-danger)] border-[color-mix(in_srgb,var(--color-danger)_30%,transparent)]',
  },
}

export function getAdminRechargeStatusConfig(status: string): StatusBadgeConfig {
  if (status in ADMIN_RECHARGE_STATUS_CONFIG) {
    return ADMIN_RECHARGE_STATUS_CONFIG[status as RechargeOrderStatus]
  }
  return {
    label: status,
    description: '未知状态',
    className: 'bg-[color-mix(in_srgb,var(--color-text-muted)_10%,transparent)] text-[var(--color-text-muted)] border-[var(--color-border)]',
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
  requested: { label: '已申请', className: 'bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] text-[var(--color-warning)] border-[color-mix(in_srgb,var(--color-warning)_25%,transparent)]' },
  points_held: { label: '积分已冻结', className: 'bg-[color-mix(in_srgb,var(--color-info)_10%,transparent)] text-[var(--color-info)] border-[color-mix(in_srgb,var(--color-info)_25%,transparent)]' },
  processing: { label: '处理中', className: 'bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] text-[var(--color-primary)] border-[color-mix(in_srgb,var(--color-primary)_25%,transparent)]' },
  succeeded: { label: '已退款', className: 'bg-[color-mix(in_srgb,var(--color-cta)_10%,transparent)] text-[var(--color-cta)] border-[color-mix(in_srgb,var(--color-cta)_25%,transparent)]' },
  failed: { label: '退款失败', className: 'bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] text-[var(--color-danger)] border-[color-mix(in_srgb,var(--color-danger)_20%,transparent)]' },
  cancelled: { label: '已取消', className: 'bg-[color-mix(in_srgb,var(--color-text-muted)_10%,transparent)] text-[var(--color-text-muted)] border-[var(--color-border)]' },
  manual_review: { label: '待人工审核', className: 'bg-[color-mix(in_srgb,var(--color-danger)_15%,transparent)] text-[var(--color-danger)] border-[color-mix(in_srgb,var(--color-danger)_30%,transparent)]' },
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
