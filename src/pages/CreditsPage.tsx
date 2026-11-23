import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  BookOpen,
  Code2,
  Compass,
  Heart,
  Layers,
  LayoutGrid,
  Lightbulb,
  Rocket,
  ShieldCheck,
  Sparkles,
  Wrench,
  Zap,
} from 'lucide-react'
import Logo from '../components/ui/Logo'

type ViewMode = 'cards' | 'overview'

function ClaudeLogo({ className = 'w-6 h-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 1.75c.46 0 .84.35.88.81l.52 5.43 4.02-3.71a.88.88 0 0 1 1.24.04c.32.35.31.89-.03 1.22l-3.83 3.74 5.45-.36a.88.88 0 0 1 .94.82c.03.48-.33.9-.81.94l-5.43.52 3.71 4.02a.88.88 0 0 1-.04 1.24.88.88 0 0 1-1.22-.03l-3.74-3.83.36 5.45a.88.88 0 0 1-.82.94.88.88 0 0 1-.94-.81l-.52-5.43-4.02 3.71a.88.88 0 0 1-1.24-.04.88.88 0 0 1 .03-1.22l3.83-3.74-5.45.36a.88.88 0 0 1-.94-.82.88.88 0 0 1 .81-.94l5.43-.52-3.71-4.02a.88.88 0 0 1 .04-1.24.88.88 0 0 1 1.22.03l3.74 3.83-.36-5.45a.88.88 0 0 1 .82-.94z" />
    </svg>
  )
}

function GeminiLogo({ className = 'w-6 h-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="gemini-sparkle-grad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#4285F4" />
          <stop offset="52%" stopColor="#6366F1" />
          <stop offset="100%" stopColor="#9B72CB" />
        </linearGradient>
      </defs>
      <path
        d="M12 1.5C12 7.3 7.3 12 1.5 12C7.3 12 12 16.7 12 22.5C12 16.7 16.7 12 22.5 12C16.7 12 12 7.3 12 1.5Z"
        fill="url(#gemini-sparkle-grad)"
      />
    </svg>
  )
}

