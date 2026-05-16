import React from 'react'
import { useAppStore } from '../../stores/appStore'

interface Props {
  value: string
  category: 'orderStatuses' | 'settlementStatuses' | 'deliveryModes' | 'productTypes'
}

export default function RegistryPill({ value, category }: Props) {
  const registry = useAppStore(s => s.registry)

  if (!registry) return <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border bg-gray-100 text-gray-500 border-gray-200">...</span>

  const items = registry[category] || []
  const item = items.find(i => i.value === value)

  const label = item ? item.label : value
  const tone = item?.tone || 'neutral'

  let styles = ''
  switch (tone) {
    case 'success':
      styles = 'bg-[var(--color-cta)]/10 text-[var(--color-cta)] border-[var(--color-cta)]/25'
      break
    case 'warning':
      styles = 'bg-[var(--color-warning)]/10 text-[var(--color-warning)] border-[var(--color-warning)]/25'
      break
    case 'danger':
      styles = 'bg-[var(--color-danger)]/10 text-[var(--color-danger)] border-[var(--color-danger)]/25'
      break
    case 'info':
      styles = 'bg-[var(--color-info)]/10 text-[var(--color-info)] border-[var(--color-info)]/25'
      break
    case 'neutral':
    default:
      styles = 'bg-[var(--color-text-muted)]/10 text-[var(--color-text-muted)] border-[var(--color-text-muted)]/25'
      break
  }

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold border ${styles}`}>
      {label}
    </span>
  )
}
