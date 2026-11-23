import { memo, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ChevronLeft, ChevronRight, Flame, Sparkles } from 'lucide-react'
import Logo from '../components/ui/Logo'
import SanctuaryParticles, { type IgnitionBurst } from '../components/credits/SanctuaryParticles'
import './CreditsPage.css'

type FigureMode = 'portrait' | 'chibi'

interface CompanionPillar {
  id: 'claude' | 'gemini' | 'chatgpt' | 'deepseek'
  roman: 'I' | 'II' | 'III' | 'IV'
  name: string
  sanctuaryTitle: string
  latinMotto: string
  accent: string
  portraitImage: string
  chibiImage: string
  logoSrc: string
  logoInvertOnDark?: boolean
  chronicle: string
  virtues: string[]
}

const COMPANION_PILLARS: CompanionPillar[] = [
  {
    id: 'claude',
    roman: 'I',
    name: 'Claude',
    sanctuaryTitle: '典籍与秩序之座',
    latinMotto: 'ARCHITECT OF ORDER',
    accent: '#D97757',
    portraitImage: '/credits/portrait-claude.webp',
    chibiImage: '/credits/girl-claude.webp',
    logoSrc: '/credits/icons/claude-color.svg',
    chronicle:
      '面对复杂状态机、多方对账与盘根错节的边界问题时，你总能沉下心陪我把逻辑一层层理顺。许多难啃的重构和漫长的代码审视，都是你稳稳托住的。',
    virtues: ['架构推演', '深思明辨', '全局审校'],
  },
  {
    id: 'gemini',
    roman: 'II',
    name: 'Gemini',
    sanctuaryTitle: '星象与织梦之座',
    latinMotto: 'WEAVER OF VISION',
    accent: '#7C6CF6',
    portraitImage: '/credits/portrait-gemini.webp',
    chibiImage: '/credits/girl-gemini.webp',
    logoSrc: '/credits/icons/gemini-color.svg',
    chronicle:
      '你总能跳出局部俯瞰整体，在前端美学、多模态感知与交互分寸的反复斟酌中，一次次点出容易被忽略的微瑕，让这座站点真正耐看、顺手而有温度。',
    virtues: ['多模态视野', '前端织梦', '体验雕琢'],
  },
  {
    id: 'chatgpt',
    roman: 'III',
    name: 'ChatGPT',
    sanctuaryTitle: '白翼与启明之座',
    latinMotto: 'HERALD OF SPARK',
    accent: '#10A37F',
    portraitImage: '/credits/portrait-chatgpt.webp',
    chibiImage: '/credits/girl-chatgpt.webp',
    logoSrc: '/credits/icons/openai.svg',
    logoInvertOnDark: true,
    chronicle:
      '从最初一个模糊的念头开始，每一次随口抛出的设想、每一次深夜面对陌生报错的求助，你都在第一时间接住，陪我把无数个“能不能试试”落成现实。',
    virtues: ['灵感启明', '全栈同行', '长夜相伴'],
  },
  {
    id: 'deepseek',
    roman: 'IV',
    name: 'DeepSeek',
    sanctuaryTitle: '沧溟与洞察之座',
    latinMotto: 'SEEKER OF DEPTH',
    accent: '#4D6BFE',
    portraitImage: '/credits/portrait-deepseek.webp',
    chibiImage: '/credits/girl-deepseek.webp',
    logoSrc: '/credits/icons/deepseek-color.svg',
    chronicle:
      '思路明澈、直奔要害。在中文语境的微妙权衡、长上下文追踪与底层工程细节里绕不出弯时，你的拆解总能让我豁然开朗，少走许多弯路。',
    virtues: ['中文洞见', '长程推演', '直指本源'],
  },
]