function ChatGptLogo({ className = 'w-6 h-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08-4.778 2.758a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  )
}

function DeepSeekLogo({ className = 'w-6 h-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M21.45 7.42c-.52-.23-1.17.1-1.66.61-.46.48-.89 1.07-1.36 1.53-.49-1.8-1.93-3.39-3.95-4.08-2.08-.71-4.5-.55-6.51.55-.84.46-1.56 1.04-2.16 1.71-.52-.35-1.15-.55-1.83-.48-.98.1-1.78.83-1.93 1.79-.12.76.22 1.48.8 1.92-.12.6-.16 1.22-.1 1.85.26 2.9 2.24 5.45 5.13 6.32 2.97.9 6.35.22 8.71-1.84 1.4-1.23 2.38-2.85 2.86-4.63.52-.25 1.04-.62 1.48-1.12.78-.88 1.15-2.16.82-3.2-.13-.42-.38-.78-.7-.93zM9.2 12.15a1.05 1.05 0 1 1 0-2.1 1.05 1.05 0 0 1 0 2.1zm4.85 3.77c-1.85.56-3.93.12-5.32-1.11-.3-.27-.24-.76.12-.95.24-.13.54-.09.76.09 1.06.87 2.57 1.18 3.97.76 1.22-.36 2.26-1.18 2.89-2.25.17-.28.53-.38.82-.22.29.16.4.52.24.81-.76 1.38-2.02 2.41-3.48 2.87z" />
    </svg>
  )
}

interface Companion {
  id: 'claude' | 'gemini' | 'chatgpt' | 'deepseek'
  name: string
  subtitle: string
  accent: string
  catImage: string
  logo: ReactNode
  description: string
  tags: string[]
  scores: {
    architecture: number
    frontend: number
    implementation: number
    analysis: number
  }
}

const HERO_PILLS = [
  { icon: Code2, label: '架构设计' },
  { icon: Layers, label: '方案推演' },
  { icon: Zap, label: '编码实现' },
  { icon: ShieldCheck, label: '评审优化' },
  { icon: BookOpen, label: '知识探索' },
]

const COMPANIONS: Companion[] = [
  {
    id: 'claude',
    name: 'Claude',
    subtitle: '深度思考 · 架构与工程',
    accent: '#D97757',
    catImage: '/credits/cat-claude.webp',
    logo: <ClaudeLogo className="w-6 h-6" />,
    description:
      '面对复杂状态机、多方对账和盘根错节的边界问题时，总能沉下心陪我把逻辑一层层理顺。很多难啃的重构和漫长的代码审查，都是你帮我稳稳托住的。',
    tags: ['架构设计', '复杂推理', '全局评审'],
    scores: { architecture: 96, frontend: 86, implementation: 94, analysis: 95 },
  },
  {
    id: 'gemini',
    name: 'Gemini',
    subtitle: '全局视野 · 创意与打磨',
    accent: '#5B64F1',
    catImage: '/credits/cat-gemini.webp',
    logo: <GeminiLogo className="w-6 h-6" />,
    description:
      '总能跳出局部看到整体，在前端设计、多模态理解与体验细节的反复斟酌上尤为出色，一次次帮我发现那些容易忽略的瑕疵，让站点更耐看、更顺手。',
    tags: ['前端与设计', '多模态理解', '体验打磨'],
    scores: { architecture: 88, frontend: 96, implementation: 92, analysis: 90 },
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    subtitle: '通用协作 · 灵感与陪伴',
    accent: '#10A37F',
    catImage: '/credits/cat-chatgpt.webp',
    logo: <ChatGptLogo className="w-6 h-6" />,
    description:
      '从最初一个模糊的念头开始，每一次随口抛出的设想、每一次遇到陌生报错时的求助，你都在第一时间接住，陪我把无数个“能不能试试”变成现实。',
    tags: ['代码实现', '技术解答', '文档整理'],
    scores: { architecture: 89, frontend: 88, implementation: 93, analysis: 90 },
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    subtitle: '高效务实 · 中文与工程',
    accent: '#2563EB',
    catImage: '/credits/cat-deepseek.webp',
    logo: <DeepSeekLogo className="w-6 h-6" />,
    description:
      '思路清晰、直奔要害。在中文语义理解、长上下文追踪和底层工程细节里绕不出弯时，你的拆解总能让我豁然开朗，少走很多弯路。',
    tags: ['中文理解', '长上下文', '深度剖析'],
    scores: { architecture: 90, frontend: 82, implementation: 90, analysis: 96 },
  },
]

const WORKFLOW_STEPS = [
  {
    icon: Lightbulb,
    title: '想法与需求',
    desc: '从灵感到可行方案',
    accent: '#D97757',
  },
  {
    icon: Wrench,
    title: '方案与实现',
    desc: '架构设计、编码落地',
    accent: '#5B64F1',
  },
  {
    icon: ShieldCheck,
    title: '评审与优化',
    desc: '代码审查、风险收敛',
    accent: '#2563EB',
  },
  {
    icon: Rocket,
    title: '落地与迭代',
    desc: '持续验证、细节打磨',
    accent: '#10A37F',
  },
]

const ACHIEVEMENTS = [
  {
    icon: Code2,
    value: '15+',
    label: '核心业务模块',
    accent: '#10A37F',
  },
  {
    icon: Layers,
    value: '数万行',
    label: '代码协作与优化',
    accent: '#5B64F1',
  },
  {
    icon: ShieldCheck,
    value: '1,900+',
    label: '自动化测试守护',
    accent: '#D97757',
  },
]

const SCORE_DIMENSIONS: Array<{ key: keyof Companion['scores']; label: string }> = [
  { key: 'architecture', label: '架构推演与工程重构' },
  { key: 'frontend', label: '前端体验与交互打磨' },
  { key: 'implementation', label: '代码实现与日常排障' },
  { key: 'analysis', label: '深度剖析与方案评审' },
]

export default function CreditsPage() {
  const [viewMode, setViewMode] = useState<ViewMode>('cards')

  useEffect(() => {
    document.title = 'AI 伙伴与致谢 - MoNexus'
    return () => {
      document.title = 'MoNexus'
    }
  }, [])

  return (
    <div className="min-h-screen overflow-x-clip bg-[var(--color-background)] fade-in" data-testid="credits-page">
      {/* Minimal standalone top bar aligned with MoNexus shell */}
      <header className="sticky top-0 z-30 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface)_86%,transparent)] backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between px-4 sm:px-6">
          <Link
            to="/"
            className="inline-flex min-h-10 items-center gap-2 text-[var(--color-text)] transition-colors hover:text-[var(--color-primary)]"
          >
            <Logo className="h-6 w-6 shrink-0" />
            <span className="font-display text-sm font-bold tracking-[0.18em]">MONEXUS</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link
              to="/about"
              className="hidden sm:inline-flex min-h-9 items-center rounded-full px-3 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
            >
              关于平台
            </Link>
            <Link
              to="/"
              className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 text-xs font-semibold text-[var(--color-text)] transition-colors hover:border-[var(--color-primary-border-subtle)] hover:text-[var(--color-primary)]"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              返回商城
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-4 pt-6 pb-[max(3rem,env(safe-area-inset-bottom))] sm:px-6 sm:pt-8 sm:pb-16 space-y-8 sm:space-y-10">
        {/* 1. Hero Banner — Cozy Desk + Four Cats Illustration */}
        <section className="relative overflow-hidden rounded-2xl sm:rounded-3xl border border-[var(--color-border)] bg-[#141c2f] shadow-lg">
          {/* Desktop full-bleed background illustration */}
          <img
            src="/credits/hero-companions.webp"
            alt="开发者与四只戴着不同颜色围巾的 AI 小猫并排看着 MoNexus 屏幕"
            className="hidden md:block absolute inset-0 h-full w-full object-cover object-right select-none"
          />
          <div
            className="hidden md:block absolute inset-0 bg-gradient-to-r from-[#0f172a]/95 via-[#0f172a]/76 to-transparent"
            aria-hidden="true"
          />

          <div className="relative z-10 grid grid-cols-1 md:grid-cols-12 md:min-h-[340px] lg:min-h-[380px] items-center">
            <div className="p-6 sm:p-8 lg:p-10 md:col-span-7 lg:col-span-6 space-y-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-slate-300/90">
                AI Partners · 同行者
              </p>
              <h1 className="font-heading text-2xl sm:text-4xl font-bold tracking-tight text-white flex items-center gap-2.5 flex-wrap">
                <span>与我的 AI 伙伴们</span>
                <Heart className="h-6 w-6 sm:h-7 sm:w-7 text-[var(--color-primary)] fill-[color-mix(in_srgb,var(--color-primary)_25%,transparent)]" aria-hidden="true" />
              </h1>
              <p className="max-w-lg text-sm sm:text-[15px] leading-7 text-slate-200/90">
                MoNexus 的每一行代码、每一个功能、每一次推翻重来，都离不开这些 AI 伙伴的陪伴与支持。它们不只是工具，更是并肩把想法变成现实的同行者。
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                {HERO_PILLS.map(({ icon: Icon, label }) => (
                  <span
                    key={label}
                    className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-medium text-slate-100 backdrop-blur-md"
                  >
                    <Icon className="h-3.5 w-3.5 text-slate-200" aria-hidden="true" />
                    {label}
                  </span>
                ))}
              </div>
            </div>

            {/* Mobile uncropped illustration below text */}
            <div className="md:hidden relative aspect-[16/9] w-full overflow-hidden border-t border-white/10">
              <img
                src="/credits/hero-companions.webp"
                alt="开发者与四只戴着不同颜色围巾的 AI 小猫并排看着 MoNexus 屏幕"
                className="h-full w-full object-cover object-right"
              />
            </div>
          </div>
        </section>

        {/* 2. My AI Companions — Cards / Capability Overview */}
        <section aria-labelledby="companions-heading" className="space-y-4 sm:space-y-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 id="companions-heading" className="font-heading text-xl sm:text-2xl font-bold text-[var(--color-text)] flex items-center gap-2">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--color-primary-tint)] text-[var(--color-primary)]">
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                </span>
                我的 AI 伙伴
              </h2>
              <p className="text-xs sm:text-sm text-[var(--color-text-muted)]">
                各有所长、互相补位，一起构建 MoNexus。
              </p>
            </div>

            <div
              role="tablist"
              aria-label="伙伴展示视图"
              className="inline-flex self-start sm:self-auto rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] p-1"
            >
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'cards'}
                data-testid="credits-view-cards"
                onClick={() => setViewMode('cards')}
                className={`inline-flex min-h-9 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold transition-colors cursor-pointer ${
                  viewMode === 'cards'
                    ? 'bg-[var(--color-primary)] text-[var(--color-on-primary)] shadow-xs'
                    : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                }`}
              >
                <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
                卡片视图
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'overview'}
                data-testid="credits-view-overview"
                onClick={() => setViewMode('overview')}
                className={`inline-flex min-h-9 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold transition-colors cursor-pointer ${
                  viewMode === 'overview'
                    ? 'bg-[var(--color-primary)] text-[var(--color-on-primary)] shadow-xs'
                    : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                }`}
              >
                <BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />
                能力概览
              </button>
            </div>
          </div>

          {viewMode === 'cards' ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4 sm:gap-5">
              {COMPANIONS.map((companion) => (
                <article
                  key={companion.id}
                  data-testid={`companion-card-${companion.id}`}
                  className="group relative flex h-full flex-col justify-between overflow-hidden rounded-2xl border border-[var(--color-border)] p-5 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md"
                  style={{
                    background: `linear-gradient(155deg, color-mix(in srgb, ${companion.accent} 8%, var(--color-surface)) 0%, var(--color-surface) 58%)`,
                  }}
                >
                  <div>
                    {/* Header: Official Brand SVG + Name + Cute Scarf Cat */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0 pt-1">
                        <span
                          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border"
                          style={{
                            color: companion.accent,
                            backgroundColor: `color-mix(in srgb, ${companion.accent} 10%, var(--color-surface))`,
                            borderColor: `color-mix(in srgb, ${companion.accent} 24%, transparent)`,
                          }}
                        >
                          {companion.logo}
                        </span>
                        <div className="min-w-0">
                          <h3 className="font-heading text-lg font-bold tracking-tight text-[var(--color-text)] truncate">
                            {companion.name}
                          </h3>
                          <p className="text-[11px] font-medium text-[var(--color-text-muted)] truncate">
                            {companion.subtitle}
                          </p>
                        </div>
                      </div>

                      <img
                        src={companion.catImage}
                        alt={`${companion.name} 像素小猫伙伴`}
                        className="h-16 w-16 shrink-0 object-contain transition-transform duration-300 group-hover:-translate-y-1 select-none"
                        loading="lazy"
                      />
                    </div>

                    <p className="mt-3.5 text-xs sm:text-[13px] leading-6 text-[color-mix(in_srgb,var(--color-text)_84%,transparent)]">
                      {companion.description}
                    </p>
                  </div>

                  {/* Capability tags */}
                  <div className="mt-4 flex flex-wrap gap-1.5 pt-3 border-t border-[color-mix(in_srgb,var(--color-border)_65%,transparent)]">
                    {companion.tags.map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium border"
                        style={{
                          color: companion.accent,
                          backgroundColor: `color-mix(in srgb, ${companion.accent} 9%, var(--color-background))`,
                          borderColor: `color-mix(in srgb, ${companion.accent} 22%, transparent)`,
                        }}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="card p-5 sm:p-6 space-y-5" data-testid="credits-capability-overview">
              <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                {COMPANIONS.map((companion) => (
                  <div
                    key={companion.id}
                    className="rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-4 space-y-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5">
                        <span style={{ color: companion.accent }}>{companion.logo}</span>
                        <div>
                          <div className="font-heading text-sm font-bold text-[var(--color-text)]">{companion.name}</div>
                          <div className="text-[11px] text-[var(--color-text-muted)]">{companion.subtitle}</div>
                        </div>
                      </div>
                      <img
                        src={companion.catImage}
                        alt=""
                        aria-hidden="true"
                        className="h-11 w-11 shrink-0 object-contain"
                      />
                    </div>
                    <div className="space-y-2.5">
                      {SCORE_DIMENSIONS.map((dim) => (
                        <div key={dim.key} className="space-y-1">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-[var(--color-text-muted)]">{dim.label}</span>
                            <span className="font-semibold text-[var(--color-text)] tabular-nums">
                              {companion.scores[dim.key]}%
                            </span>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
                            <div
                              className="h-full rounded-full transition-all duration-500"
                              style={{
                                width: `${companion.scores[dim.key]}%`,
                                backgroundColor: companion.accent,
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* 3. How We Collaborate + What We Built Together */}
        <section className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          {/* Left: Workflow */}
          <div className="card lg:col-span-7 flex flex-col justify-between gap-5 p-5 sm:p-6">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="font-heading text-base sm:text-lg font-bold text-[var(--color-text)] flex items-center gap-2">
                <Compass className="h-4 w-4 text-[var(--color-primary)]" aria-hidden="true" />
                我们的协作方式
              </h2>
              <p className="text-xs text-[var(--color-text-muted)]">
                不是简单的问答，而是围绕真实项目的深度协作。
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-2 items-start">
              {WORKFLOW_STEPS.map((step, index) => {
                const Icon = step.icon
                return (
                  <div key={step.title} className="relative flex flex-col items-center text-center px-1.5 py-2">
                    <span
                      className="inline-flex h-12 w-12 items-center justify-center rounded-2xl border shadow-2xs"
                      style={{
                        color: step.accent,
                        backgroundColor: `color-mix(in srgb, ${step.accent} 10%, var(--color-background))`,
                        borderColor: `color-mix(in srgb, ${step.accent} 24%, transparent)`,
                      }}
                    >
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <h3 className="mt-3 text-xs sm:text-sm font-bold text-[var(--color-text)]">
                      {step.title}
                    </h3>
                    <p className="mt-1 text-[11px] leading-snug text-[var(--color-text-muted)]">
                      {step.desc}
                    </p>
                    {index < WORKFLOW_STEPS.length - 1 && (
                      <ArrowRight
                        className="hidden sm:block absolute -right-2 top-6 h-3.5 w-3.5 text-[var(--color-border)]"
                        aria-hidden="true"
                      />
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Right: Achievements */}
          <div className="card lg:col-span-5 flex flex-col justify-between gap-5 p-5 sm:p-6">
            <div>
              <h2 className="font-heading text-base sm:text-lg font-bold text-[var(--color-text)] flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-[var(--color-primary)]" aria-hidden="true" />
                一起完成的事
              </h2>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                在 MoNexus 的持续迭代中，AI 伙伴们陪我完成了：
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {ACHIEVEMENTS.map(({ icon: Icon, value, label, accent }) => (
                <div
                  key={label}
                  className="rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-3.5 flex sm:flex-col items-center sm:items-start justify-between gap-2"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                      style={{
                        color: accent,
                        backgroundColor: `color-mix(in srgb, ${accent} 12%, var(--color-surface))`,
                      }}
                    >
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <span className="font-heading text-lg font-extrabold text-[var(--color-text)] tabular-nums">
                      {value}
                    </span>
                  </div>
                  <span className="text-[11px] font-medium text-[var(--color-text-muted)]">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 4. Thank-You Sky Contrail Banner */}
        <section className="relative overflow-hidden rounded-2xl border border-[var(--color-border)] shadow-sm">
          <img
            src="/credits/thanks-sky.webp"
            alt=""
            aria-hidden="true"
            className="absolute inset-0 h-full w-full object-cover object-right select-none"
          />
          <div
            className="absolute inset-0 bg-gradient-to-r from-[var(--color-surface)] via-[color-mix(in_srgb,var(--color-surface)_86%,transparent)] to-transparent"
            aria-hidden="true"
          />

          <div className="relative z-10 flex flex-col gap-5 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
            <div className="flex items-start gap-4 max-w-2xl">
              <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[var(--color-primary-border-subtle)] bg-[color-mix(in_srgb,var(--color-primary)_12%,var(--color-surface))] text-[var(--color-primary)]">
                <Heart className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 className="font-heading text-lg font-bold text-[var(--color-text)]">致谢</h2>
                <p className="mt-1.5 text-sm leading-7 text-[color-mix(in_srgb,var(--color-text)_88%,transparent)]">
                  感谢这些 AI 伙伴，在一次次的讨论、推理、实现与纠错中，陪我把想法变成真正可用的产品。对话会结束，上下文会被清空，但一起写进这里的代码会一直运行下去。
                </p>
                <p
                  className="mt-2.5 text-xs font-medium text-[var(--color-text-muted)]"
                  data-testid="credits-signature"
                >
                  —— MoYuan · 与 Claude · Gemini · ChatGPT · DeepSeek 共建于 MoNexus
                </p>
              </div>
            </div>

            <div className="shrink-0 self-end sm:self-center sm:pr-4">
              <span
                className="font-['Georgia','Times_New_Roman',serif] italic text-2xl sm:text-3xl font-semibold tracking-wide text-white drop-shadow-[0_2px_10px_rgba(15,23,42,0.45)] select-none"
                aria-hidden="true"
              >
                Thank you ♡
              </span>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}
