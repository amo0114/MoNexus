import { formatBadgeCount } from '../../utils/orderAttention'

/** 消息类红点数字角标（1–99 / 99+） */
export default function CountBadge({
  count,
  className = '',
  testId,
}: {
  count: number
  className?: string
  testId?: string
}) {
  const label = formatBadgeCount(count)
  if (!label) return null
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      className={`min-w-4 h-4 px-1 rounded-full bg-[var(--color-danger)] text-[10px] leading-4 font-bold text-white text-center ring-2 ring-[var(--color-surface)] ${className}`}
    >
      {label}
    </span>
  )
}
