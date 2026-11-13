import { useId, type ReactNode } from 'react'
import { AlertTriangle, Ban, Info, Loader2, Lock, RefreshCw, ShieldOff } from 'lucide-react'
import type { GVBlocker } from '../../../types/governance'
import type { StatusLabel, Tone } from '../../../utils/governance'

// Shared building blocks for governance-v1 screens. Kept in one module so every
// review surface expresses blockers, conflicts and unknowns the same way.

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-[color-mix(in_srgb,var(--color-text-muted)_12%,transparent)] text-[var(--color-text-muted)] border-[color-mix(in_srgb,var(--color-text-muted)_22%,transparent)]',
  info: 'bg-[color-mix(in_srgb,var(--color-info)_10%,transparent)] text-[var(--color-info)] border-[color-mix(in_srgb,var(--color-info)_25%,transparent)]',
  success: 'bg-[var(--color-success-bg)] text-[var(--color-success-text)] border-[var(--color-success-border)]',
  warning: 'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] border-[var(--color-warning-border)]',
  danger: 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)] border-[var(--color-danger-border)]',
  primary: 'bg-[var(--color-primary-tint)] text-[var(--color-primary)] border-[var(--color-primary-border-subtle)]',
}

export function StatusChip({ status, testId }: { status: StatusLabel; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASS[status.tone]}`}
    >
      {status.label}
    </span>
  )
}

type NoticeTone = 'info' | 'warning' | 'danger'

const NOTICE_CLASS: Record<NoticeTone, string> = {
  info: 'border-[color-mix(in_srgb,var(--color-info)_28%,transparent)] bg-[color-mix(in_srgb,var(--color-info)_7%,transparent)]',
  warning: 'border-[var(--color-warning-border)] bg-[var(--color-warning-bg)]',
  danger: 'border-[var(--color-danger-border)] bg-[var(--color-danger-bg)]',
}

const NOTICE_ICON: Record<NoticeTone, typeof Info> = { info: Info, warning: AlertTriangle, danger: ShieldOff }

export function Notice({
  tone = 'info',
  title,
  children,
  action,
  testId,
  role,
}: {
  tone?: NoticeTone
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
  testId?: string
  role?: 'alert' | 'status'
}) {
  const Icon = NOTICE_ICON[tone]
  return (
    <div data-testid={testId} role={role} className={`flex gap-3 rounded-xl border p-3.5 ${NOTICE_CLASS[tone]}`}>
      <Icon
        aria-hidden="true"
        className={`mt-0.5 h-4 w-4 shrink-0 ${tone === 'danger' ? 'text-[var(--color-danger)]' : tone === 'warning' ? 'text-[var(--color-warning)]' : 'text-[var(--color-info)]'}`}
      />
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-semibold text-[var(--color-text)]">{title}</div>
        {children && <div className="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  )
}

/** The governance-v1 backend is absent: say so instead of guessing permissions. */
export function UnavailableNotice({ feature }: { feature: string }) {
  return (
    <Notice tone="info" title={`${feature}暂未提供`} testId="governance-unavailable">
      当前后端尚未开放该能力。原有功能不受影响；升级后端后这里会自动出现。
    </Notice>
  )
}

export function ForbiddenNotice({ what = '此内容' }: { what?: string }) {
  return (
    <div
      data-testid="governance-forbidden"
      className="flex items-center gap-2.5 rounded-xl border border-dashed border-[var(--color-border)] px-4 py-6 text-sm text-[var(--color-text-muted)]"
    >
      <Lock aria-hidden="true" className="h-4 w-4 shrink-0" />
      <span>你没有查看{what}的权限。如需访问，请联系超级管理员授权。</span>
    </div>
  )
}

export function BlockerList({ blockers }: { blockers: GVBlocker[] }) {
  if (blockers.length === 0) return null
  return (
    <ul data-testid="governance-blockers" className="space-y-2">
      {blockers.map((b) => (
        <li
          key={b.code}
          data-code={b.code}
          className="flex items-start gap-2.5 rounded-lg border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-3 py-2.5"
        >
          <Ban aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-warning)]" />
          <div className="min-w-0 text-xs">
            <div className="font-semibold text-[var(--color-warning-text)]">{b.message}</div>
            <code className="mt-0.5 block text-[10px] text-[var(--color-text-muted)]">{b.code}</code>
          </div>
        </li>
      ))}
    </ul>
  )
}

/** 409 banner: the operator must re-read current facts and decide again. */
export function ConflictNotice({ message, onReload }: { message: string; onReload?: () => void }) {
  return (
    <Notice
      tone="warning"
      role="alert"
      testId="governance-conflict"
      title="状态已变化，原决定未提交"
      action={onReload && (
        <button type="button" onClick={onReload} className="btn-tonal">
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          重新读取
        </button>
      )}
    >
      {message} 已为你载入最新事实，请核对后重新选择。
    </Notice>
  )
}

export function Section({
  title,
  aside,
  children,
  testId,
}: {
  title: ReactNode
  aside?: ReactNode
  children: ReactNode
  testId?: string
}) {
  return (
    <section data-testid={testId} className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** Label/value grid used by every detail overview. */
export function FactGrid({ items }: { items: Array<{ label: string; value: ReactNode; hint?: string }> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-[11px] font-medium text-[var(--color-text-muted)]">{item.label}</dt>
          <dd className="mt-0.5 truncate text-sm font-semibold text-[var(--color-text)]" title={item.hint}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export interface TimelineEntry {
  id: string
  title: ReactNode
  status?: StatusLabel
  at: string
  body?: ReactNode
  meta?: ReactNode
}

export function Timeline({ entries, empty }: { entries: TimelineEntry[]; empty: string }) {
  if (entries.length === 0) {
    return <p className="text-xs text-[var(--color-text-muted)]">{empty}</p>
  }
  return (
    <ol data-testid="governance-timeline" className="relative space-y-4 border-l border-[var(--color-border)] pl-5">
      {entries.map((e) => (
        <li key={e.id} className="relative">
          <span
            aria-hidden="true"
            className="absolute -left-[1.6rem] top-1 h-2.5 w-2.5 rounded-full border-2 border-[var(--color-surface)] bg-[var(--color-primary)]"
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-[var(--color-text)]">{e.title}</span>
            {e.status && <StatusChip status={e.status} />}
            <time className="text-[11px] text-[var(--color-text-muted)]">{e.at}</time>
          </div>
          {e.body && <div className="mt-1 text-xs leading-relaxed text-[var(--color-text)]">{e.body}</div>}
          {e.meta && <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">{e.meta}</div>}
        </li>
      ))}
    </ol>
  )
}

export function LoadMore({
  hasNextPage,
  loadingMore,
  onLoadMore,
}: {
  hasNextPage: boolean
  loadingMore: boolean
  onLoadMore: () => void
}) {
  if (!hasNextPage) return null
  return (
    <div className="flex justify-center pt-1">
      <button type="button" className="btn-tonal" disabled={loadingMore} onClick={onLoadMore} data-testid="governance-load-more">
        {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
        {loadingMore ? '加载中…' : '加载更多'}
      </button>
    </div>
  )
}

export interface ReasonOption {
  value: string
  label: string
}

/**
 * Structured reason input: a stable reasonCode for reporting plus a free-text
 * note for the audit trail. Both are required by every governance command.
 */
export function ReasonFields({
  options,
  reasonCode,
  onReasonCodeChange,
  note,
  onNoteChange,
  noteLabel = '处理说明',
  notePlaceholder = '写明依据与核对过程，将记入审计',
  disabled,
  maxLength = 1000,
}: {
  options: ReasonOption[]
  reasonCode: string
  onReasonCodeChange: (value: string) => void
  note: string
  onNoteChange: (value: string) => void
  noteLabel?: string
  notePlaceholder?: string
  disabled?: boolean
  maxLength?: number
}) {
  const id = useId()
  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={`${id}-code`} className="mb-1.5 block text-xs font-semibold text-[var(--color-text)]">
          原因类型 <span className="text-[var(--color-danger)]">*</span>
        </label>
        <select
          id={`${id}-code`}
          className="input py-2 text-sm"
          value={reasonCode}
          disabled={disabled}
          onChange={(e) => onReasonCodeChange(e.target.value)}
        >
          <option value="">请选择</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${id}-note`} className="mb-1.5 block text-xs font-semibold text-[var(--color-text)]">
          {noteLabel} <span className="text-[var(--color-danger)]">*</span>
        </label>
        <textarea
          id={`${id}-note`}
          rows={3}
          maxLength={maxLength}
          disabled={disabled}
          value={note}
          placeholder={notePlaceholder}
          onChange={(e) => onNoteChange(e.target.value)}
          className="input min-h-[84px] resize-y text-sm"
        />
        <div className="mt-1 text-right text-[10px] text-[var(--color-text-muted)]">{note.trim().length}/{maxLength}</div>
      </div>
    </div>
  )
}
