import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import {
  getLegalDocument,
  LEGAL_DOCUMENT_TITLES,
  LEGAL_PAGE_PATHS,
  type LegalDocument,
  type LegalDocumentSlug,
} from '../../api/legal'
import Logo from '../../components/ui/Logo'

/**
 * SPEC-LEGAL-001：公开法律文档页（未登录可达——注册/下单勾选链接的落地页）。
 * 独立于主 Layout：不带导航与页脚，自带极简壳，五个路由共用这一份实现。
 */

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; document: LegalDocument }
  | { kind: 'error' }

export default function LegalDocumentPage({ slug }: { slug: LegalDocumentSlug }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })

  useEffect(() => {
    let active = true
    setState({ kind: 'loading' })
    getLegalDocument(slug)
      .then((document) => {
        if (active) setState({ kind: 'ready', document })
      })
      .catch(() => {
        if (active) setState({ kind: 'error' })
      })
    return () => {
      active = false
    }
  }, [slug])

  const title = state.kind === 'ready' ? state.document.title : '协议'

  useEffect(() => {
    document.title = `${title} - MoNexus`
    return () => {
      document.title = 'MoNexus'
    }
  }, [title])

  return (
    <div className="min-h-screen bg-[var(--color-background)] px-4 py-8 fade-in" data-testid="legal-page">
      <div className="pointer-events-none fixed left-[-10%] top-[-20%] h-[600px] w-[600px] rounded-full bg-[var(--color-primary)]/10 blur-[120px]" />
      <div className="pointer-events-none fixed inset-0 bg-grid-pattern opacity-40" />

      <div className="relative z-10 mx-auto w-full max-w-3xl">
        <header className="mb-6 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 text-[var(--color-text)]">
            <Logo className="h-8 w-8 shrink-0" />
            <span className="font-heading text-lg font-bold tracking-[0.18em]">MONEXUS</span>
          </Link>
          <Link
            to="/"
            className="inline-flex min-h-[40px] items-center gap-1.5 text-sm text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-primary)]"
          >
            <ArrowLeft className="h-4 w-4" />返回商城
          </Link>
        </header>

        <main className="card relative overflow-hidden p-6 text-left backdrop-blur-xl sm:p-10">
          {state.kind === 'loading' && (
            <p className="py-16 text-center text-sm text-[var(--color-text-muted)]" role="status">正在加载…</p>
          )}

          {state.kind === 'error' && (
            <div className="py-16 text-center" data-testid="legal-page-error">
              <p className="text-sm text-[var(--color-text-muted)]">页面不存在或暂不可用</p>
              <Link to="/" className="mt-4 inline-block text-sm text-[var(--color-primary)] hover:underline">
                返回商城
              </Link>
            </div>
          )}

          {state.kind === 'ready' && (
            <article>
              <h1
                className="font-heading text-2xl font-semibold text-[var(--color-text)] sm:text-3xl"
                data-testid="legal-document-title"
              >
                {state.document.title}
              </h1>
              <p className="mt-2 text-xs text-[var(--color-text-muted)]" data-testid="legal-document-meta">
                版本 {state.document.version} · 更新日期 {state.document.updatedAt}
              </p>

              <div className="mt-8 space-y-8">
                {state.document.sections.map((section, index) => (
                  <section key={index}>
                    {section.heading && (
                      <h2 className="mb-3 text-base font-semibold text-[var(--color-text)]">{section.heading}</h2>
                    )}
                    <div className="space-y-3">
                      {section.paragraphs.map((paragraph, paragraphIndex) => (
                        <p key={paragraphIndex} className="text-sm leading-7 text-[var(--color-text-muted)]">
                          {paragraph}
                        </p>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </article>
          )}
        </main>

        <footer className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-[var(--color-text-muted)]">
          {(Object.keys(LEGAL_PAGE_PATHS) as LegalDocumentSlug[])
            .filter((key) => key !== slug)
            .map((key) => (
              <Link key={key} to={LEGAL_PAGE_PATHS[key]} className="transition-colors hover:text-[var(--color-primary)]">
                {LEGAL_DOCUMENT_TITLES[key]}
              </Link>
            ))}
        </footer>
      </div>
    </div>
  )
}
