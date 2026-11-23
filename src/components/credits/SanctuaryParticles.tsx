import { useEffect, useRef } from 'react'

export interface IgnitionBurst {
  id: number
  /** Target convergence point in viewport coordinates (0..window.innerWidth / innerHeight) */
  x: number
  y: number
}

interface SanctuaryParticlesProps {
  burst: IgnitionBurst | null
  accentHex: string
}

interface DustMote {
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  alpha: number
  phase: number
  speed: number
  twinkle: number
}

interface SparkStream {
  x: number
  y: number
  startX: number
  startY: number
  ctrlX: number
  ctrlY: number
  targetX: number
  targetY: number
  progress: number
  speed: number
  color: string
  radius: number
  trail: Array<{ x: number; y: number }>
  arrived: boolean
}

interface BloomMote {
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  life: number
  maxLife: number
  color: string
}

const COMPANION_COLORS = ['#D97757', '#7C6CF6', '#10A37F', '#4D6BFE']

function readGoldRgb(): string {
  if (typeof window === 'undefined') return '214, 177, 104'
  const root = document.documentElement
  const theme = root.getAttribute('data-theme')
  const isDark = root.classList.contains('dark') || theme === 'dark'
  if (isDark) return '236, 204, 134'
  if (theme === 'ink') return '80, 101, 125'
  if (theme === 'soft') return '196, 122, 46'
  return '176, 134, 58'
}

function hexToRgbTuple(hex: string): [number, number, number] {
  const clean = hex.replace('#', '')
  if (clean.length !== 6) return [214, 177, 104]
  return [
    parseInt(clean.slice(0, 2), 16) || 214,
    parseInt(clean.slice(2, 4), 16) || 177,
    parseInt(clean.slice(4, 6), 16) || 104,
  ]
}

