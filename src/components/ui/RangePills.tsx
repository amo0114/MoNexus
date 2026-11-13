export interface RangeOption<T extends string> {
  label: string
  value: T
}

export const DAY_RANGE_OPTIONS: RangeOption<'7d' | '30d' | '90d'>[] = [
  { label: '近 7 天', value: '7d' },
  { label: '近 30 天', value: '30d' },
  { label: '近 90 天', value: '90d' },
]

/** The one time-range control used by every dashboard section. */
export default function RangePills<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  testIdPrefix,
}: {
  value: T
  onChange: (value: T) => void
  options: RangeOption<T>[]
  ariaLabel: string
  testIdPrefix?: string
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap items-center gap-2">
      {options.map((opt) => {
        const active = value === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            data-testid={testIdPrefix ? `${testIdPrefix}-${opt.value}` : undefined}
            className={`shrink-0 whitespace-nowrap px-3 sm:px-4 py-1.5 btn-sm rounded-full text-sm font-medium transition-colors border cursor-pointer focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] ${
              active
                ? 'bg-[var(--color-primary)] text-[var(--color-on-primary)] border-transparent'
                : 'bg-[var(--color-surface)] text-[var(--color-text-muted)] border-[var(--color-border)] hover:text-[var(--color-text)]'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
