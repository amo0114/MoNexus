import { useEffect, useId, useRef, useState } from 'react'
import { Brush, Moon, Sparkles, Sun } from 'lucide-react'
import { useTheme, type Theme } from '../lib/ThemeProvider'

const OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: '浅色主题', icon: Sun },
  { value: 'dark', label: '深色主题', icon: Moon },
  { value: 'soft', label: '软萌主题', icon: Sparkles },
  { value: 'ink', label: '墨韵主题', icon: Brush },
]

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const groupRef = useRef<HTMLDivElement>(null)

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const idx = OPTIONS.findIndex((o) => o.value === theme)
    const next =
      e.key === 'ArrowRight'
        ? (idx + 1) % OPTIONS.length
        : (idx - 1 + OPTIONS.length) % OPTIONS.length
    setTheme(OPTIONS[next].value)
    groupRef.current
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
      [next]?.focus()
  }

  const activeIndex = Math.max(0, OPTIONS.findIndex((o) => o.value === theme))

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label="主题切换"
      onKeyDown={onKeyDown}
      className="relative inline-flex items-center p-1 rounded-full border border-[var(--color-border)] bg-[var(--color-background)] shadow-2xs select-none"
    >
      {/* Sliding pill indicator */}
      <span
        aria-hidden="true"
        className="absolute top-1 left-1 w-10 h-10 rounded-full bg-[var(--color-surface)] shadow-xs border border-[color-mix(in_srgb,var(--color-border)_50%,transparent)] pointer-events-none transition-transform duration-250 ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{
          transform: `translateX(${activeIndex * 44}px)`,
        }}
      />
      <div className="flex items-center gap-1 relative z-10">
        {OPTIONS.map(({ value, label, icon: Icon }) => {
          const active = theme === value
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              title={label}
              aria-label={label}
              onClick={() => setTheme(value)}
              className={`inline-flex items-center justify-center w-10 h-10 rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] cursor-pointer ${
                active
                  ? 'text-[var(--color-primary)] font-medium'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-primary)]'
              }`}
            >
              <Icon size={16} />
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Header variant: one icon button that opens the theme options, so the
 * desktop navbar keeps its space for navigation. The drawer keeps the full
 * segmented control above.
 */
export function ThemeMenu() {
  const { theme, setTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const current = OPTIONS.find((o) => o.value === theme) ?? OPTIONS[0]
  const CurrentIcon = current.icon

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
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`主题：${current.label}`}
        title="切换主题"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-primary-tint)] hover:text-[var(--color-primary)] focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] cursor-pointer"
      >
        <CurrentIcon size={18} />
      </button>
      {open && (
        <div
          id={menuId}
          role="radiogroup"
          aria-label="主题切换"
          className="menu-pop absolute right-0 top-full z-50 mt-2 w-40 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-lg"
        >
          {OPTIONS.map(({ value, label, icon: Icon }) => {
            const active = theme === value
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => { setTheme(value); setOpen(false) }}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors cursor-pointer focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] ${
                  active
                    ? 'bg-[var(--color-primary-tint)] font-semibold text-[var(--color-primary)]'
                    : 'text-[var(--color-text)] hover:bg-[var(--color-primary-tint)]'
                }`}
              >
                <Icon size={16} />
                {label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
