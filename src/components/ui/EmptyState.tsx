import type { LucideIcon } from 'lucide-react'

/**
 * Designed empty state: icon + title + optional description/action.
 * Replaces bare "暂无数据" texts and empty table bodies.
 */
export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
}: {
  icon?: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  /** Tighter padding for in-table / in-card slots. */
  compact?: boolean
}) {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${compact ? 'py-8 px-4' : 'py-12 px-6'}`}>
      {Icon && (
        <div className={`rounded-full bg-[var(--color-primary)]/10 text-[var(--color-primary)] flex items-center justify-center ${compact ? 'w-10 h-10 mb-3' : 'w-14 h-14 mb-4'}`}>
          <Icon className={compact ? 'w-5 h-5' : 'w-7 h-7'} />
        </div>
      )}
      <div className="font-bold text-[var(--color-text)]">{title}</div>
      {description && (
        <div className="text-sm text-[var(--color-text-muted)] mt-1 max-w-sm">{description}</div>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
