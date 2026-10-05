/**
 * PointLog 买家展示：类型语义 + 配色（SPEC-CMI-UX-001 §6.1，D-UX-18）。
 * 流水记录的是历史动作，不代表订单当前支付状态。底层 in/out/hold/release 不变。
 */

export type PointLogType = 'in' | 'out' | 'hold' | 'release' | 'refund' | string

export interface PointLogVisual {
  /** 中文类型名 */
  typeLabel: string
  /** 金额前缀：+ / − / 冻 */
  amountPrefix: string
  /** Tailwind-ish token classes for amount text */
  amountClass: string
  /** Icon circle background + border + icon color */
  iconWrapClass: string
  /** Short helper under reason when useful */
  hint?: string
}

export function pointLogVisual(type: PointLogType): PointLogVisual {
  switch (type) {
    case 'in':
      return {
        typeLabel: '入账',
        amountPrefix: '+',
        amountClass: 'text-[var(--color-cta)]',
        iconWrapClass:
          'bg-[var(--color-cta)]/10 border border-[var(--color-cta)]/25 text-[var(--color-cta)]',
      }
    case 'out':
      return {
        typeLabel: '支付扣款',
        amountPrefix: '−',
        amountClass: 'text-[var(--color-danger)]',
        iconWrapClass:
          'bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/25 text-[var(--color-danger)]',
        hint: '已完成支付扣款；此前有冻结记录时，本次消耗冻结积分，不会再次扣减可用余额',
      }
    case 'hold':
      return {
        typeLabel: '积分冻结',
        amountPrefix: '冻',
        amountClass: 'text-[var(--color-warning)]',
        iconWrapClass:
          'bg-[var(--color-warning)]/12 border border-[var(--color-warning)]/30 text-[var(--color-warning)]',
        hint: '这是下单时的历史冻结记录，不表示当前仍冻结或待付款；后续扣款、解除冻结会另记流水，当前状态请查看关联订单',
      }
    case 'release':
      return {
        typeLabel: '解除冻结',
        amountPrefix: '+',
        amountClass: 'text-[var(--color-primary)]',
        iconWrapClass:
          'bg-[var(--color-primary)]/10 border border-[var(--color-primary)]/25 text-[var(--color-primary)]',
        hint: '此前冻结的积分已解除冻结并返还到可用余额，不属于新增收入',
      }
    case 'refund':
      return {
        typeLabel: '退款',
        amountPrefix: '+',
        amountClass: 'text-[var(--color-cta)]',
        iconWrapClass:
          'bg-[var(--color-cta)]/10 border border-[var(--color-cta)]/25 text-[var(--color-cta)]',
        hint: '订单退款返还',
      }
    case 'sandbox_in':
      return {
        typeLabel: '沙箱入账',
        amountPrefix: '+',
        amountClass: 'text-[var(--color-primary)]',
        iconWrapClass:
          'bg-[var(--color-primary)]/10 border border-[var(--color-primary)]/25 text-[var(--color-primary)]',
        hint: '沙箱充值入账',
      }
    default:
      return {
        typeLabel: type || '变动',
        amountPrefix: '',
        amountClass: 'text-[var(--color-text)]',
        iconWrapClass:
          'bg-[var(--color-text-muted)]/15 border border-[var(--color-text-muted)]/25 text-[var(--color-text-muted)]',
      }
  }
}

export function formatPointLogAmount(type: PointLogType, amount: number): string {
  const v = pointLogVisual(type)
  const absAmount = Math.abs(amount)
  const formatted = absAmount.toLocaleString('en-US')
  if (type === 'hold') return `冻 ${formatted}`
  if (type === 'out') return `−${formatted}`
  if (type === 'in' || type === 'release' || type === 'refund' || type === 'sandbox_in') return `+${formatted}`
  return `${v.amountPrefix}${formatted}`
}
