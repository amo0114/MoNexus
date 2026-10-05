import { useLayoutEffect, useState, type CSSProperties } from 'react'
import { Check } from 'lucide-react'
import { useMediaQuery } from '../hooks/useMediaQuery'
import type { IslandNotice } from '../stores/appStore'
import FeedbackIcon from './ui/FeedbackIcon'
import './QuietIslandNotice.css'

const EXIT_MS = 250

interface Props {
  notice: IslandNotice | null
  suppressed: boolean
  onDismiss: () => void
  onVisibleChange: (visible: boolean) => void
}

/** Retain only presentation during exit; ownership and expiry stay in Layout. */
export default function QuietIslandNotice({ notice, suppressed, onDismiss, onVisibleChange }: Props) {
  const [content, setContent] = useState<IslandNotice | null>(null)
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

  useLayoutEffect(() => {
    if (suppressed) {
      setContent(null)
      onVisibleChange(false)
      return
    }
    if (notice) {
      setContent(notice)
      onVisibleChange(true)
      return
    }
    const timer = window.setTimeout(() => {
      setContent(null)
      onVisibleChange(false)
    }, reducedMotion ? 0 : EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [notice, suppressed, reducedMotion, onVisibleChange])

  if (!content || suppressed) return null
  const open = Boolean(notice)
  const copy = content.kind === 'copy'
  const message = copy ? content.title || '已复制到剪贴板' : content.message

  return (
    <div
      className="quiet-island-layer absolute inset-0 flex items-center justify-center"
      data-open={open}
      aria-hidden={!open}
      style={{ '--quiet-island-close': `${EXIT_MS}ms` } as CSSProperties}
    >
      <span role="status" aria-atomic="true" className="sr-only">{open ? message : ''}</span>
      <button
        type="button"
        data-testid="quiet-island-notice"
        disabled={!open}
        tabIndex={open ? 0 : -1}
        aria-label={`${message}，关闭提示`}
        onClick={onDismiss}
        onKeyDown={(event) => { if (event.key === 'Escape') onDismiss() }}
        className={`apple-island-stadium quiet-island-surface ${copy
          ? 'w-[min(calc(100vw-2.5rem),19rem)] min-h-[46px]'
          : 'w-[min(calc(100vw-2rem),20rem)] min-h-[44px]'} rounded-full
          bg-[var(--color-surface)]/95 backdrop-blur-2xl border border-black/[0.08] dark:border-white/[0.12]
          shadow-lg flex items-center justify-center px-3.5 py-1 cursor-pointer select-none
          focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]`}
      >
        <span key={content.id} className="quiet-island-copy flex min-w-0 items-center justify-center gap-2" aria-hidden="true">
          {copy ? (
            <span className="flex items-center justify-center shrink-0 w-7 h-7 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25">
              <Check className="w-3.5 h-3.5 stroke-[2.5]" />
            </span>
          ) : <FeedbackIcon tone={content.type} />}
          <span className={`min-w-0 truncate text-[var(--color-text)] ${copy ? 'text-xs font-semibold' : 'text-xs sm:text-sm font-medium'}`}>
            {message}
          </span>
        </span>
      </button>
    </div>
  )
}
