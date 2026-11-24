import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import Logo from '../ui/Logo'
import {
  getLegalDocumentSummaries,
  LEGAL_PAGE_PATHS,
  type LegalDocumentSlug,
} from '../../api/legal'

export default function LayoutFooter() {
  // SPEC-LEGAL-001：法律页脚分组（门禁感知——功能关闭/接口 404 时整组隐藏，
  // 绝不渲染指向 404 的死链）。模块级缓存，全应用只请求一次。
  const [legalLinks, setLegalLinks] = useState<Array<{ slug: LegalDocumentSlug; title: string }> | null>(null)
  useEffect(() => {
    let active = true
    getLegalDocumentSummaries()
      .then((summaries) => {
        if (!active) return
        setLegalLinks(summaries ? summaries.map(({ slug, title }) => ({ slug, title })) : null)
      })
      .catch(() => {
        if (active) setLegalLinks(null)
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <footer className="w-full mt-auto border-t border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface)_65%,transparent)] backdrop-blur-md relative overflow-hidden z-10 shrink-0">
      <div className="absolute inset-0 bg-gradient-to-b from-transparent to-[color-mix(in_srgb,var(--color-primary)_4%,transparent)] pointer-events-none" />
      <div className="chrome-bound max-w-7xl mx-auto px-4 sm:px-6 relative z-10">
        {/* Upper row: Brand + Grouped navigation */}
        <div className="py-5 flex flex-col md:flex-row items-center justify-between gap-4">
          <Link
            to="/"
            className="inline-flex items-center gap-2 opacity-85 hover:opacity-100 transition-opacity"
          >
            <Logo className="w-5 h-5 text-[var(--color-primary)] shrink-0" />
            <span className="font-display text-sm font-bold text-[var(--color-text)] tracking-[0.16em]">
              MONEXUS
            </span>
          </Link>

          {legalLinks && legalLinks.length > 0 && (
            <nav
              aria-label="法律与协议"
              className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs font-medium text-[var(--color-text-muted)]"
              data-testid="footer-legal-links"
            >
              <span className="flex items-center gap-3.5">
                <span className="text-[color-mix(in_srgb,var(--color-text-muted)_55%,transparent)]">协议</span>
                {legalLinks
                  .filter((link) => ['terms', 'privacy', 'refund'].includes(link.slug))
                  .map((link) => (
                    <Link
                      key={link.slug}
                      to={LEGAL_PAGE_PATHS[link.slug]}
                      className="hover:text-[var(--color-primary)] transition-colors"
                    >
                      {link.title}
                    </Link>
                  ))}
              </span>
              <span className="hidden h-3 w-px bg-[var(--color-border)] sm:block" aria-hidden="true" />
              <span className="flex items-center gap-3.5">
                <span className="text-[color-mix(in_srgb,var(--color-text-muted)_55%,transparent)]">支持</span>
                {legalLinks
                  .filter((link) => ['points-rules', 'about'].includes(link.slug))
                  .map((link) => (
                    <Link
                      key={link.slug}
                      to={LEGAL_PAGE_PATHS[link.slug]}
                      className="hover:text-[var(--color-primary)] transition-colors"
                    >
                      {link.title}
                    </Link>
                  ))}
                <Link
                  to="/credits"
                  className="hover:text-[var(--color-primary)] transition-colors"
                  data-testid="footer-credits-link"
                >
                  群星圣殿
                </Link>
              </span>
            </nav>
          )}
        </div>

        {/* Lower row: Quiet copyright + Four-AI Sanctuary badge */}
        <div className="border-t border-[color-mix(in_srgb,var(--color-border)_68%,transparent)] py-3.5 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-[var(--color-text-muted)]">
          <div className="text-[11px] tracking-wide text-[color-mix(in_srgb,var(--color-text-muted)_86%,transparent)]">
            © {new Date().getFullYear()} MoNexus · MoYuan
          </div>

          <Link
            to="/credits"
            data-testid="footer-credits-colophon"
            className="group inline-flex items-center gap-2.5 rounded-full border border-[color-mix(in_srgb,var(--color-border)_85%,transparent)] bg-[color-mix(in_srgb,var(--color-surface)_75%,transparent)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-muted)] transition-all duration-300 hover:border-[var(--color-primary-border-subtle)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] hover:shadow-xs"
          >
            <span className="inline-flex items-center gap-1.5 opacity-80 transition-opacity duration-300 group-hover:opacity-100" aria-hidden="true">
              <img src="/credits/icons/claude-color.svg" alt="" className="h-3.5 w-3.5 object-contain" loading="lazy" />
              <img src="/credits/icons/gemini-color.svg" alt="" className="h-3.5 w-3.5 object-contain" loading="lazy" />
              <img src="/credits/icons/openai.svg" alt="" className="h-3.5 w-3.5 object-contain dark:invert" loading="lazy" />
              <img src="/credits/icons/deepseek-color.svg" alt="" className="h-3.5 w-3.5 object-contain" loading="lazy" />
            </span>
            <span className="h-3 w-px bg-[var(--color-border)]" aria-hidden="true" />
            <span className="hidden sm:inline">与 Claude · Gemini · ChatGPT · DeepSeek 共建</span>
            <span className="sm:hidden">与四位 AI 同行者共建</span>
            <ChevronRight
              className="h-3.5 w-3.5 text-[color-mix(in_srgb,var(--color-text-muted)_70%,transparent)] transition-transform duration-300 group-hover:translate-x-0.5 group-hover:text-[var(--color-primary)]"
              aria-hidden="true"
            />
          </Link>
        </div>
      </div>
    </footer>
  )
}
