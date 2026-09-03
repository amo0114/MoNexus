import React from 'react'

export interface AdminPanelHeaderProps {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  testId?: string
  className?: string
}

export default function AdminPanelHeader({
  title,
  description,
  actions,
  testId,
  className = '',
}: AdminPanelHeaderProps) {
  return (
    <div
      data-testid={testId}
      className={`flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4 ${className}`}
    >
      <div>
        <h2 className="font-heading text-xl font-bold text-[var(--color-text)]">{title}</h2>
        {description && (
          <p className="text-xs sm:text-sm text-[var(--color-text-muted)] mt-1">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 shrink-0">
          {actions}
        </div>
      )}
    </div>
  )
}
