import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, FileText, Fingerprint, ListTree } from 'lucide-react'
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
 *
 * 版式定位「法律文书中心」：桌面端为 侧栏（文档导航 + 本页目录 + 文档信息）
 * + 正文「文书纸面」的双栏布局，消除大片留白；移动端折叠为横向文档切换
 * 条 + 单栏文书。正文用宋体系衬线字体与首行缩进营造正式文书感；内容哈希
 * 在「文档信息」与文末落款展示，直观呈现版本证据锚定。
 */

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; document: LegalDocument }
  | { kind: 'error' }

const SERIF = "font-['Noto_Serif_SC','Songti_SC','STSong','SimSun',serif]"

const ALL_SLUGS = Object.keys(LEGAL_PAGE_PATHS) as LegalDocumentSlug[]

function scrollToSection(index: number) {
  document.getElementById(`legal-section-${index}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

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

  const title = state.kind === 'ready' ? state.document.title : LEGAL_DOCUMENT_TITLES[slug]

  useEffect(() => {
    document.title = `${title} - MoNexus`
    return () => {
      document.title = 'MoNexus'
    }
  }, [title])

  const readyDocument = state.kind === 'ready' ? state.document : null
  const tocSections = readyDocument?.sections.filter((section) => section.heading) ?? []

  return (
    <div className="min-h-screen overflow-x-clip bg-[var(--color-background)] fade-in" data-testid="legal-page">
      {/* overflow-x-clip（不产生滚动容器，兼容 sticky 顶栏）：装饰光斑在窄屏
          会超出视口右缘，裁剪掉而不是造成页面级横向滚动。 */}
      <div className="pointer-events-none fixed left-[-10%] top-[-20%] h-[600px] w-[600px] rounded-full bg-[var(--color-primary)]/10 blur-[120px]" />
      <div className="pointer-events-none fixed inset-0 bg-grid-pattern opacity-40" />

      {/* 顶部栏：品牌 + 返回 */}
      <header className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-background)]/85 backdrop-blur-md">
        <div className="relative z-10 mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2 text-[var(--color-text)]">
            <Logo className="h-7 w-7 shrink-0" />
            <span className="font-heading text-base font-bold tracking-[0.18em]">MONEXUS</span>
            <span className="hidden text-xs tracking-[0.3em] text-[var(--color-text-muted)] sm:inline">法律文档中心</span>
          </Link>
          <Link
            to="/"
            className="inline-flex min-h-[40px] items-center gap-1.5 text-sm text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-primary)]"
          >
            <ArrowLeft className="h-4 w-4" />返回商城
          </Link>
        </div>
      </header>

      {/* 移动端文档切换条（桌面端由侧栏导航承担） */}
      <nav
        aria-label="法律文档"
        className="relative z-10 mx-auto mt-4 flex w-full max-w-6xl gap-2 overflow-x-auto px-4 pb-1 sm:px-6 md:hidden"
      >
        {ALL_SLUGS.map((key) => (
          <Link
            key={key}
            to={LEGAL_PAGE_PATHS[key]}
            aria-current={key === slug ? 'page' : undefined}
            className={`shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${
              key === slug
                ? 'border-[var(--color-primary)]/60 bg-[var(--color-primary)]/10 text-[var(--color-primary)]'
                : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
            }`}
          >
            {LEGAL_DOCUMENT_TITLES[key]}
          </Link>
        ))}
      </nav>

      <div className="relative z-10 mx-auto w-full max-w-6xl gap-8 px-4 py-6 sm:px-6 md:grid md:grid-cols-[250px_minmax(0,1fr)] md:py-10">
        {/* 侧栏（桌面端）：文档导航 + 本页目录 + 文档信息 */}
        <aside className="hidden md:block">
          <div className="sticky top-20 space-y-5 self-start">
            <nav aria-label="法律文档" className="card overflow-hidden p-2">
              <p className="flex items-center gap-1.5 px-3 pb-2 pt-2 text-[11px] font-semibold uppercase tracking-[0.25em] text-[var(--color-text-muted)]">
                <FileText className="h-3.5 w-3.5" />法律文档
              </p>
              {ALL_SLUGS.map((key) => (
                <Link
                  key={key}
                  to={LEGAL_PAGE_PATHS[key]}
                  aria-current={key === slug ? 'page' : undefined}
                  className={`relative block rounded-md px-3 py-2.5 pl-4 text-sm transition-colors ${
                    key === slug
                      ? 'bg-[var(--color-primary)]/10 font-semibold text-[var(--color-primary)]'
                      : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]'
                  }`}
                >
                  {key === slug && (
                    <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-[var(--color-primary)]" aria-hidden="true" />
                  )}
                  {LEGAL_DOCUMENT_TITLES[key]}
                </Link>
              ))}
            </nav>

            {readyDocument && tocSections.length > 0 && (
              <div className="card overflow-hidden p-2" data-testid="legal-toc">
                <p className="flex items-center gap-1.5 px-3 pb-2 pt-2 text-[11px] font-semibold uppercase tracking-[0.25em] text-[var(--color-text-muted)]">
                  <ListTree className="h-3.5 w-3.5" />本页目录
                </p>
                {readyDocument.sections.map((section, index) =>
                  section.heading ? (
                    <button
                      key={index}
                      type="button"
                      onClick={() => scrollToSection(index)}
                      className="block w-full cursor-pointer truncate rounded-md px-3 py-2 text-left text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
                    >
                      {section.heading}
                    </button>
                  ) : null,
                )}
              </div>
            )}

            {readyDocument && (
              <div className="card p-4" data-testid="legal-document-info">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.25em] text-[var(--color-text-muted)]">
                  <Fingerprint className="h-3.5 w-3.5" />文档信息
                </p>
                <dl className="mt-3 space-y-2 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt className="text-[var(--color-text-muted)]">版本</dt>
                    <dd className="font-semibold text-[var(--color-text)]">{readyDocument.version}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-[var(--color-text-muted)]">更新日期</dt>
                    <dd className="text-[var(--color-text)]">{readyDocument.updatedAt}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--color-text-muted)]">内容哈希（SHA-256）</dt>
                    <dd className="mt-1 break-all font-mono text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                      {readyDocument.contentHash}
                    </dd>
                  </div>
                </dl>
              </div>
            )}
          </div>
        </aside>

        {/* 正文「文书纸面」 */}
        <main className="min-w-0">
          {state.kind === 'loading' && (
            <div className="card p-10 sm:p-16">
              <p className="py-20 text-center text-sm text-[var(--color-text-muted)]" role="status">正在加载…</p>
            </div>
          )}

          {state.kind === 'error' && (
            <div className="card p-10 sm:p-16">
              <div className="py-20 text-center" data-testid="legal-page-error">
                <p className="text-sm text-[var(--color-text-muted)]">页面不存在或暂不可用</p>
                <Link to="/" className="mt-4 inline-block text-sm text-[var(--color-primary)] hover:underline">
                  返回商城
                </Link>
              </div>
            </div>
          )}

          {readyDocument && (
            <article className="card relative overflow-hidden px-5 py-8 sm:px-10 sm:py-12 lg:px-14">
              {/* 文书头：居中题名 + 元信息 + 双细律分隔线 */}
              <header className="text-center">
                <p className="text-[11px] font-semibold uppercase tracking-[0.4em] text-[var(--color-text-muted)]">
                  MoNexus 平台文书
                </p>
                <h1
                  className={`mt-4 text-3xl font-bold tracking-wide text-[var(--color-text)] sm:text-4xl ${SERIF}`}
                  data-testid="legal-document-title"
                >
                  {readyDocument.title}
                </h1>
                <p
                  className="mt-4 text-xs tracking-wider text-[var(--color-text-muted)]"
                  data-testid="legal-document-meta"
                >
                  版本 {readyDocument.version} · 更新日期 {readyDocument.updatedAt} · 发布即日生效
                </p>
                <div className="mx-auto mt-6 flex items-center gap-3" aria-hidden="true">
                  <span className="h-px flex-1 bg-[var(--color-border)]" />
                  <span className="h-1.5 w-1.5 rotate-45 bg-[var(--color-primary)]" />
                  <span className="h-px flex-1 bg-[var(--color-border)]" />
                </div>
              </header>

              {/* 章节：衬线题名 + 首行缩进正文，正式文书排版 */}
              <div className="mt-10 space-y-10">
                {readyDocument.sections.map((section, index) => (
                  <section key={index} id={`legal-section-${index}`} className="scroll-mt-24">
                    {section.heading && (
                      <h2 className={`mb-4 text-lg font-semibold text-[var(--color-text)] ${SERIF}`}>
                        {section.heading}
                      </h2>
                    )}
                    <div className="space-y-3.5">
                      {section.paragraphs.map((paragraph, paragraphIndex) => (
                        <p
                          key={paragraphIndex}
                          className="text-justify text-[15px] leading-8 text-[var(--color-text)]/85 [text-indent:2em]"
                        >
                          {paragraph}
                        </p>
                      ))}
                    </div>
                  </section>
                ))}
              </div>

              {/* 文书尾：落款 + 证据哈希（移动端在此展示，桌面端侧栏亦有） */}
              <footer className="mt-14 border-t border-[var(--color-border)] pt-6 text-center">
                <p className="text-xs text-[var(--color-text-muted)]">
                  本文档由 MoNexus 平台发布，版本化留存并可凭内容哈希校验完整性。
                </p>
                <p className="mt-2 break-all font-mono text-[10px] leading-relaxed text-[var(--color-text-muted)]/70 md:hidden">
                  SHA-256 {readyDocument.contentHash}
                </p>
              </footer>
            </article>
          )}
        </main>
      </div>
    </div>
  )
}
