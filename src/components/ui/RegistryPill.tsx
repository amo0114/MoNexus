import React from 'react'
import { useAppStore } from '../../stores/appStore'

interface Props {
  value: string
  category: 'orderStatuses' | 'settlementStatuses' | 'deliveryModes' | 'productTypes'
}

export default function RegistryPill({ value, category }: Props) {
  const registry = useAppStore(s => s.registry)

  if (!registry) return <span className="inline-flex items-center justify-center leading-none px-2 py-1 rounded text-xs font-bold border bg-gray-100 text-gray-500 border-gray-200">...</span>

  const items = registry[category] || []
  const item = items.find(i => i.value === value)

  const label = item ? item.label : value
  const tone = item?.tone || 'neutral'

  let styles = ''
  switch (tone) {
    case 'success':
      styles = 'bg-[color-mix(in_srgb,var(--color-cta)_10%,transparent)] text-[var(--color-cta)] border-[color-mix(in_srgb,var(--color-cta)_25%,transparent)]'
      break
    case 'warning':
      styles = 'bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] text-[var(--color-warning)] border-[color-mix(in_srgb,var(--color-warning)_25%,transparent)]'
      break
    case 'danger':
      styles = 'bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] text-[var(--color-danger)] border-[color-mix(in_srgb,var(--color-danger)_25%,transparent)]'
      break
    case 'info':
      styles = 'bg-[color-mix(in_srgb,var(--color-info)_10%,transparent)] text-[var(--color-info)] border-[color-mix(in_srgb,var(--color-info)_25%,transparent)]'
      break
    case 'neutral':
    default:
      styles = 'bg-[color-mix(in_srgb,var(--color-text-muted)_10%,transparent)] text-[var(--color-text-muted)] border-[color-mix(in_srgb,var(--color-text-muted)_25%,transparent)]'
      break
  }

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border ${styles}`}>
      {label}
    </span>
  )
}