export default function SanctuaryParticles({ burst, accentHex }: SanctuaryParticlesProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamsRef = useRef<SparkStream[]>([])
  const bloomsRef = useRef<BloomMote[]>([])
  const targetAccentRef = useRef<[number, number, number]>(hexToRgbTuple(accentHex))
  const currentAccentRef = useRef<[number, number, number]>(hexToRgbTuple(accentHex))
  const pointerRef = useRef<{ x: number; y: number; active: boolean }>({
    x: -9999,
    y: -9999,
    active: false,
  })

  useEffect(() => {
    targetAccentRef.current = hexToRgbTuple(accentHex)
  }, [accentHex])

  // Spawn converging four-companion starfire streams whenever the monolith is ignited
  useEffect(() => {
    if (!burst || typeof window === 'undefined') return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

    const w = window.innerWidth
    const h = window.innerHeight
    const origins = [
      { x: w * 0.08, y: Math.max(80, burst.y - 260), color: COMPANION_COLORS[0] },
      { x: w * 0.92, y: Math.max(80, burst.y - 260), color: COMPANION_COLORS[1] },
      { x: w * 0.1, y: Math.min(h - 60, burst.y + 220), color: COMPANION_COLORS[2] },
      { x: w * 0.9, y: Math.min(h - 60, burst.y + 220), color: COMPANION_COLORS[3] },
    ]

    const nextStreams: SparkStream[] = []
    origins.forEach((origin, idx) => {
      for (let i = 0; i < 7; i += 1) {
        const spreadX = (Math.random() - 0.5) * 140
        const spreadY = (Math.random() - 0.5) * 110
        const sx = origin.x + spreadX
        const sy = origin.y + spreadY
        const midX = (sx + burst.x) * 0.5 + (idx % 2 === 0 ? -90 : 90) * (0.4 + Math.random() * 0.7)
        const midY = (sy + burst.y) * 0.5 + (idx < 2 ? -75 : 75) * (0.3 + Math.random() * 0.8)

        nextStreams.push({
          x: sx,
          y: sy,
          startX: sx,
          startY: sy,
          ctrlX: midX,
          ctrlY: midY,
          targetX: burst.x + (Math.random() - 0.5) * 32,
          targetY: burst.y + (Math.random() - 0.5) * 18,
          progress: -i * 0.045,
          speed: 0.0135 + Math.random() * 0.006,
          color: origin.color,
          radius: 1.8 + Math.random() * 1.4,
          trail: [],
          arrived: false,
        })
      }
    })

    streamsRef.current = [...streamsRef.current, ...nextStreams]
  }, [burst])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof window === 'undefined') return
    if (/jsdom/i.test(window.navigator?.userAgent || '')) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

    let ctx: CanvasRenderingContext2D | null = null
    try {
      ctx = canvas.getContext('2d')
    } catch {
      return
    }
    if (!ctx) return

    let width = window.innerWidth
    let height = window.innerHeight
    let dpr = Math.min(window.devicePixelRatio || 1, 2)
    let rafId = 0

    const resize = () => {
      width = window.innerWidth
      height = window.innerHeight
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()

    // Calibrated ambient golden dust density (lightweight & calm)
    const moteCount = Math.max(28, Math.min(54, Math.floor((width * height) / 28000)))
    const motes: DustMote[] = Array.from({ length: moteCount }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.14,
      vy: -(0.14 + Math.random() * 0.34),
      radius: 0.9 + Math.random() * 1.9,
      alpha: 0.16 + Math.random() * 0.42,
      phase: Math.random() * Math.PI * 2,
      speed: 0.008 + Math.random() * 0.014,
      twinkle: Math.random() > 0.72 ? 1 : 0,
    }))

    const onPointerMove = (e: PointerEvent) => {
      pointerRef.current.x = e.clientX
      pointerRef.current.y = e.clientY
      pointerRef.current.active = true
    }
    const onPointerLeave = () => {
      pointerRef.current.active = false
    }

    window.addEventListener('resize', resize, { passive: true })
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerleave', onPointerLeave, { passive: true })

    let tick = 0
    let goldRgb = readGoldRgb()

    const render = () => {
      tick += 1
      if (tick % 45 === 0) {
        goldRgb = readGoldRgb()
      }

      ctx.clearRect(0, 0, width, height)

      // Smoothly interpolate companion accent RGB for living atmosphere tint
      const cur = currentAccentRef.current
      const tgt = targetAccentRef.current
      cur[0] += (tgt[0] - cur[0]) * 0.045
      cur[1] += (tgt[1] - cur[1]) * 0.045
      cur[2] += (tgt[2] - cur[2]) * 0.045
      const accentRgb = `${Math.round(cur[0])}, ${Math.round(cur[1])}, ${Math.round(cur[2])}`

      // 1. Ambient floating golden + companion-tinted sanctuary dust
      const ptr = pointerRef.current
      for (let i = 0; i < motes.length; i += 1) {
        const m = motes[i]
        m.phase += m.speed
        m.x += m.vx + Math.sin(m.phase) * 0.16
        m.y += m.vy

        // Subtle air-current drift away from cursor
        if (ptr.active) {
          const dx = m.x - ptr.x
          const dy = m.y - ptr.y
          const distSq = dx * dx + dy * dy
          if (distSq < 18000 && distSq > 1) {
            const dist = Math.sqrt(distSq)
            const push = (1 - dist / 134) * 0.42
            m.x += (dx / dist) * push
            m.y += (dy / dist) * push
          }
        }

        if (m.y < -12) {
          m.y = height + 12
          m.x = Math.random() * width
        }
        if (m.x < -12) m.x = width + 12
        if (m.x > width + 12) m.x = -12

        const pulse = 0.55 + 0.45 * Math.sin(m.phase * 1.8)
        const a = m.alpha * pulse
        const moteRgb = i % 2 === 0 ? accentRgb : goldRgb

        ctx.beginPath()
        ctx.arc(m.x, m.y, m.radius, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${moteRgb}, ${a.toFixed(3)})`
        ctx.fill()

        // Occasional subtle 4-point star glint
        if (m.twinkle && pulse > 0.82) {
          const arm = m.radius * 3.1
          ctx.strokeStyle = `rgba(${moteRgb}, ${(a * 0.78).toFixed(3)})`
          ctx.lineWidth = 0.7
          ctx.beginPath()
          ctx.moveTo(m.x - arm, m.y)
          ctx.lineTo(m.x + arm, m.y)
          ctx.moveTo(m.x, m.y - arm)
          ctx.lineTo(m.x, m.y + arm)
          ctx.stroke()
        }
      }

      // 2. Converging four-companion starfire streams (triggered on monolith ignition)
      const streams = streamsRef.current
      if (streams.length > 0) {
        for (let i = streams.length - 1; i >= 0; i -= 1) {
          const s = streams[i]
          s.progress += s.speed
          if (s.progress < 0) continue

          const t = Math.min(1, s.progress)
          // Smooth ease-in-out cubic along quadratic Bezier curve
          const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
          const inv = 1 - e
          s.x = inv * inv * s.startX + 2 * inv * e * s.ctrlX + e * e * s.targetX
          s.y = inv * inv * s.startY + 2 * inv * e * s.ctrlY + e * e * s.targetY

          s.trail.push({ x: s.x, y: s.y })
          if (s.trail.length > 14) s.trail.shift()

          // Draw luminous silk comet trail
          for (let j = 1; j < s.trail.length; j += 1) {
            const p0 = s.trail[j - 1]
            const p1 = s.trail[j]
            const ratio = j / s.trail.length
            ctx.beginPath()
            ctx.moveTo(p0.x, p0.y)
            ctx.lineTo(p1.x, p1.y)
            ctx.strokeStyle = s.color
            ctx.globalAlpha = ratio * 0.65 * (1 - t * 0.25)
            ctx.lineWidth = s.radius * ratio * 1.45
            ctx.lineCap = 'round'
            ctx.stroke()
          }

          // Bright starfire head
          ctx.globalAlpha = 0.92
          ctx.beginPath()
          ctx.arc(s.x, s.y, s.radius * 1.25, 0, Math.PI * 2)
          ctx.fillStyle = s.color
          ctx.fill()
          ctx.globalAlpha = 1

          if (t >= 1 && !s.arrived) {
            s.arrived = true
            // Spawn gentle golden + companion-color bloom motes upon arrival
            for (let b = 0; b < 3; b += 1) {
              const ang = Math.random() * Math.PI * 2
              const spd = 0.55 + Math.random() * 1.9
              bloomsRef.current.push({
                x: s.targetX,
                y: s.targetY,
                vx: Math.cos(ang) * spd,
                vy: Math.sin(ang) * spd - 0.35,
                radius: 1.1 + Math.random() * 1.7,
                life: 0,
                maxLife: 46 + Math.random() * 34,
                color: b === 0 ? `rgb(${goldRgb})` : s.color,
              })
            }
            streams.splice(i, 1)
          }
        }
      }

      // 3. Post-convergence golden starlight blooms
      const blooms = bloomsRef.current
      if (blooms.length > 0) {
        for (let i = blooms.length - 1; i >= 0; i -= 1) {
          const b = blooms[i]
          b.life += 1
          b.x += b.vx
          b.y += b.vy
          b.vx *= 0.975
          b.vy *= 0.975
          const progress = b.life / b.maxLife
          const alpha = Math.max(0, (1 - progress) * 0.85)

          ctx.globalAlpha = alpha
          ctx.beginPath()
          ctx.arc(b.x, b.y, b.radius * (1 - progress * 0.35), 0, Math.PI * 2)
          ctx.fillStyle = b.color
          ctx.fill()
          ctx.globalAlpha = 1

          if (b.life >= b.maxLife) {
            blooms.splice(i, 1)
          }
        }
      }

      rafId = window.requestAnimationFrame(render)
    }

    rafId = window.requestAnimationFrame(render)

    return () => {
      window.cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerleave', onPointerLeave)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0"
    />
  )
}
