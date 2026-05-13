import { Sun, Sparkles } from 'lucide-react'
import { useTheme } from '../lib/ThemeProvider'

export default function ThemeToggle() {
  const { theme, toggle } = useTheme()
  const isSoft = theme === 'soft'

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isSoft ? '切换到经典主题' : '切换到软萌主题'}
      title={isSoft ? '经典主题' : '软萌主题'}
      className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-primary)]/10 hover:border-[var(--color-primary)] transition-all duration-200 focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
    >
      {isSoft
        ? <Sparkles size={18} className="text-[var(--color-primary)]" />
        : <Sun size={18} className="text-[var(--color-text-muted)]" />}
    </button>
  )
}
