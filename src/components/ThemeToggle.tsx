import { useRef } from 'react'
import { Moon, Sparkles, Sun } from 'lucide-react'
import { useTheme, type Theme } from '../lib/ThemeProvider'

const OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: '浅色主题', icon: Sun },
  { value: 'dark', label: '深色主题', icon: Moon },
  { value: 'soft', label: '软萌主题', icon: Sparkles },
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

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label="主题切换"
      onKeyDown={onKeyDown}
      className="inline-flex items-center gap-1 p-1 rounded-full border border-[var(--color-border)] bg-[var(--color-background)]"
    >
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
            className={`inline-flex items-center justify-center w-8 h-8 rounded-full transition-all duration-200 focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] ${
              active
                ? 'bg-[var(--color-surface)] text-[var(--color-primary)] shadow-sm'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-primary)]'
            }`}
          >
            <Icon size={16} />
          </button>
        )
      })}
    </div>
  )
}
