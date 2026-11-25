import { useEffect, useId, useRef, useState } from 'react'
import { ArrowUpDown, Check, ChevronDown } from 'lucide-react'

export type StoreSortKey = 'default' | 'sales' | 'price_asc' | 'price_desc'

const SORT_OPTIONS: ReadonlyArray<{ value: StoreSortKey; label: string; shortLabel: string }> = [
  { value: 'default', label: '综合推荐', shortLabel: '综合推荐' },
  { value: 'sales', label: '销量优先', shortLabel: '销量优先' },
  { value: 'price_asc', label: '积分从低到高', shortLabel: '积分 ↑' },
  { value: 'price_desc', label: '积分从高到低', shortLabel: '积分 ↓' },
]

export interface StoreSortMenuProps {
  value: StoreSortKey
  onChange: (next: StoreSortKey) => void
}

/**
 * Custom rounded sort popover matching ThemeMenu's surface & motion language,
 * avoiding the OS-rendered square native <select> popup on Windows.
 */
export default function StoreSortMenu({ value, onChange }: StoreSortMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const current = SORT_OPTIONS.find((opt) => opt.value === value) ?? SORT_OPTIONS[0]

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`商品排序：${current.label}`}
        data-testid="store-sort-select"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 max-md:min-h-10 text-xs font-medium transition-colors cursor-pointer focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] ${
          value !== 'default' || open
            ? 'border-[var(--color-primary-border-subtle)] bg-[var(--color-primary-tint)] text-[var(--color-primary)] font-semibold'
            : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:border-[var(--color-primary-border-subtle)] hover:text-[var(--color-text)]'
        }`}
      >
        <ArrowUpDown className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span>{current.shortLabel}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          id={menuId}
          role="listbox"
          aria-label="商品排序"
          className="menu-pop absolute right-0 top-full z-30 mt-2 w-40 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-lg"
        >
          {SORT_OPTIONS.map((option) => {
            const active = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs transition-colors cursor-pointer focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] ${
                  active
                    ? 'bg-[var(--color-primary-tint)] font-semibold text-[var(--color-primary)]'
                    : 'text-[var(--color-text)] hover:bg-[var(--color-primary-tint)]'
                }`}
              >
                <span>{option.label}</span>
                {active && <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
