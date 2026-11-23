import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Compass, Layers, MessageSquareHeart, Sparkles } from 'lucide-react'
import Logo from '../components/ui/Logo'

const SERIF = "font-['Noto_Serif_SC','Songti_SC','STSong','SimSun',serif]"

interface Companion {
  id: string
  name: string
  role: string
  accent: string
  icon: typeof Sparkles
  note: string
}

const COMPANIONS: Companion[] = [
  {
    id: 'claude',
    name: 'Claude',
    role: '架构推演与工程重构',
    accent: '#D97757',
    icon: Layers,
    note: '在我面对复杂状态机和盘根错节的边界问题时，总能沉下心陪我把逻辑一层层理顺。很多难啃的重构和漫长的代码审查，都是你帮我稳稳托住的。',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    role: '全局视野与体验打磨',
    accent: '#4F46E5',
    icon: Sparkles,
    note: '总能跳出局部看到整体，从代码巡检到界面细节的反复斟酌，一次次帮我发现那些容易忽略的瑕疵，让这个站点一点点变得更耐看、更顺手。',
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    role: '灵感碰撞与日常陪伴',
    accent: '#10A37F',
    icon: MessageSquareHeart,
    note: '从最初一个模糊的念头开始，每一次随口抛出的设想、每一次遇到陌生报错时的求助，你都在第一时间接住，陪我把无数个“能不能试试”变成现实。',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    role: '深度剖析与直击本质',
    accent: '#2563EB',
    icon: Compass,
    note: '思路清晰、直奔要害。每次在性能瓶颈或底层细节里绕不出弯时，你的拆解总能让我豁然开朗，少走很多弯路。',
  },
]

