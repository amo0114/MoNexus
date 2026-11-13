import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../ui/Dialog'
import { createUserBan, releaseUserBan } from '../../../api/governance'
import type { GVBan } from '../../../types/governance'
import { IntentKey, classifyGovernanceError, formatDateTime, type GovernanceFailure } from '../../../utils/governance'
import { ConflictNotice, Notice, ReasonFields, type ReasonOption } from './GovernanceKit'

const BAN_REASONS: ReasonOption[] = [
  { value: 'abuse', label: '滥用或骚扰' },
  { value: 'fraud', label: '欺诈或盗刷' },
  { value: 'incentive_abuse', label: '刷取激励' },
  { value: 'security', label: '账号安全风险' },
  { value: 'policy_violation', label: '违反平台规则' },
  { value: 'other', label: '其他' },
]

export function banReasonLabel(code: string): string {
  if (code === 'legacy_unknown') return '历史封禁'
  return BAN_REASONS.find((r) => r.value === code)?.label ?? code
}

const DURATIONS = [
  { value: '1', label: '1 天' },
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: 'permanent', label: '永久' },
] as const

type Duration = (typeof DURATIONS)[number]['value']

function expiresAtFor(duration: Duration, now = Date.now()): string | null {
  if (duration === 'permanent') return null
  return new Date(now + Number(duration) * 24 * 60 * 60 * 1000).toISOString()
}

function FailureNotice({ failure }: { failure: GovernanceFailure | null }) {
  if (!failure) return null
  if (failure.kind === 'conflict') return <ConflictNotice message={failure.message} />
  if (failure.kind === 'unconfirmed') {
    return (
      <Notice tone="warning" role="alert" title="结果未确认">
        {failure.message} 可直接再次提交，系统会识别为同一操作。
      </Notice>
    )
  }
  return <Notice tone="danger" role="alert" title={failure.kind === 'forbidden' ? '没有封禁权限' : '提交未成功'}>{failure.message}</Notice>
}

