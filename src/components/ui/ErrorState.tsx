import type { LucideIcon } from 'lucide-react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

export interface ErrorStateProps {
  icon?: LucideIcon
  title?: string
  description?: string
  onRetry?: () => void
  retryText?: string
  compact?: boolean
  testId?: string
}

/**
 * Designed error state: icon + title + optional description / retry action.
 * Standard error boundary and fallback UI for admin tables and panels.
 */
export default function ErrorState({
  icon: Icon = AlertTriangle,
  title = '加载失败',
  description,
  onRetry,
  retryText = '重试',
  compact = false,
  testId = 'admin-error-state',
}: ErrorStateProps) {
  return (
    <div
      data-testid={testId}
      role="alert"
      className={`flex flex-col items-center justify-center text-center ${
        compact ? 'py-8 px-4' : 'py-12 px-6'
      }`}
    >
      <div
        className={`rounded-full bg-red-500/10 text-red-500 flex items-center justify-center ${
          compact ? 'w-10 h-10 mb-3' : 'w-14 h-14 mb-4'
        }`}
      >
        <Icon className={compact ? 'w-5 h-5' : 'w-7 h-7'} />
      </div>
      <div className="font-bold text-[var(--color-text)]">{title}</div>
      {description && (
        <div className="text-sm text-[var(--color-text-muted)] mt-1 max-w-sm">
          {description}
        </div>
      )}
      {onRetry && (
        <div className="mt-4">
          <button
            type="button"
            onClick={onRetry}
            data-testid="admin-error-retry"
            className="btn-secondary btn-sm text-xs px-3 py-1.5 inline-flex items-center gap-1.5 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>{retryText}</span>
          </button>
        </div>
      )}
    </div>
  )
}
