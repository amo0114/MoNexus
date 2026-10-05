import { useRef } from 'react'
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
        className="absolute top-1 left-1 w-10 h-10 rounded-full bg-[var(--color-surface)] shadow-xs border border-[var(--color-border)]/50 pointer-events-none transition-transform duration-250 ease-[cubic-bezier(0.22,1,0.36,1)]"
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