export function BanUserDialog({
  target,
  onOpenChange,
  onBanned,
}: {
  target: { id: number; email: string } | null
  onOpenChange: (open: boolean) => void
  onBanned: (ban: GVBan) => void
}) {
  const [reasonCode, setReasonCode] = useState('')
  const [reason, setReason] = useState('')
  const [duration, setDuration] = useState<Duration>('7')
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<GovernanceFailure | null>(null)
  const intentKey = useRef(new IntentKey())
  // Expiry is fixed when the intent is formed so a retry replays the same request.
  const expiresAtRef = useRef<{ duration: Duration; value: string | null } | null>(null)

  useEffect(() => {
    if (!target) return
    setReasonCode('')
    setReason('')
    setDuration('7')
    setFailure(null)
    intentKey.current.reset()
    expiresAtRef.current = null
  }, [target])

  async function submit() {
    if (!target || !reasonCode || !reason.trim() || submitting) return
    if (expiresAtRef.current?.duration !== duration) {
      expiresAtRef.current = { duration, value: expiresAtFor(duration) }
    }
    const input = { reasonCode, reason: reason.trim(), expiresAt: expiresAtRef.current.value }
    const key = intentKey.current.for({ userId: target.id, ...input })
    setSubmitting(true)
    setFailure(null)
    try {
      const ban = await createUserBan(target.id, input, key)
      intentKey.current.reset()
      onBanned(ban)
    } catch (err) {
      const f = classifyGovernanceError(err, '封禁失败')
      if (f.kind !== 'unconfirmed') intentKey.current.reset()
      setFailure(f)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={(o) => { if (!submitting) onOpenChange(o) }}>
      <DialogContent className="max-w-md" data-testid="ban-user-dialog">
        <DialogTitle>封禁账号</DialogTitle>
        <DialogDescription>
          U{target?.id} · {target?.email}。封禁会立即撤销登录会话；商家只读资格同样失效。
        </DialogDescription>
        <div className="mt-5 space-y-4">
          <FailureNotice failure={failure} />
          <div>
            <span className="mb-1.5 block text-xs font-semibold text-[var(--color-text)]">封禁时长</span>
            <div role="radiogroup" aria-label="封禁时长" className="grid grid-cols-4 gap-1.5">
              {DURATIONS.map((d) => (
                <button
                  key={d.value}
                  type="button"
                  role="radio"
                  aria-checked={duration === d.value}
                  disabled={submitting}
                  onClick={() => setDuration(d.value)}
                  className={`rounded-lg border px-2 py-2 text-xs font-semibold transition-colors cursor-pointer ${
                    duration === d.value
                      ? 'border-[var(--color-danger)] bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-background)]'
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
              {duration === 'permanent' ? '不会自动解除，需要人工解封。' : '到期后自动失效，无需人工操作；用户需重新登录。'}
            </p>
          </div>
          <ReasonFields
            options={BAN_REASONS}
            reasonCode={reasonCode}
            onReasonCodeChange={setReasonCode}
            note={reason}
            onNoteChange={setReason}
            noteLabel="封禁理由"
            notePlaceholder="写明违规事实，将记入审计"
            disabled={submitting}
          />
          <button
            type="button"
            data-testid="ban-user-submit"
            disabled={submitting || !reasonCode || !reason.trim()}
            onClick={() => void submit()}
            className="btn-primary w-full !bg-[var(--color-danger)] !shadow-none"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {submitting ? '提交中…' : '确认封禁'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ReleaseBanDialog({
  ban,
  onOpenChange,
  onReleased,
  onConflict,
}: {
  ban: GVBan | null
  onOpenChange: (open: boolean) => void
  onReleased: (ban: GVBan) => void
  /** The ban changed underneath us; caller refetches the current record. */
  onConflict: () => void
}) {
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<GovernanceFailure | null>(null)
  const intentKey = useRef(new IntentKey())

  useEffect(() => {
    if (!ban) return
    setReason('')
    setFailure(null)
    intentKey.current.reset()
  }, [ban])

  async function submit() {
    if (!ban || !reason.trim() || submitting) return
    const input = { expectedVersion: ban.version, reason: reason.trim() }
    const key = intentKey.current.for({ banId: ban.id, ...input })
    setSubmitting(true)
    setFailure(null)
    try {
      const released = await releaseUserBan(ban.userId, ban.id, input, key)
      intentKey.current.reset()
      onReleased(released)
    } catch (err) {
      const f = classifyGovernanceError(err, '解封失败')
      if (f.kind !== 'unconfirmed') intentKey.current.reset()
      setFailure(f)
      if (f.kind === 'conflict') onConflict()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={ban !== null} onOpenChange={(o) => { if (!submitting) onOpenChange(o) }}>
      <DialogContent className="max-w-md" data-testid="release-ban-dialog">
        <DialogTitle>解除封禁</DialogTitle>
        <DialogDescription>
          {ban?.expiresAt ? `原定 ${formatDateTime(ban.expiresAt)} 到期。` : '这是一条永久封禁。'}
          解封不会恢复已撤销的会话，用户需要重新登录；也不会解除支付争议限制或商家停用。
        </DialogDescription>
        <div className="mt-5 space-y-4">
          <FailureNotice failure={failure} />
          <div>
            <label htmlFor="release-ban-reason" className="mb-1.5 block text-xs font-semibold text-[var(--color-text)]">
              解封理由 <span className="text-[var(--color-danger)]">*</span>
            </label>
            <textarea
              id="release-ban-reason"
              rows={3}
              maxLength={1000}
              disabled={submitting}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="input min-h-[84px] resize-y text-sm"
              placeholder="例如：申诉核实为误判"
            />
          </div>
          <button
            type="button"
            data-testid="release-ban-submit"
            disabled={submitting || !reason.trim() || failure?.kind === 'conflict'}
            onClick={() => void submit()}
            className="btn-primary w-full"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {submitting ? '提交中…' : '确认解封'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
