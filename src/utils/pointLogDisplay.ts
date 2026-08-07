/**
 * PointLog 买家展示：类型语义 + 配色。
 * hold（冻结）≠ out（实扣）—— 流水里必须一眼区分，避免「扣了两次」误会。
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
        typeLabel: '收入',
        amountPrefix: '+',
        amountClass: 'text-[var(--color-cta)]',
        iconWrapClass:
          'bg-[var(--color-cta)]/10 border border-[var(--color-cta)]/25 text-[var(--color-cta)]',
      }
    case 'out':
      return {
        typeLabel: '扣除',
        amountPrefix: '−',
        amountClass: 'text-[var(--color-danger)]',
        iconWrapClass:
          'bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/25 text-[var(--color-danger)]',
        hint: '已从可用积分中实扣',
      }
    case 'hold':
      return {
        typeLabel: '冻结',
        amountPrefix: '冻',
        amountClass: 'text-[var(--color-warning)]',
        iconWrapClass:
          'bg-[var(--color-warning)]/12 border border-[var(--color-warning)]/30 text-[var(--color-warning)]',
        hint: '暂扣在订单中，完成履约后才转为扣除；拒单/退款会解冻退回',
      }
    case 'release':
      return {
        typeLabel: '解冻',
        amountPrefix: '+',
        amountClass: 'text-[var(--color-primary)]',
        iconWrapClass:
          'bg-[var(--color-primary)]/10 border border-[var(--color-primary)]/25 text-[var(--color-primary)]',
        hint: '冻结积分已退回可用余额',
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
  if (type === 'hold') return `冻 ${amount}`
  if (type === 'out') return `−${amount}`
  if (type === 'in' || type === 'release' || type === 'refund') return `+${amount}`
  return `${v.amountPrefix}${amount}`
}