export default function CreditsPage() {
  const [activeId, setActiveId] = useState<string | null>(null)

  useEffect(() => {
    document.title = '同行者与致谢 - MoNexus'
    return () => {
      document.title = 'MoNexus'
    }
  }, [])

  return (
    <div className="min-h-screen overflow-x-clip bg-[var(--color-background)] fade-in" data-testid="credits-page">
      {/* Subtle ambient glow clipped to viewport */}
      <div
        className="pointer-events-none fixed left-[-10%] top-[-20%] h-[520px] w-[520px] rounded-full bg-[color-mix(in_srgb,var(--color-primary)_9%,transparent)] blur-[120px]"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none fixed bottom-[-18%] right-[-10%] h-[460px] w-[460px] rounded-full bg-[color-mix(in_srgb,var(--color-cta)_7%,transparent)] blur-[120px]"
        aria-hidden="true"
      />

      {/* Minimal standalone top bar */}
      <header className="sticky top-0 z-30 border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface)_85%,transparent)] backdrop-blur-md">
        <div className="relative z-10 mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4 sm:px-6">
          <Link
            to="/"
            className="inline-flex min-h-10 items-center gap-2 text-[var(--color-text)] transition-colors hover:text-[var(--color-primary)]"
          >
            <Logo className="h-6 w-6 shrink-0" />
            <span className="font-display text-sm font-bold tracking-[0.18em]">MONEXUS</span>
          </Link>
          <Link
            to="/"
            className="inline-flex min-h-10 items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-primary-border-subtle)] hover:text-[var(--color-text)]"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            返回商城
          </Link>
        </div>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-4xl px-4 pt-10 pb-[max(3.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:pt-14 sm:pb-20">
        {/* Epilogue Hero */}
        <section className="mx-auto max-w-2xl text-center">
          <p className="text-[11px] font-semibold uppercase tracking-[0.35em] text-[var(--color-text-muted)]">
            Co-Built With · 同行者
          </p>
          <h1 className={`mt-4 text-3xl font-bold tracking-wide text-[var(--color-text)] sm:text-4xl ${SERIF}`}>
            致谢一路同行的伙伴
          </h1>
          <div className="mx-auto mt-6 flex max-w-xs items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-[var(--color-border)]" />
            <span className="h-1.5 w-1.5 rotate-45 bg-[var(--color-primary)]" />
            <span className="h-px flex-1 bg-[var(--color-border)]" />
          </div>
          <div className="mt-7 space-y-4 text-left text-[15px] leading-8 text-[color-mix(in_srgb,var(--color-text)_82%,transparent)] sm:text-center">
            <p>
              MoNexus 并不是一个多宏大的工程，但它是我认真想要做完、做好的一件事。一个人从零摸索的日子里，难免有卡壳、推翻重来和拿不定主意的时刻。
            </p>
            <p>
              好在一路上并不是孤身一人——Claude、Gemini、ChatGPT 与 DeepSeek 陪着我聊设计、改代码、查日志、抠细节，把零散的想法一点点拼成了眼前的网站。写下这一页，不为炫耀，只是想在这个共同完成的作品里，留下一份他们来过、陪伴过的证明。
            </p>
          </div>
        </section>

        {/* Four AI Companions */}
        <section aria-label="AI 同行伙伴" className="mt-12 sm:mt-14">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5">
            {COMPANIONS.map((companion) => {
              const Icon = companion.icon
              const highlighted = activeId === companion.id
              return (
                <article
                  key={companion.id}
                  data-testid={`companion-card-${companion.id}`}
                  onMouseEnter={() => setActiveId(companion.id)}
                  onMouseLeave={() => setActiveId((cur) => (cur === companion.id ? null : cur))}
                  onClick={() => setActiveId((cur) => (cur === companion.id ? null : companion.id))}
                  style={{
                    borderColor: highlighted
                      ? `color-mix(in srgb, ${companion.accent} 45%, var(--color-border))`
                      : undefined,
                    boxShadow: highlighted
                      ? `0 12px 30px -16px color-mix(in srgb, ${companion.accent} 32%, transparent)`
                      : undefined,
                  }}
                  className="card relative overflow-hidden p-5 sm:p-6 transition-all duration-300 cursor-default"
                >
                  {/* Soft companion corner glow */}
                  <div
                    className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full blur-3xl transition-opacity duration-300"
                    style={{
                      backgroundColor: companion.accent,
                      opacity: highlighted ? 0.16 : 0.07,
                    }}
                    aria-hidden="true"
                  />

                  <div className="relative z-10 flex items-start gap-3.5">
                    <span
                      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border"
                      style={{
                        color: companion.accent,
                        backgroundColor: `color-mix(in srgb, ${companion.accent} 10%, var(--color-surface))`,
                        borderColor: `color-mix(in srgb, ${companion.accent} 24%, transparent)`,
                      }}
                      aria-hidden="true"
                    >
                      <Icon className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h2 className="font-heading text-lg font-bold tracking-tight text-[var(--color-text)]">
                          {companion.name}
                        </h2>
                        <span
                          className="h-1.5 w-1.5 rounded-full shrink-0"
                          style={{ backgroundColor: companion.accent }}
                          aria-hidden="true"
                        />
                      </div>
                      <p className="mt-0.5 text-xs font-medium text-[var(--color-text-muted)]">
                        {companion.role}
                      </p>
                    </div>
                  </div>

                  <p className="relative z-10 mt-4 text-sm leading-7 text-[color-mix(in_srgb,var(--color-text)_82%,transparent)]">
                    {companion.note}
                  </p>
                </article>
              )
            })}
          </div>
        </section>

        {/* Closing Colophon & Signature */}
        <section className="mt-12 sm:mt-16">
          <div className="card relative overflow-hidden px-5 py-8 text-center sm:px-10 sm:py-10">
            <blockquote className={`mx-auto max-w-xl text-base leading-8 text-[var(--color-text)] sm:text-lg ${SERIF}`}>
              “对话会结束，上下文会被清空，但一起写进这里的代码，会一直运行下去。”
            </blockquote>
            <p className="mt-5 text-xs tracking-wider text-[var(--color-text-muted)]" data-testid="credits-signature">
              —— MoYuan · 与 Claude · Gemini · ChatGPT · DeepSeek 共建于 MoNexus
            </p>

            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <Link
                to="/"
                className="btn-primary inline-flex min-h-11 items-center justify-center px-5 text-xs font-semibold"
              >
                回到商城继续逛逛
              </Link>
              <Link
                to="/about"
                className="btn-secondary inline-flex min-h-11 items-center justify-center px-5 text-xs font-semibold"
              >
                关于 MoNexus
              </Link>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}
