import React from 'react'
import { Range } from '../../../api/merchant/dashboard'
import { useDashboardStore } from '../../../stores/dashboard'

export default function RangeFilter() {
  const { range, setRange } = useDashboardStore()
  const options: { label: string; value: Range }[] = [
    { label: '近 7 天', value: '7d' },
    { label: '近 30 天', value: '30d' },
    { label: '近 90 天', value: '90d' },
  ]

  return (
    <div className="flex items-center gap-2 mb-4">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => setRange(opt.value)}
          className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
            range === opt.value
              ? 'bg-[var(--color-primary)] text-white'
              : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border border-[var(--color-border)] hover:text-[var(--color-text)]'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
