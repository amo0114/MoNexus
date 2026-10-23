import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { useMediaQuery } from '../hooks/useMediaQuery'
import './ScratchReveal.css'

const BRUSH_RADIUS = 18
const REVEAL_RATIO = 0.5
const SAMPLE_STRIDE = 8
// Flake layer overhangs the card so debris can fall past its edges.
const FLAKE_MARGIN = 24
const FLAKE_FALL = 72
const MAX_FLAKES = 160

interface Flake {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  rot: number
  vr: number
  age: number
  ttl: number
  color: string
}

interface ScratchRevealProps {
  children: ReactNode
  revealed: boolean
  onReveal: () => void
  hint?: string
}

/**
 * Scratch-off coating for the one-time purchase success dialog only. The
 * secret is already in the DOM (it is the buyer's own); the coating is a
 * ceremony, so the button and every copy action reveal without scratching.
 * Order detail and other surfaces keep showing delivery content directly.
 */
export default function ScratchReveal({ children, revealed, onReveal, hint = '刮开查看卡密' }: ScratchRevealProps) {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const finePointer = useMediaQuery('(pointer: fine)')
  const rootRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const coatRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const flakeCanvasRef = useRef<HTMLCanvasElement>(null)
  const flakes = useRef<Flake[]>([])
  const flakeColors = useRef<string[]>([])
  const flakeFrame = useRef(0)
  const lastPoint = useRef<{ x: number; y: number } | null>(null)
  const vibrated = useRef(false)
  const [canvasReady, setCanvasReady] = useState(false)
  const [coatGone, setCoatGone] = useState(revealed)

  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    if (revealed) el.removeAttribute('inert')
    else el.setAttribute('inert', '')
  }, [revealed])

  useEffect(() => {
    if (revealed && reducedMotion) setCoatGone(true)
  }, [revealed, reducedMotion])

  // Debris stops with the reveal and never outlives the component.
  useEffect(() => {
    if (!revealed) return
    stopFlakes()
  }, [revealed])
  useEffect(() => stopFlakes, [])

  useEffect(() => {
    if (revealed) return
    const root = rootRef.current
    const canvas = canvasRef.current
    const coat = coatRef.current
    if (!root || !canvas || !coat) return
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    // No 2D context (jsdom, locked-down browsers): the CSS coating stays and
    // the button is the only way in.
    if (!ctx) return

    const paint = () => {
      // Layout size, not getBoundingClientRect: the entrance flip and tilt
      // transform the box, and a transformed measurement leaves an edge of the
      // secret uncovered.
      const width = root.clientWidth
      const height = root.clientHeight
      if (width === 0 || height === 0) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalCompositeOperation = 'source-over'

      // Resolve theme colours through the CSS coating so the canvas follows
      // every theme without duplicating tokens here.
      const style = getComputedStyle(coat)
      const gradient = ctx.createLinearGradient(0, 0, width, height)
      gradient.addColorStop(0, style.backgroundColor)
      gradient.addColorStop(0.5, style.borderTopColor)
      gradient.addColorStop(1, style.backgroundColor)
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, width, height)

      ctx.fillStyle = style.outlineColor
      for (let i = 0; i < (width * height) / 90; i++) {
        ctx.fillRect(Math.random() * width, Math.random() * height, 1, 1)
      }

      ctx.fillStyle = style.color
      ctx.font = `600 13px ${style.fontFamily}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(hint, width / 2, height / 2 - 6)

      flakeColors.current = [style.backgroundColor, style.textDecorationColor, style.textDecorationColor]
      const flakeCanvas = flakeCanvasRef.current
      if (flakeCanvas) {
        flakeCanvas.width = Math.round(flakeCanvas.clientWidth * dpr)
        flakeCanvas.height = Math.round(flakeCanvas.clientHeight * dpr)
        flakeCanvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
      setCanvasReady(true)
    }

    paint()
    const observer = new ResizeObserver(paint)
    observer.observe(root)
    return () => observer.disconnect()
  }, [revealed, hint])

  function pointFor(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget
    const rect = canvas.getBoundingClientRect()
    // Map screen coordinates back to layout pixels in case a transform is
    // still settling.
    const scaleX = rect.width ? canvas.clientWidth / rect.width : 1
    const scaleY = rect.height ? canvas.clientHeight / rect.height : 1
    return { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY }
  }

  function scratchTo(point: { x: number; y: number }) {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    ctx.globalCompositeOperation = 'destination-out'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = BRUSH_RADIUS * 2
    const from = lastPoint.current ?? point
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(point.x + 0.01, point.y)
    ctx.stroke()
    lastPoint.current = point
    if (!reducedMotion) spawnFlakes(point, point.x - from.x)
  }

  function spawnFlakes(point: { x: number; y: number }, dx: number) {
    const colors = flakeColors.current
    if (colors.length === 0) return
    const list = flakes.current
    const count = 2 + Math.floor(Math.random() * 3)
    for (let i = 0; i < count; i++) {
      list.push({
        x: point.x + FLAKE_MARGIN,
        y: point.y + FLAKE_MARGIN,
        vx: (Math.random() - 0.5) * 2.4 + dx * 0.04,
        vy: -Math.random() * 1.8 - 0.4,
        size: 2 + Math.random() * 3.5,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.4,
        age: 0,
        ttl: 500 + Math.random() * 400,
        color: colors[Math.floor(Math.random() * colors.length)],
      })
    }
    if (list.length > MAX_FLAKES) list.splice(0, list.length - MAX_FLAKES)
    if (!flakeFrame.current) {
      let last = performance.now()
      const step = (now: number) => {
        const dt = Math.min(32, now - last)
        last = now
        const alive = drawFlakes(dt)
        flakeFrame.current = alive ? requestAnimationFrame(step) : 0
      }
      flakeFrame.current = requestAnimationFrame(step)
    }
  }

  function drawFlakes(dt: number) {
    const canvas = flakeCanvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return false
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
    flakes.current = flakes.current.filter((f) => (f.age += dt) < f.ttl)
    for (const f of flakes.current) {
      f.vy += 0.012 * dt
      f.x += (f.vx * dt) / 16
      f.y += (f.vy * dt) / 16
      f.rot += f.vr
      ctx.save()
      ctx.globalAlpha = 1 - f.age / f.ttl
      ctx.translate(f.x, f.y)
      ctx.rotate(f.rot)
      ctx.fillStyle = f.color
      ctx.fillRect(-f.size / 2, -f.size / 3, f.size, f.size * 0.66)
      ctx.restore()
    }
    return flakes.current.length > 0
  }

  function stopFlakes() {
    if (flakeFrame.current) cancelAnimationFrame(flakeFrame.current)
    flakeFrame.current = 0
    flakes.current = []
    const canvas = flakeCanvasRef.current
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
  }

  function clearedRatio() {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || canvas.width === 0 || canvas.height === 0) return 0
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let cleared = 0
    let total = 0
    for (let i = 3; i < data.length; i += 4 * SAMPLE_STRIDE) {
      total++
      if (data[i] === 0) cleared++
    }
    return total === 0 ? 0 : cleared / total
  }

  function handlePointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (revealed) return
    event.currentTarget.setPointerCapture(event.pointerId)
    rootRef.current?.setAttribute('data-scratching', 'true')
    resetTilt()
    if (event.pointerType === 'touch' && !vibrated.current) {
      vibrated.current = true
      navigator.vibrate?.(10)
    }
    lastPoint.current = null
    scratchTo(pointFor(event))
  }

  function handlePointerMove(event: PointerEvent<HTMLCanvasElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    scratchTo(pointFor(event))
  }

  function handlePointerUp(event: PointerEvent<HTMLCanvasElement>) {
    rootRef.current?.removeAttribute('data-scratching')
    lastPoint.current = null
    if (!revealed && clearedRatio() >= REVEAL_RATIO) {
      if (event.pointerType === 'touch') navigator.vibrate?.(15)
      onReveal()
    }
  }

  function handleTilt(event: PointerEvent<HTMLDivElement>) {
    const root = rootRef.current
    if (!root || !finePointer || reducedMotion || root.hasAttribute('data-scratching')) return
    const rect = root.getBoundingClientRect()
    const px = (event.clientX - rect.left) / rect.width - 0.5
    const py = (event.clientY - rect.top) / rect.height - 0.5
    root.style.setProperty('--scratch-tilt-x', `${(-py * 6).toFixed(2)}deg`)
    root.style.setProperty('--scratch-tilt-y', `${(px * 6).toFixed(2)}deg`)
    root.style.setProperty('--scratch-glare-x', `${Math.round((px + 0.5) * 100)}%`)
    root.setAttribute('data-tilting', 'true')
  }

  function resetTilt() {
    const root = rootRef.current
    if (!root) return
    root.style.removeProperty('--scratch-tilt-x')
    root.style.removeProperty('--scratch-tilt-y')
    root.removeAttribute('data-tilting')
  }

  return (
    <div
      ref={rootRef}
      className="scratch-reveal"
      data-revealed={revealed}
      data-testid="scratch-reveal"
      onPointerMove={handleTilt}
      onPointerLeave={resetTilt}
    >
      <div ref={contentRef} aria-hidden={!revealed}>
        {children}
      </div>
      {!coatGone && (
        <div
          className="scratch-reveal-layer"
          onTransitionEnd={(event) => {
            if (revealed && event.target === event.currentTarget) setCoatGone(true)
          }}
        >
          <div
            ref={coatRef}
            className="scratch-reveal-coat"
            data-canvas={canvasReady}
            aria-hidden="true"
          >
            <span>{hint}</span>
          </div>
          {/* Stays mounted after reveal so the scratched coat fades out as drawn. */}
          <canvas
            ref={canvasRef}
            className="scratch-reveal-canvas"
            aria-hidden="true"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          />
          {!revealed && (
            <button
              type="button"
              className="scratch-reveal-button"
              onClick={onReveal}
              data-testid="scratch-reveal-button"
            >
              直接揭示
            </button>
          )}
        </div>
      )}
      {!coatGone && (
        <canvas
          ref={flakeCanvasRef}
          className="scratch-reveal-flakes"
          style={{
            left: -FLAKE_MARGIN,
            top: -FLAKE_MARGIN,
            width: `calc(100% + ${FLAKE_MARGIN * 2}px)`,
            height: `calc(100% + ${FLAKE_MARGIN + FLAKE_FALL}px)`,
          }}
          aria-hidden="true"
        />
      )}
    </div>
  )
}
