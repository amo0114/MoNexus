/**
 * PointLog 买家展示：类型语义 + 配色（SPEC-CMI-UX-001 §6.1，D-UX-18）。
 * 冻结词汇：入账 / 待支付 / 已支付 / 已返还。底层 in/out/hold/release 不变。
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
        typeLabel: '已支付',
        amountPrefix: '−',
        amountClass: 'text-[var(--color-danger)]',
        iconWrapClass:
          'bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/25 text-[var(--color-danger)]',
        hint: '已从可用积分中支付',
      }
    case 'hold':
      return {
        typeLabel: '待支付',
        amountPrefix: '待',
        amountClass: 'text-[var(--color-warning)]',
        iconWrapClass:
          'bg-[var(--color-warning)]/12 border border-[var(--color-warning)]/30 text-[var(--color-warning)]',
        hint: '人工服务下单后，积分会暂时锁定；订单完成后才正式支付，取消或退款后会自动返还',
      }
    case 'release':
      return {
        typeLabel: '已返还',
        amountPrefix: '+',
        amountClass: 'text-[var(--color-primary)]',
        iconWrapClass:
          'bg-[var(--color-primary)]/10 border border-[var(--color-primary)]/25 text-[var(--color-primary)]',
        hint: '待支付的积分已返还到可用余额',
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
  if (type === 'hold') return `待 ${amount}`
  if (type === 'out') return `−${amount}`
  if (type === 'in' || type === 'release' || type === 'refund') return `+${amount}`
  return `${v.amountPrefix}${amount}`
}
