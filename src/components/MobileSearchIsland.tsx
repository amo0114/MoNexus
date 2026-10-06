import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useMediaQuery } from '../hooks/useMediaQuery'
import StoreSearchPanel from './StoreSearchPanel'
import { useAppStore } from '../stores/appStore'
import './MobileSearchIsland.css'

interface Props {
  open: boolean
  anchorRef: RefObject<HTMLDivElement>
  backdropRootRef: RefObject<HTMLElement>
  triggerRef: RefObject<HTMLButtonElement>
  onClose: () => void
  onPresenceChange: (present: boolean) => void
}

/** Morph only a decorative surface. Content keeps its final, unscaled layout. */
export default function MobileSearchIsland({ open, anchorRef, backdropRootRef, triggerRef, onClose, onPresenceChange }: Props) {
  const [present, setPresent] = useState(open)
  const [expanded, setExpanded] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const hasEntered = useRef(false)
  const focusFrame = useRef(0)
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

  useLayoutEffect(() => () => cancelAnimationFrame(focusFrame.current), [])

  useLayoutEffect(() => {
    if (open) setPresent(true)
  }, [open])

  useLayoutEffect(() => {
    onPresenceChange(present)
    return () => onPresenceChange(false)
  }, [present, onPresenceChange])

  useLayoutEffect(() => {
    const panel = panelRef.current
    const anchor = anchorRef.current
    if (!present || !panel || !anchor) return
    const measure = () => {
      const width = panel.offsetWidth
      const height = panel.offsetHeight
      if (!width || !height) return
      const sx = anchor.offsetWidth / width
      const sy = anchor.offsetHeight / height
      const radius = parseFloat(getComputedStyle(anchor).borderTopLeftRadius) || 0
      panel.style.setProperty('--search-scale-x', String(sx))
      panel.style.setProperty('--search-scale-y', String(sy))
      // Compensate the corner radius so the compressed surface matches the pill.
      panel.style.setProperty('--search-rest-radius', `${radius / sx}px / ${radius / sy}px`)
      const bottom = `calc(var(--safe-top) + ${12 + height}px)`
      const style = document.documentElement.style
      if (style.getPropertyValue('--search-island-bottom') !== bottom) style.setProperty('--search-island-bottom', bottom)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(panel)
    observer.observe(anchor)
    return () => {
      observer.disconnect()
      document.documentElement.style.removeProperty('--search-island-bottom')
    }
  }, [present, anchorRef])

  useLayoutEffect(() => {
    if (!present) return
    if (open) {
      cancelAnimationFrame(focusFrame.current)
      if (reducedMotion || hasEntered.current) {
        setExpanded(true)
        return
      }
      // Give the resting surface one paint. Later reversals use the in-flight
      // CSS transform directly, without snapping back to either endpoint.
      let secondFrame = 0
      const frame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => {
          hasEntered.current = true
          setExpanded(true)
        })
      })
      return () => { cancelAnimationFrame(frame); cancelAnimationFrame(secondFrame) }
    }
    setExpanded(false)
    const finish = () => {
      setPresent(false)
      hasEntered.current = false
      // Wait for the parent to remove inert from the returning navbar first.
      focusFrame.current = requestAnimationFrame(() => {
        if (useAppStore.getState().modalDepth === 0) triggerRef.current?.focus({ preventScroll: true })
      })
    }
    if (reducedMotion) { finish(); return }
    const duration = parseFloat(getComputedStyle(panelRef.current!).getPropertyValue('--search-close-duration')) || 350
    const timer = window.setTimeout(finish, duration)
    return () => window.clearTimeout(timer)
  }, [open, present, reducedMotion, triggerRef])

  if (!present) return null
  return (
    <>
      {backdropRootRef.current && createPortal(
        <div className="mobile-search-backdrop" data-open={expanded} aria-hidden="true" onClick={onClose} />,
        backdropRootRef.current,
      )}
      <div ref={panelRef} className="mobile-search-island" data-open={expanded} data-closing={!open} data-testid="mobile-search-island">
        <div className="mobile-search-surface" aria-hidden="true" />
        <div className="mobile-search-content" aria-hidden={!open} ref={(element) => {
          if (!element) return
          if (open) element.removeAttribute('inert')
          else element.setAttribute('inert', '')
        }}>
          <StoreSearchPanel active={open} onClose={onClose} />
        </div>
      </div>
    </>
  )
}
