import { CheckCircle2, Loader2, ShieldAlert } from 'lucide-react'
import { getReadinessIssueMessage } from '../../api/catalog'
import type { ReadinessIssue } from '../../types/catalog'

interface Props {
  issues: ReadinessIssue[]
  /** Defaults to `issues.length === 0` when omitted. */
  ready?: boolean
  /** When provided, renders a publish CTA gated on `ready`. */
  onPublish?: () => void
  publishing?: boolean
  disabled?: boolean
}

/**
 * Publication readiness checklist (T-CAT-FE-001A primitive, spec §6.1).
 *
 * Renders stable readiness codes as human messages; the machine code stays
 * available via `data-code` for tests/tooling and is never parsed from prose.
 * Unknown codes render a safe generic message. The publish CTA is keyboard
 * operable and disabled until every issue is resolved.
 */
export default function ProductPublicationChecklist({
  issues,
  ready = issues.length === 0,
  onPublish,
  publishing = false,
  disabled = false,
}: Props) {
  return (
    <section
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      data-testid="publication-checklist"
      aria-label="发布检查清单"
    >
      <h3 className="flex items-center gap-2 font-heading text-sm font-bold text-[var(--color-text)] mb-3">
        <ShieldAlert className="w-4 h-4 text-[var(--color-text-muted)]" />
        发布检查清单
      </h3>

      {ready ? (
        <div
          className="flex items-center gap-2 rounded-lg border border-[var(--color-cta)]/25 bg-[var(--color-cta)]/8 px-3 py-2 text-sm text-[var(--color-text)]"
          data-testid="publication-ready"
        >
          <CheckCircle2 className="w-4 h-4 text-[var(--color-cta)]" />
          已满足发布条件
        </div>
      ) : (
        <ul className="space-y-2" data-testid="publication-issues">
          {issues.length === 0 ? (
            <li className="text-sm text-[var(--color-text-muted)]" data-testid="readiness-issue" data-code="">
              发布条件尚未全部满足
            </li>
          ) : (
            issues.map((issue, index) => (
              <li
                key={`${issue.code}-${issue.field}-${issue.offerId ?? 'x'}-${index}`}
                className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-sm text-[var(--color-text)]"
                data-testid="readiness-issue"
                data-code={issue.code}
              >
                <span className="sr-only">稳定码：{issue.code}</span>
                <span className="flex-1">
                  {getReadinessIssueMessage(issue.code)}
                  {issue.offerId != null ? `（规格 ${issue.offerId}）` : ''}
                </span>
                <span className="font-mono text-[10px] text-[var(--color-text-muted)] uppercase" aria-hidden="true">
                  {issue.code}
                </span>
              </li>
            ))
          )}
        </ul>
      )}

      {onPublish && (
        <button
          type="button"
          className="btn-cta w-full justify-center px-6 py-2.5 mt-4"
          onClick={onPublish}
          disabled={disabled || publishing || !ready}
          data-testid="publication-publish"
        >
          {publishing && <Loader2 className="w-4 h-4 animate-spin" />}
          {publishing ? '发布中…' : '发布商品'}
        </button>
      )}
    </section>
  )
}