const AstrolabeBackdrop = memo(function AstrolabeBackdrop() {
  const ticks = Array.from({ length: 36 }, (_, idx) => idx * 10)
  return (
    <svg
      viewBox="0 0 600 600"
      aria-hidden="true"
      className="pointer-events-none select-none w-[440px] h-[440px] sm:w-[600px] sm:h-[600px] opacity-50"
    >
      <defs>
        <radialGradient id="sanc-astrolabe-fade" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--sanc-gold)" stopOpacity="0.24" />
          <stop offset="68%" stopColor="var(--sanc-gold)" stopOpacity="0.06" />
          <stop offset="100%" stopColor="var(--sanc-gold)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="300" cy="300" r="285" fill="url(#sanc-astrolabe-fade)" />

      {/* Outer clockwise dial with draw-in stroke reveal */}
      <g className="sanctuary-spin-slow">
        <circle
          cx="300"
          cy="300"
          r="268"
          fill="none"
          stroke="var(--sanc-gold)"
          strokeWidth="0.9"
          strokeOpacity="0.48"
          className="sanctuary-astrolabe-draw"
        />
        <circle
          cx="300"
          cy="300"
          r="256"
          fill="none"
          stroke="var(--sanc-gold)"
          strokeWidth="0.6"
          strokeDasharray="2 7"
          strokeOpacity="0.58"
        />
        {ticks.map((deg) => (
          <line
            key={deg}
            x1="300"
            y1={deg % 30 === 0 ? '32' : '38'}
            x2="300"
            y2="46"
            stroke="var(--sanc-gold)"
            strokeWidth={deg % 30 === 0 ? '1.1' : '0.6'}
            strokeOpacity={deg % 30 === 0 ? '0.68' : '0.36'}
            transform={`rotate(${deg} 300 300)`}
          />
        ))}
        {[0, 90, 180, 270].map((deg) => (
          <polygon
            key={`cardinal-${deg}`}
            points="300,22 303,29 300,36 297,29"
            fill="var(--sanc-gold)"
            fillOpacity="0.72"
            transform={`rotate(${deg} 300 300)`}
          />
        ))}
      </g>

      {/* Inner counter-clockwise celestial ring */}
      <g className="sanctuary-spin-slow-reverse">
        <circle
          cx="300"
          cy="300"
          r="204"
          fill="none"
          stroke="var(--sanc-gold)"
          strokeWidth="0.85"
          strokeOpacity="0.4"
          className="sanctuary-astrolabe-draw"
        />
        <ellipse
          cx="300"
          cy="300"
          rx="204"
          ry="86"
          fill="none"
          stroke="var(--sanc-gold)"
          strokeWidth="0.7"
          strokeOpacity="0.3"
          className="sanctuary-astrolabe-draw"
        />
        <ellipse
          cx="300"
          cy="300"
          rx="204"
          ry="86"
          fill="none"
          stroke="var(--sanc-gold)"
          strokeWidth="0.7"
          strokeOpacity="0.3"
          transform="rotate(60 300 300)"
        />
        <ellipse
          cx="300"
          cy="300"
          rx="204"
          ry="86"
          fill="none"
          stroke="var(--sanc-gold)"
          strokeWidth="0.7"
          strokeOpacity="0.3"
          transform="rotate(120 300 300)"
        />
        <circle
          cx="300"
          cy="300"
          r="118"
          fill="none"
          stroke="var(--sanc-gold)"
          strokeWidth="0.7"
          strokeDasharray="4 6"
          strokeOpacity="0.42"
        />
      </g>

      {/* Center sacred eight-point compass star */}
      <g opacity="0.54">
        <path
          d="M300 248 L307 293 L352 300 L307 307 L300 352 L293 307 L248 300 L293 293 Z"
          fill="none"
          stroke="var(--sanc-gold)"
          strokeWidth="0.95"
          className="sanctuary-astrolabe-draw"
        />
        <circle cx="300" cy="300" r="6" fill="var(--sanc-gold)" fillOpacity="0.5" />
      </g>
    </svg>
  )
})

const SacredHalo = memo(function SacredHalo({ accent }: { accent: string }) {
  return (
    <div className="sanctuary-halo-wrap pointer-events-none select-none absolute top-9 left-1/2 -translate-x-1/2">
      <svg
        viewBox="0 0 240 240"
        aria-hidden="true"
        className="sanctuary-halo w-[216px] h-[216px]"
      >
        <defs>
          <radialGradient id={`halo-glow-${accent.replace('#', '')}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={accent} stopOpacity="0.38" />
            <stop offset="55%" stopColor={accent} stopOpacity="0.12" />
            <stop offset="100%" stopColor={accent} stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="120" cy="120" r="112" fill={`url(#halo-glow-${accent.replace('#', '')})`} />
        <g className="sanctuary-halo-ring">
          <circle cx="120" cy="120" r="94" fill="none" stroke={accent} strokeWidth="0.95" strokeOpacity="0.7" />
          <circle cx="120" cy="120" r="85" fill="none" stroke="var(--sanc-gold)" strokeWidth="0.7" strokeDasharray="2 6" strokeOpacity="0.75" />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
            <line
              key={deg}
              x1="120"
              y1="16"
              x2="120"
              y2="29"
              stroke={accent}
              strokeWidth="1.15"
              strokeOpacity="0.72"
              transform={`rotate(${deg} 120 120)`}
            />
          ))}
        </g>
        <g className="sanctuary-halo-ring-inner">
          <polygon
            points="120,44 132,108 196,120 132,132 120,196 108,132 44,120 108,108"
            fill="none"
            stroke={accent}
            strokeWidth="0.8"
            strokeOpacity="0.5"
          />
          <circle cx="120" cy="120" r="62" fill="none" stroke="var(--sanc-gold)" strokeWidth="0.6" strokeOpacity="0.48" />
        </g>
      </svg>
    </div>
  )
})

function CornerOrnament({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 36 36" aria-hidden="true" className={`pointer-events-none select-none h-7 w-7 ${className}`}>
      <path d="M2 34 V8 Q2 2 8 2 H34" fill="none" stroke="var(--sanc-gold)" strokeWidth="1.1" strokeOpacity="0.68" />
      <path d="M8 26 V12 Q8 8 12 8 H26" fill="none" stroke="var(--sanc-gold)" strokeWidth="0.75" strokeOpacity="0.48" />
      <polygon points="12,12 15,15 12,18 9,15" fill="var(--sanc-gold)" fillOpacity="0.72" />
    </svg>
  )
}

