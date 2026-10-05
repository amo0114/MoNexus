import { useLayoutEffect, useState, type CSSProperties } from 'react'
import { Heart } from 'lucide-react'
import { type IslandNotice, useAppStore } from '../stores/appStore'
import { useMediaQuery } from '../hooks/useMediaQuery'
import HeartBurst from './ui/HeartBurst'
import './FavoriteIsland.css'

const EXIT_MS = 120

interface Props {
  notice: IslandNotice | null
  onOpenChange: (open: boolean) => void
  suppressed?: boolean
}

export default function FavoriteIsland({ notice, onOpenChange, suppressed = false }: Props) {
  const clearNotice = useAppStore((state) => state.clearIslandNotice)
  const [content, setContent] = useState<IslandNotice | null>(null)
  const [open, setOpen] = useState(false)
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

  useLayoutEffect(() => {
    if (suppressed) {
      setContent(null)
      setOpen(false)
      onOpenChange(false)
      return
    }
    if (!notice) {
      setOpen(false)
      const finishExit = () => {
        setContent(null)
        onOpenChange(false)
      }
      if (reducedMotion) {
        finishExit()
        return
      }
      // Keep navigation hidden until the outgoing heart is fully transparent.
      const timer = window.setTimeout(finishExit, EXIT_MS)
      return () => window.clearTimeout(timer)
    }
    setContent(notice)
    let nextFrame = 0
    const frame = requestAnimationFrame(() => {
      nextFrame = requestAnimationFrame(() => {
        setOpen(true)
        onOpenChange(true)
      })
    })
    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(nextFrame)
    }
  }, [notice, suppressed, reducedMotion, onOpenChange])

  const liked = content?.payload?.favorite === true

  return (
    <div className="favorite-island-layer" data-open={open} aria-hidden={!open} style={{ '--favorite-island-close': `${EXIT_MS}ms` } as CSSProperties}>
      <span role="status" aria-atomic="true" className="sr-only">{open ? content?.title : ''}</span>
      {content && (
        <button
          type="button"
          data-testid="favorite-island"
          data-liked={liked}
          className="favorite-island-feedback"
          tabIndex={open ? 0 : -1}
          disabled={!open}
          aria-label={`${content.title}，关闭提示`}
          onClick={clearNotice}
          onKeyDown={(event) => { if (event.key === 'Escape') clearNotice() }}
        >
          <span className="favorite-island-symbol" key={content.id} aria-hidden="true">
            <span className="favorite-island-glow" />
            <span className="favorite-island-heart-motion">
              <Heart className="favorite-island-heart" size={42} strokeWidth={1.7} />
            </span>
            {liked && <HeartBurst distance={36} delay={200} />}
          </span>
        </button>
      )}
    </div>
  )
}