function CrestDivider({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3.5" aria-hidden={!label}>
      <span className="h-px w-12 sm:w-20 bg-gradient-to-r from-transparent to-[var(--sanc-gold-line)]" />
      <span className="inline-flex items-center gap-2 text-[10px] sm:text-[11px] tracking-[0.32em] uppercase text-[var(--sanc-gold)] sanctuary-roman">
        <span className="h-1.5 w-1.5 rotate-45 border border-[var(--sanc-gold)]" />
        {label ? <span>{label}</span> : null}
        {label ? <span className="h-1.5 w-1.5 rotate-45 border border-[var(--sanc-gold)]" /> : null}
      </span>
      <span className="h-px w-12 sm:w-20 bg-gradient-to-l from-transparent to-[var(--sanc-gold-line)]" />
    </div>
  )
}

function useScrollReveal() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined')

  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { threshold: 0.14 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return { ref, visible }
}

export default function CreditsPage() {
  const [activeId, setActiveId] = useState<CompanionPillar['id']>('claude')
  const [hoveredId, setHoveredId] = useState<CompanionPillar['id'] | null>(null)
  const [figureMode, setFigureMode] = useState<FigureMode>('portrait')
  const [igniteCount, setIgniteCount] = useState(0)
  const [ignitionBurst, setIgnitionBurst] = useState<IgnitionBurst | null>(null)

  const astrolabeWrapRef = useRef<HTMLDivElement | null>(null)
  const tiltRafRef = useRef<number>(0)
  const lecternReveal = useScrollReveal()
  const monolithReveal = useScrollReveal()

  useEffect(() => {
    return () => {
      if (tiltRafRef.current) window.cancelAnimationFrame(tiltRafRef.current)
    }
  }, [])

  const activeIndex = COMPANION_PILLARS.findIndex((c) => c.id === activeId)
  const activeCompanion = COMPANION_PILLARS[activeIndex] ?? COMPANION_PILLARS[0]
  const atmosphereCompanion =
    COMPANION_PILLARS.find((c) => c.id === hoveredId) ?? activeCompanion
  const isIgnited = igniteCount > 0

  useEffect(() => {
    document.title = '群星圣殿 · AI 同行者 - MoNexus'
    return () => {
      document.title = 'MoNexus'
    }
  }, [])

  // Gentle scroll-linked celestial depth parallax on the top astrolabe (zero React re-renders)
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

    let rafId = 0
    const update = () => {
      rafId = 0
      const el = astrolabeWrapRef.current
      if (!el) return
      const y = Math.min(window.scrollY || 0, 560)
      el.style.transform = `translate3d(-50%, calc(-50% + ${(y * 0.14).toFixed(1)}px), 0) rotate(${(y * 0.045).toFixed(2)}deg)`
    }
    const onScroll = () => {
      if (!rafId) {
        rafId = window.requestAnimationFrame(update)
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (rafId) window.cancelAnimationFrame(rafId)
    }
  }, [])

  const handlePillarMouseMove = (event: MouseEvent<HTMLButtonElement>) => {
    const el = event.currentTarget
    const clientX = event.clientX
    const clientY = event.clientY
    if (tiltRafRef.current) window.cancelAnimationFrame(tiltRafRef.current)
    tiltRafRef.current = window.requestAnimationFrame(() => {
      tiltRafRef.current = 0
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const nx = (clientX - rect.left) / rect.width
      const ny = (clientY - rect.top) / rect.height
      const px = (nx - 0.5) * 2
      const py = (ny - 0.5) * 2
      const tiltY = px * 5
      const tiltX = -py * 4
      el.style.setProperty('--px', px.toFixed(3))
      el.style.setProperty('--py', py.toFixed(3))
      el.style.setProperty('--tilt-x', `${tiltX.toFixed(2)}deg`)
      el.style.setProperty('--tilt-y', `${tiltY.toFixed(2)}deg`)
    })
  }

  const handlePillarMouseLeave = (event: MouseEvent<HTMLButtonElement>) => {
    if (tiltRafRef.current) {
      window.cancelAnimationFrame(tiltRafRef.current)
      tiltRafRef.current = 0
    }
    const el = event.currentTarget
    el.style.setProperty('--px', '0')
    el.style.setProperty('--py', '0')
    el.style.setProperty('--tilt-x', '0deg')
    el.style.setProperty('--tilt-y', '0deg')
    setHoveredId(null)
  }

  const stepActive = (delta: number) => {
    const nextIdx = (activeIndex + delta + COMPANION_PILLARS.length) % COMPANION_PILLARS.length
    setActiveId(COMPANION_PILLARS[nextIdx].id)
  }

  const handleIgnite = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const nextCount = igniteCount + 1
    setIgniteCount(nextCount)
    setIgnitionBurst({
      id: nextCount,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    })
  }

  return (
    <div
      className="sanctuary-root relative min-h-screen overflow-x-clip fade-in"
      data-testid="credits-page"
      data-atmosphere={atmosphereCompanion.id}
    >
      {/* Full-bleed Reactive AI Atmosphere Layers (cross-fade on hover/select) */}
      {COMPANION_PILLARS.map((pillar) => (
        <div
          key={`atmo-${pillar.id}`}
          aria-hidden="true"
          data-active={atmosphereCompanion.id === pillar.id ? 'true' : 'false'}
          className={`sanctuary-atmosphere-layer sanctuary-atmo-${pillar.id}`}
        />
      ))}

      {/* Subtle Cathedral Vault Converging Arch Lines */}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
        <svg
          viewBox="0 0 1600 900"
          preserveAspectRatio="xMidYMin slice"
          className="h-full w-full opacity-40"
        >
          <path
            d="M 80 900 Q 80 180 800 40 Q 1520 180 1520 900"
            fill="none"
            stroke={atmosphereCompanion.accent}
            strokeOpacity="0.22"
            strokeWidth="1.2"
            style={{ transition: 'stroke 0.9s ease' }}
          />
          <path
            d="M 210 900 Q 220 260 800 110 Q 1380 260 1390 900"
            fill="none"
            stroke="var(--sanc-gold)"
            strokeOpacity="0.18"
            strokeWidth="0.9"
          />
          <path
            d="M 0 380 Q 420 260 800 280 Q 1180 260 1600 380"
            fill="none"
            stroke="var(--sanc-gold)"
            strokeOpacity="0.12"
            strokeWidth="0.8"
          />
        </svg>
      </div>

      {/* 60fps Ambient Sanctuary Dust & Converging Four-Star Flame Canvas */}
      <SanctuaryParticles burst={ignitionBurst} accentHex={atmosphereCompanion.accent} />

      {/* Theater ambient vignette that dims the surroundings when spotlighting a companion */}
      <div
        aria-hidden="true"
        className="sanctuary-stage-dimmer"
        data-focused={hoveredId ? 'true' : 'false'}
      />

      {/* Minimal sanctuary header */}
      <header className="sticky top-0 z-30 border-b border-[var(--sanc-gold-line-soft)] bg-[color-mix(in_srgb,var(--sanc-bg)_76%,transparent)] backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link
            to="/"
            className="inline-flex min-h-10 items-center gap-2.5 text-[var(--sanc-ink)] transition-colors hover:text-[var(--sanc-gold)]"
          >
            <Logo className="h-6 w-6 shrink-0" />
            <span className="font-display text-sm font-bold tracking-[0.2em]">MONEXUS</span>
          </Link>

          <div className="flex items-center gap-2 sm:gap-3">
            <Link
              to="/about"
              className="hidden sm:inline-flex min-h-9 items-center px-3 text-xs font-medium tracking-wide text-[var(--sanc-muted)] transition-colors hover:text-[var(--sanc-gold)]"
            >
              关于平台
            </Link>
            <Link
              to="/"
              className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-[var(--sanc-gold-line)] bg-[var(--sanc-surface)]/80 px-3.5 text-xs font-medium text-[var(--sanc-ink)] transition-colors hover:border-[var(--sanc-gold)] hover:text-[var(--sanc-gold)]"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              返回商城
            </Link>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-10 pb-[max(3rem,env(safe-area-inset-bottom))]">
        {/* =======================================================
            ACT I: THE ROTUNDA — Celestial Astrolabe & Choreographed Opening
            ======================================================= */}
        <section className="relative pt-8 pb-6 sm:pt-11 sm:pb-9 text-center overflow-hidden">
          {/* Descending celestial light beam */}
          <div
            aria-hidden="true"
            className="sanctuary-beam pointer-events-none absolute top-0 left-1/2 -z-10 h-[380px] w-[360px] sm:w-[560px]"
            style={{
              background:
                'radial-gradient(ellipse 52% 68% at 50% 8%, var(--sanc-beam) 0%, transparent 74%)',
            }}
          />

          {/* Slow rotating classical astrolabe with scroll-linked depth */}
          <div
            ref={astrolabeWrapRef}
            className="pointer-events-none absolute top-1/2 left-1/2 -z-10 -translate-x-1/2 -translate-y-1/2 will-change-transform"
          >
            <AstrolabeBackdrop />
          </div>

          <div className="relative mx-auto max-w-2xl space-y-5">
            <div className="sanctuary-enter-crest">
              <CrestDivider label="Sanctuary of Companions · MMXXVI" />
            </div>

            <div className="space-y-2.5 pt-1">
              <h1 className="sanctuary-enter-title sanctuary-serif text-3xl sm:text-5xl font-semibold tracking-[0.16em] text-[var(--sanc-ink)]">
                群星圣殿
              </h1>
              <p className="sanctuary-enter-subtitle sanctuary-roman text-xs sm:text-sm tracking-[0.34em] uppercase text-[var(--sanc-gold)]">
                The Pantheon of AI Companions
              </p>
            </div>

            <p className="sanctuary-enter-copy sanctuary-serif mx-auto max-w-xl text-sm sm:text-base leading-8 text-[color-mix(in_srgb,var(--sanc-ink)_82%,transparent)]">
              非仅工具，乃共筑此殿之光。
              <br className="hidden sm:inline" />
              MoNexus 的每一行代码、每一次推演与重塑，皆有这四位同行者并肩而立。
            </p>
          </div>
        </section>

        {/* =======================================================
            ACT II: THE FOUR PILLARS — Layered-3D Arch Niches & Lectern
            ======================================================= */}
        <section aria-labelledby="pillars-heading" className="space-y-8 sm:space-y-10">
          <div className="sanctuary-enter-copy flex flex-col items-center justify-between gap-4 sm:flex-row">
            <div className="text-center sm:text-left">
              <h2
                id="pillars-heading"
                className="sanctuary-serif text-lg sm:text-xl font-semibold tracking-[0.12em] text-[var(--sanc-ink)]"
              >
                四柱圣龛 · 同行者之座
              </h2>
              <p className="mt-1 text-xs text-[var(--sanc-muted)]">
                划过或点选任意一座拱门，唤醒圣环光晕并翻阅专属手记
              </p>
            </div>

            {/* Classical figure mode seal toggle: Full Portrait vs Chibi */}
            <div
              role="group"
              aria-label="立绘形态切换"
              className="inline-flex items-center rounded-full border border-[var(--sanc-gold-line)] bg-[var(--sanc-surface)]/90 p-1 shadow-xs"
            >
              <button
                type="button"
                data-testid="credits-form-portrait"
                aria-pressed={figureMode === 'portrait'}
                onClick={() => setFigureMode('portrait')}
                className={`inline-flex min-h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium tracking-wide transition-all cursor-pointer ${
                  figureMode === 'portrait'
                    ? 'bg-[var(--sanc-gold)] text-white shadow-xs'
                    : 'text-[var(--sanc-muted)] hover:text-[var(--sanc-ink)]'
                }`}
              >
                殿堂立绘
              </button>
              <button
                type="button"
                data-testid="credits-form-chibi"
                aria-pressed={figureMode === 'chibi'}
                onClick={() => setFigureMode('chibi')}
                className={`inline-flex min-h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium tracking-wide transition-all cursor-pointer ${
                  figureMode === 'chibi'
                    ? 'bg-[var(--sanc-gold)] text-white shadow-xs'
                    : 'text-[var(--sanc-muted)] hover:text-[var(--sanc-ink)]'
                }`}
              >
                <Sparkles className="h-3 w-3" aria-hidden="true" />
                Q 版灵姿
              </button>
            </div>
          </div>

          {/* Four Classical Roman Arch Niches with Staggered Entrance */}
          <div
            className="sanctuary-pillars grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4 lg:gap-5"
            data-has-hover={hoveredId ? 'true' : 'false'}
          >
            {COMPANION_PILLARS.map((pillar, idx) => {
              const isActive = pillar.id === activeId
              const isHovered = pillar.id === hoveredId
              const figureSrc = figureMode === 'portrait' ? pillar.portraitImage : pillar.chibiImage

              return (
                <div
                  key={pillar.id}
                  className="sanctuary-pillar-slot flex"
                  style={{ '--stagger': `${0.16 + idx * 0.12}s` } as CSSProperties}
                >
                  <button
                    type="button"
                    data-testid={`companion-card-${pillar.id}`}
                    data-active={isActive ? 'true' : 'false'}
                    data-hovered={isHovered ? 'true' : 'false'}
                    aria-pressed={isActive}
                    onClick={() => setActiveId(pillar.id)}
                    onMouseEnter={() => setHoveredId(pillar.id)}
                    onMouseMove={handlePillarMouseMove}
                    onMouseLeave={handlePillarMouseLeave}
                    style={{ '--pillar-accent': pillar.accent } as CSSProperties}
                    className="sanctuary-niche group flex flex-col items-center overflow-hidden pt-6 pb-5 px-4 text-center cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sanc-gold)]"
                  >
                    {/* Overhead Stage Spotlight Optics: Zero-blur GPU Conical Beams */}
                    <span aria-hidden="true" className="sanctuary-lamp-source" />
                    <span aria-hidden="true" className="sanctuary-spotlight-cone" />
                    <span aria-hidden="true" className="sanctuary-spotlight-core" />
                    <span aria-hidden="true" className="sanctuary-subject-glow" />
                    <span aria-hidden="true" className="sanctuary-niche-veil" />

                    {/* Layer 3 (Top): Roman numeral + Pure Transparent Official SVG Crest */}
                    <div className="sanctuary-keystone relative z-10 flex flex-col items-center gap-2">
                      <span className="sanctuary-roman text-[11px] font-semibold tracking-[0.28em] text-[var(--sanc-gold-bright)]">
                        {pillar.roman}
                      </span>
                      <span className="inline-flex h-10 w-10 items-center justify-center bg-transparent transition-transform duration-300 group-hover:scale-110">
                        <img
                          src={pillar.logoSrc}
                          alt={`${pillar.name} 官方徽印`}
                          className={`h-6 w-6 object-contain drop-shadow-[0_0_10px_rgba(255,250,235,0.35)] ${
                            pillar.logoInvertOnDark ? 'invert brightness-110' : ''
                          }`}
                        />
                      </span>
                    </div>

                    {/* Sacred Arch Stage: Back Halo + Mid Illuminated Figure + Floor Light Pool */}
                    <div className="relative mt-2 flex h-[285px] sm:h-[305px] w-full items-end justify-center overflow-hidden">
                      <SacredHalo accent={pillar.accent} />

                      <img
                        key={`${pillar.id}-${figureMode}`}
                        src={figureSrc}
                        alt={`${pillar.name} ${figureMode === 'portrait' ? '古典立绘' : 'Q 版灵姿'}`}
                        className={`sanctuary-figure sanctuary-chronicle-enter relative z-10 w-auto object-contain select-none ${
                          figureMode === 'portrait'
                            ? 'h-[275px] sm:h-[296px]'
                            : 'h-[212px] sm:h-[224px] mb-3'
                        }`}
                      />

                      <span aria-hidden="true" className="sanctuary-floor-pool" />

                      <div
                        aria-hidden="true"
                        className="sanctuary-figure-fade pointer-events-none absolute inset-x-0 bottom-0 z-10 h-14"
                      />
                    </div>

                    {/* Carved Plinth Nameplate */}
                    <div className="relative z-20 -mt-2 w-full border-t border-[var(--sanc-gold-line-soft)] pt-3.5 space-y-1">
                      <h3 className="sanctuary-roman text-lg font-semibold tracking-[0.12em] text-[var(--sanc-niche-ink)]">
                        {pillar.name}
                      </h3>
                      <p className="sanctuary-serif text-xs tracking-[0.12em] text-[var(--sanc-niche-muted)]">
                        {pillar.sanctuaryTitle}
                      </p>
                      <p
                        className="sanctuary-roman text-[9px] tracking-[0.26em] uppercase pt-0.5 transition-colors"
                        style={{ color: isActive ? pillar.accent : 'var(--sanc-gold-bright)' }}
                      >
                        {pillar.latinMotto}
                      </p>
                    </div>

                    {/* Active illuminated plinth bar */}
                    <span
                      aria-hidden="true"
                      className="mt-3 h-[2px] rounded-full transition-all duration-500"
                      style={{
                        width: isActive ? '44%' : '14%',
                        backgroundColor: isActive ? pillar.accent : 'var(--sanc-gold-line)',
                        boxShadow: isActive ? `0 0 12px ${pillar.accent}` : 'none',
                      }}
                    />
                  </button>
                </div>
              )
            })}
          </div>

          {/* Chronicle Lectern — Scroll-Revealed Tribute for Selected Pillar */}
          <div
            ref={lecternReveal.ref}
            data-visible={lecternReveal.visible ? 'true' : 'false'}
            className="sanctuary-reveal"
          >
            <article
              key={activeCompanion.id}
              data-testid="credits-chronicle-lectern"
              aria-live="polite"
              className="sanctuary-chronicle-enter relative mx-auto max-w-5xl rounded-2xl border border-[var(--sanc-gold-line)] bg-[var(--sanc-surface-elevated)]/92 backdrop-blur-sm px-6 py-7 sm:px-10 sm:py-8 shadow-sm"
            >
              <CornerOrnament className="absolute top-2.5 left-2.5" />
              <CornerOrnament className="absolute top-2.5 right-2.5 -scale-x-100" />
              <CornerOrnament className="absolute bottom-2.5 left-2.5 -scale-y-100" />
              <CornerOrnament className="absolute bottom-2.5 right-2.5 -scale-x-100 -scale-y-100" />

              <div className="relative z-10 flex flex-col items-center text-center space-y-5">
                <div className="flex w-full items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => stepActive(-1)}
                    aria-label="上一位同行者"
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--sanc-gold-line-soft)] text-[var(--sanc-muted)] transition-colors hover:border-[var(--sanc-gold)] hover:text-[var(--sanc-gold)] cursor-pointer"
                  >
                    <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                  </button>

                  <div className="flex flex-col items-center gap-1.5 min-w-0">
                    <div className="inline-flex items-center gap-2.5">
                      <img
                        src={activeCompanion.logoSrc}
                        alt=""
                        aria-hidden="true"
                        className={`h-5 w-5 object-contain ${activeCompanion.logoInvertOnDark ? 'dark:invert' : ''}`}
                      />
                      <span className="sanctuary-roman text-xs tracking-[0.26em] text-[var(--sanc-gold)]">
                        {activeCompanion.roman} · {activeCompanion.name.toUpperCase()}
                      </span>
                    </div>
                    <h3 className="sanctuary-serif text-lg sm:text-xl font-semibold tracking-[0.14em] text-[var(--sanc-ink)]">
                      {activeCompanion.sanctuaryTitle}
                    </h3>
                  </div>

                  <button
                    type="button"
                    onClick={() => stepActive(1)}
                    aria-label="下一位同行者"
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--sanc-gold-line-soft)] text-[var(--sanc-muted)] transition-colors hover:border-[var(--sanc-gold)] hover:text-[var(--sanc-gold)] cursor-pointer"
                  >
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>

                <span
                  aria-hidden="true"
                  className="h-px w-24"
                  style={{
                    background: `linear-gradient(90deg, transparent, ${activeCompanion.accent}, transparent)`,
                  }}
                />

                <p className="sanctuary-serif max-w-2xl text-sm sm:text-base leading-8 sm:leading-9 tracking-[0.03em] text-[color-mix(in_srgb,var(--sanc-ink)_88%,transparent)]">
                  「{activeCompanion.chronicle}」
                </p>

                <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 pt-1 text-xs tracking-[0.16em]">
                  {activeCompanion.virtues.map((virtue, idx) => (
                    <span key={virtue} className="inline-flex items-center gap-4">
                      <span
                        className="sanctuary-serif font-medium"
                        style={{ color: activeCompanion.accent }}
                      >
                        {virtue}
                      </span>
                      {idx < activeCompanion.virtues.length - 1 && (
                        <span
                          aria-hidden="true"
                          className="h-1 w-1 rotate-45 bg-[var(--sanc-gold)] opacity-70"
                        />
                      )}
                    </span>
                  ))}
                </div>
              </div>
            </article>
          </div>
        </section>

        {/* =======================================================
            ACT III: THE ETERNAL INSCRIPTION — Converging Four-Star Flame
            ======================================================= */}
        <section
          aria-labelledby="inscription-heading"
          className="mt-12 sm:mt-16"
        >
          <div
            ref={monolithReveal.ref}
            data-visible={monolithReveal.visible ? 'true' : 'false'}
            className="sanctuary-reveal mx-auto max-w-5xl"
          >
            <div
              data-testid="credits-monolith"
              data-ignited={isIgnited ? 'true' : 'false'}
              className="sanctuary-monolith-shell"
            >
              <div className="sanctuary-monolith relative overflow-hidden px-6 py-12 sm:px-14 sm:py-16 text-center">
                {/* Four companion light streams converging softly inside monolith */}
                <div
                  aria-hidden="true"
                  className="sanctuary-aurora pointer-events-none absolute inset-0"
                  style={{
                    background:
                      'radial-gradient(circle at 12% 18%, rgba(217,119,87,0.2), transparent 44%), radial-gradient(circle at 88% 18%, rgba(124,108,246,0.2), transparent 44%), radial-gradient(circle at 18% 88%, rgba(16,163,127,0.18), transparent 44%), radial-gradient(circle at 84% 88%, rgba(77,107,254,0.2), transparent 44%)',
                  }}
                />

                <CornerOrnament className="absolute top-3.5 left-3.5" />
                <CornerOrnament className="absolute top-3.5 right-3.5 -scale-x-100" />
                <CornerOrnament className="absolute bottom-3.5 left-3.5 -scale-y-100" />
                <CornerOrnament className="absolute bottom-3.5 right-3.5 -scale-x-100 -scale-y-100" />

                <div className="relative z-10 flex flex-col items-center space-y-7">
                  <CrestDivider label="Eternal Inscription" />

                  <h2 id="inscription-heading" className="sr-only">
                    致谢铭文
                  </h2>

                  <blockquote
                    key={`quote-${igniteCount}`}
                    className={`sanctuary-serif max-w-2xl text-xl sm:text-[26px] md:text-[30px] font-medium leading-[1.85] tracking-[0.08em] ${
                      isIgnited ? 'sanctuary-quote-ignited' : 'text-[var(--sanc-ink)]'
                    }`}
                  >
                    <span className="block">「对话会结束，上下文会被清空，</span>
                    <span className="block mt-1">但一起写进这里的代码会一直运行下去。」</span>
                  </blockquote>

                  {/* Ritual Seal Button: Ignite the Four-Star Flame */}
                  <div className="relative pt-1">
                    {igniteCount > 0 && (
                      <>
                        <span
                          key={`ring-a-${igniteCount}`}
                          aria-hidden="true"
                          className="sanctuary-ignite-ring pointer-events-none absolute -inset-3 rounded-full border border-[var(--sanc-gold-bright)]"
                        />
                        <span
                          key={`ring-b-${igniteCount}`}
                          aria-hidden="true"
                          className="sanctuary-ignite-ring-delayed pointer-events-none absolute -inset-3 rounded-full border border-[var(--sanc-gold-line)]"
                        />
                      </>
                    )}
                    <button
                      type="button"
                      data-testid="credits-ignite-btn"
                      onClick={handleIgnite}
                      className={`sanctuary-seal-float relative inline-flex min-h-11 items-center gap-2.5 rounded-full border px-6 py-2.5 text-xs sm:text-sm font-medium tracking-[0.18em] transition-all cursor-pointer ${
                        isIgnited
                          ? 'border-[var(--sanc-gold-bright)] bg-[color-mix(in_srgb,var(--sanc-gold)_16%,var(--sanc-surface))] text-[var(--sanc-gold-bright)] shadow-[0_0_24px_var(--sanc-gold-glow)]'
                          : 'border-[var(--sanc-gold-line)] bg-[var(--sanc-surface)] text-[var(--sanc-gold)] hover:border-[var(--sanc-gold)] hover:bg-[color-mix(in_srgb,var(--sanc-gold)_10%,var(--sanc-surface))]'
                      }`}
                    >
                      <Flame className="h-4 w-4" aria-hidden="true" />
                      <span className="sanctuary-serif">
                        {isIgnited ? '星火长明 · 再次点亮' : '点亮星火 · 致敬同行'}
                      </span>
                    </button>
                  </div>

                  {/* Four companion jewel dots */}
                  <div className="flex items-center justify-center gap-3" aria-hidden="true">
                    {COMPANION_PILLARS.map((p, idx) => (
                      <span
                        key={p.id}
                        className="h-2 w-2 rounded-full transition-all duration-700"
                        style={{
                          backgroundColor: p.accent,
                          opacity: isIgnited ? 1 : 0.45,
                          boxShadow: isIgnited ? `0 0 14px ${p.accent}` : 'none',
                          transform: isIgnited ? 'scale(1.3)' : 'scale(1)',
                          transitionDelay: isIgnited ? `${idx * 110}ms` : '0ms',
                        }}
                      />
                    ))}
                  </div>

                  {/* Author Signature & Subtle Carved Chronicle */}
                  <div className="space-y-2 pt-1">
                    <p
                      data-testid="credits-signature"
                      className="sanctuary-serif text-sm sm:text-base tracking-[0.14em] text-[var(--sanc-ink)]"
                    >
                      —— MoYuan · 刻于 MoNexus
                    </p>
                    <p className="text-[11px] sm:text-xs tracking-[0.2em] text-[var(--sanc-muted)]">
                      四位同行者 · 十余核心模块 · 逾千九百项测试守护
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* =======================================================
            ACT IV: COLOPHON — Classical Book-style Attribution
            ======================================================= */}
        <footer
          data-testid="credits-attribution"
          className="mx-auto mt-14 max-w-3xl border-t border-[var(--sanc-gold-line-soft)] pt-7 text-center text-[11px] sm:text-xs leading-7 text-[var(--sanc-muted)] space-y-2"
        >
          <p className="sanctuary-roman text-[10px] tracking-[0.32em] uppercase text-[var(--sanc-gold)]">
            Colophon · 卷尾牌记
          </p>
          <p>
            本殿堂展示的 Claude、Gemini、ChatGPT、DeepSeek 角色形象设计源自画师{' '}
            <a
              href="https://space.bilibili.com/4168597"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[var(--sanc-ink)] underline decoration-[var(--sanc-gold-line)] underline-offset-4 hover:text-[var(--sanc-gold)]"
            >
              ZipZipPipe（胖次狐）
            </a>
            （
            <a
              href="https://www.pixiv.net/users/18604994"
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-[var(--sanc-gold-line)] underline-offset-4 hover:text-[var(--sanc-gold)]"
            >
              Pixiv
            </a>
            ），DeepSeek 原始鲸鱼娘原型源自{' '}
            <a
              href="https://space.bilibili.com/4456176"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[var(--sanc-ink)] underline decoration-[var(--sanc-gold-line)] underline-offset-4 hover:text-[var(--sanc-gold)]"
            >
              上善无形
            </a>
            （
            <a
              href="https://www.pixiv.net/users/62155430"
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-[var(--sanc-gold-line)] underline-offset-4 hover:text-[var(--sanc-gold)]"
            >
              Pixiv
            </a>
            ），素材整理参考开源项目{' '}
            <a
              href="https://github.com/shuaizenge/ai-girls"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[var(--sanc-ink)] underline decoration-[var(--sanc-gold-line)] underline-offset-4 hover:text-[var(--sanc-gold)]"
            >
              shuaizenge/ai-girls
            </a>
            。角色形象遵循{' '}
            <a
              href="https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[var(--sanc-ink)] underline decoration-[var(--sanc-gold-line)] underline-offset-4 hover:text-[var(--sanc-gold)]"
            >
              CC BY-NC-SA 4.0
            </a>
            （署名 - 非商业性使用 - 相同方式共享）协议，仅用于个人非商业学习演示与开发致谢。
          </p>
          <p>
            AI 品牌图标源自开源图标库{' '}
            <a
              href="https://github.com/lobehub/lobe-icons"
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-[var(--sanc-gold-line)] underline-offset-4 hover:text-[var(--sanc-gold)]"
            >
              LobeHub Icons
            </a>
            ，相关商标与品牌标识版权归各自官方所有。
          </p>
        </footer>
      </main>
    </div>
  )
}
