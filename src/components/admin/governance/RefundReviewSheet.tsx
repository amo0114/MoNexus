import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, RefreshCw } from 'lucide-react'
import SideSheet from '../../ui/SideSheet'
import { getRefundReview, submitRefundReview } from '../../../api/governance'
import type { GVRefundDetail, GVRefundReviewAction } from '../../../types/governance'
import { compareMinor, formatCurrencyAmount, formatPoints } from '../../../pages/recharge/money'
import {
  IntentKey,
  classifyGovernanceError,
  formatDateTime,
  refundStatusLabel,
  type GovernanceFailure,
} from '../../../utils/governance'
import {
  BlockerList,
  ConflictNotice,
  FactGrid,
  ForbiddenNotice,
  Notice,
  ReasonFields,
  Section,
  StatusChip,
  Timeline,
  type ReasonOption,
} from './GovernanceKit'

const REASONS: Record<GVRefundReviewAction, ReasonOption[]> = {
  resume: [
    { value: 'source_restored', label: '原充值来源已恢复' },
    { value: 'verified_manually', label: '人工核对可继续退款' },
  ],
  reject: [
    { value: 'source_insufficient', label: '原充值来源不足' },
    { value: 'legacy_unproven', label: '历史来源无法证明' },
    { value: 'policy_denied', label: '不符合退款政策' },
    { value: 'other', label: '其他' },
  ],
}

const ACTION_COPY: Record<GVRefundReviewAction, { label: string; hint: string }> = {
  resume: { label: '恢复退款', hint: '冻结原充值积分并交由渠道执行退款，金额由系统按原单确定。' },
  reject: { label: '拒绝退款', hint: '只记录决定，不发起外部退款，也不变动积分。' },
}

interface Props {
  refundId: string | null
  canReview: boolean
  onOpenChange: (open: boolean) => void
  /** Called after any committed decision so the list can refresh. */
  onDecided?: () => void
}

type Outcome = { kind: 'decided'; detail: GVRefundDetail; replayed: boolean; action: GVRefundReviewAction }

export default function RefundReviewSheet({ refundId, canReview, onOpenChange, onDecided }: Props) {
  const [detail, setDetail] = useState<GVRefundDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)

  const [action, setAction] = useState<GVRefundReviewAction | null>(null)
  const [reasonCode, setReasonCode] = useState('')
  const [note, setNote] = useState('')
  const [evidenceRef, setEvidenceRef] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<GovernanceFailure | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  const intentKey = useRef(new IntentKey())
  const controllerRef = useRef<AbortController | null>(null)

  const resetForm = () => {
    setAction(null)
    setReasonCode('')
    setNote('')
    setEvidenceRef('')
  }

  const load = useCallback(async (id: string) => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setLoading(true)
    setLoadError(null)
    try {
      const next = await getRefundReview(id, controller.signal)
      if (controller.signal.aborted) return
      setDetail(next)
      setForbidden(false)
    } catch (err) {
      if (controller.signal.aborted) return
      const f = classifyGovernanceError(err, '加载退款详情失败')
      if (f.kind === 'forbidden') setForbidden(true)
      else setLoadError(f.message)
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    setDetail(null)
    setFailure(null)
    setOutcome(null)
    setForbidden(false)
    resetForm()
    intentKey.current.reset()
    if (refundId) void load(refundId)
    return () => controllerRef.current?.abort()
  }, [refundId, load])

  const allowed = detail?.allowedActions ?? []
  const noteValid = note.trim().length > 0
  const canSubmit = Boolean(detail && action && allowed.includes(action) && reasonCode && noteValid && !submitting)

  async function submit() {
    if (!detail || !action || !canSubmit) return
    const input = {
      action,
      expectedReviewVersion: detail.reviewVersion,
      reasonCode,
      note: note.trim(),
      evidenceRef: action === 'resume' && evidenceRef.trim() ? evidenceRef.trim() : null,
    }
    const key = intentKey.current.for({ refundId: detail.id, ...input })
    setSubmitting(true)
    setFailure(null)
    try {
      const result = await submitRefundReview(detail.id, input, key)
      intentKey.current.reset()
      setDetail(result.refund)
      setOutcome({ kind: 'decided', detail: result.refund, replayed: result.replayed, action: result.reviewAction.kind })
      resetForm()
      onDecided?.()
    } catch (err) {
      const f = classifyGovernanceError(err, '提交审核失败')
      setFailure(f)
      if (f.kind === 'conflict') {
        // The old decision is void: fresh facts, fresh intent.
        intentKey.current.reset()
        resetForm()
        void load(detail.id)
      } else if (f.kind === 'unconfirmed') {
        // Keep the key: resubmitting the same decision replays instead of deciding twice.
        void load(detail.id)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const status = detail ? refundStatusLabel(detail.status) : null

  return (
    <SideSheet
      open={refundId !== null}
      onOpenChange={onOpenChange}
      locked={submitting}
      testId="refund-review-sheet"
      title="退款审核"
      description={detail ? <span className="font-mono">{detail.id}</span> : '读取中…'}
      meta={
        <>
          {status && <StatusChip status={status} testId="refund-review-status" />}
          <button
            type="button"
            aria-label="刷新"
            className="icon-btn rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-border)] cursor-pointer"
            disabled={!refundId || loading || submitting}
            onClick={() => refundId && load(refundId)}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </>
      }
      footer={detail && canReview && allowed.length > 0 ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-[var(--color-text-muted)]">基于版本 v{detail.reviewVersion} 提交；事实变化会被拒绝。</p>
          <button
            type="button"
            data-testid="refund-review-submit"
            disabled={!canSubmit}
            onClick={() => void submit()}
            className={action === 'reject'
              ? 'btn-primary !bg-[var(--color-danger)] !shadow-none px-5 py-2.5'
              : 'btn-primary px-5 py-2.5'}
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {submitting ? '提交中…' : action ? `确认${ACTION_COPY[action].label}` : '选择处理方式'}
          </button>
        </div>
      ) : undefined}
    >
      {forbidden ? (
        <ForbiddenNotice what="退款审核详情" />
      ) : !detail ? (
        loading ? (
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> 读取退款事实…
          </div>
        ) : loadError ? (
          <Notice tone="danger" role="alert" title="加载退款详情失败">{loadError}</Notice>
        ) : null
      ) : (
        <div className="space-y-6">
          {outcome && <OutcomeNotice outcome={outcome} />}
          {failure?.kind === 'conflict' && (
            <ConflictNotice message={failure.message} onReload={() => load(detail.id)} />
          )}
          {failure?.kind === 'unconfirmed' && (
            <Notice tone="warning" role="alert" title="提交结果未确认" testId="refund-review-unconfirmed">
              {failure.message} 若下方历史中没有出现你的决定，可再次提交，系统会识别为同一操作，不会重复执行。
            </Notice>
          )}
          {failure?.kind === 'forbidden' && (
            <Notice tone="danger" role="alert" title="没有审核权限">{failure.message}</Notice>
          )}
          {failure?.kind === 'rejected' && (
            <Notice tone="danger" role="alert" title="提交未成功">{failure.message}</Notice>
          )}

          <Section title="退款概要">
            <FactGrid
              items={[
                { label: '退款金额', value: formatCurrencyAmount(detail.amountMinor, detail.currency) },
                { label: '冲正积分', value: `${formatPoints(detail.pointsToReverse)} 积分` },
                { label: '用户', value: <span className="font-mono">U{detail.userId}</span> },
                { label: '申请原因', value: detail.reasonCode ?? '未记录' },
                { label: '创建时间', value: formatDateTime(detail.createdAt) },
                {
                  label: '充值单',
                  value: <span className="font-mono">{detail.rechargeOrderId.slice(0, 8)}…</span>,
                  hint: detail.rechargeOrderId,
                },
              ]}
            />
          </Section>

          <QualificationCard detail={detail} />

          {detail.blockers.length > 0 && (
            <Section title="阻止原因">
              <BlockerList blockers={detail.blockers} />
            </Section>
          )}

          {canReview && allowed.length > 0 && (
            <Section title="处理决定" testId="refund-review-form">
              <div role="radiogroup" aria-label="处理方式" className="grid gap-2 sm:grid-cols-2">
                {allowed.map((a) => {
                  const selected = action === a
                  return (
                    <button
                      key={a}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-testid={`refund-review-action-${a}`}
                      disabled={submitting}
                      onClick={() => {
                        setAction(a)
                        setReasonCode('')
                      }}
                      className={`rounded-xl border p-3 text-left transition-colors cursor-pointer ${
                        selected
                          ? a === 'reject'
                            ? 'border-[var(--color-danger)] bg-[var(--color-danger-bg)]'
                            : 'border-[var(--color-primary)] bg-[var(--color-primary-tint)]'
                          : 'border-[var(--color-border)] hover:bg-[var(--color-background)]'
                      }`}
                    >
                      <div className="text-sm font-bold text-[var(--color-text)]">{ACTION_COPY[a].label}</div>
                      <div className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">{ACTION_COPY[a].hint}</div>
                    </button>
                  )
                })}
              </div>
              {action && (
                <div className="space-y-3 pt-1">
                  <ReasonFields
                    options={REASONS[action]}
                    reasonCode={reasonCode}
                    onReasonCodeChange={setReasonCode}
                    note={note}
                    onNoteChange={setNote}
                    disabled={submitting}
                  />
                  {action === 'resume' && (
                    <div>
                      <label htmlFor="refund-evidence" className="mb-1.5 block text-xs font-semibold text-[var(--color-text)]">
                        核对凭据（可选）
                      </label>
                      <input
                        id="refund-evidence"
                        className="input py-2 text-sm"
                        maxLength={500}
                        value={evidenceRef}
                        disabled={submitting}
                        onChange={(e) => setEvidenceRef(e.target.value)}
                        placeholder="工单号、对账批次等，不要粘贴卡密或支付原始报文"
                      />
                    </div>
                  )}
                </div>
              )}
            </Section>
          )}
          {!canReview && allowed.length > 0 && (
            <Notice tone="info" title="仅可查看">你没有退款审核权限，可查看事实与历史，但不能提交决定。</Notice>
          )}

          <Section title="审核历史">
            <Timeline
              empty="还没有人工审核记录。"
              entries={detail.history.map((h) => ({
                id: h.id,
                title: ACTION_COPY[h.kind]?.label ?? h.kind,
                status: refundStatusLabel(h.toStatus),
                at: formatDateTime(h.createdAt),
                body: h.note,
                meta: `U${h.actorUserId} · ${h.reasonCode} · 基于 v${h.expectedReviewVersion}${h.evidenceRef ? ` · 凭据 ${h.evidenceRef}` : ''}`,
              }))}
            />
          </Section>
        </div>
      )}
    </SideSheet>
  )
}

function QualificationCard({ detail }: { detail: GVRefundDetail }) {
  const q = detail.qualification
  const legacy = q.sourceKind === 'legacy_unknown'
  const covered = compareMinor(q.availablePoints, q.requiredPoints) >= 0
  // Display-only proportion; eligibility itself comes from allowedActions/blockers.
  const pct = (() => {
    try {
      const required = BigInt(q.requiredPoints)
      if (required === 0n) return 100
      const ratio = (BigInt(q.availablePoints) * 100n) / required
      return Number(ratio > 100n ? 100n : ratio)
    } catch {
      return 0
    }
  })()

  return (
    <Section title="原充值来源资格" aside={<span className="text-[11px] text-[var(--color-text-muted)]">截至 {formatDateTime(q.asOf)}</span>}>
      {legacy ? (
        <Notice tone="warning" title="历史来源无法证明" testId="refund-legacy-source">
          这笔充值早于来源追踪上线，系统无法确认对应积分是否仍未消费。不能用其他充值或奖励积分冒充原来源。
        </Notice>
      ) : (
        <div data-testid="refund-qualification" className="rounded-xl border border-[var(--color-border)] p-4">
          <div className="flex items-baseline justify-between gap-3">
            <div>
              <div className="text-[11px] text-[var(--color-text-muted)]">原充值来源可用</div>
              <div className={`text-xl font-bold tabular-nums ${covered ? 'text-[var(--color-success-text)]' : 'text-[var(--color-warning-text)]'}`}>
                {formatPoints(q.availablePoints)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-[var(--color-text-muted)]">退款需要</div>
              <div className="text-xl font-bold tabular-nums text-[var(--color-text)]">{formatPoints(q.requiredPoints)}</div>
            </div>
          </div>
          <div
            className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--color-background)]"
            role="meter"
            aria-label="原来源覆盖比例"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${covered ? 'bg-[var(--color-success)]' : 'bg-[var(--color-warning)]'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">
            只统计这笔充值本身尚未消费的积分，其他来源余额不计入。
          </p>
        </div>
      )}
    </Section>
  )
}

function OutcomeNotice({ outcome }: { outcome: Outcome }) {
  const { detail, replayed, action } = outcome
  const title = action === 'reject'
    ? '已记录拒绝决定'
    : detail.status === 'succeeded'
      ? '现金已退回'
      : '审核已通过，现金退款尚在执行'
  const body = action === 'reject'
    ? '未发起外部退款，用户积分未变动。'
    : detail.status === 'succeeded'
      ? '渠道已确认退款完成。'
      : `当前状态「${refundStatusLabel(detail.status).label}」。积分已按原来源冻结，渠道退款完成前不要告知用户“已到账”。`
  return (
    <div
      role="status"
      data-testid="refund-review-outcome"
      className="flex gap-3 rounded-xl border border-[var(--color-success-border)] bg-[var(--color-success-bg)] p-3.5"
    >
      <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" />
      <div className="text-sm">
        <div className="font-semibold text-[var(--color-text)]">{title}</div>
        <div className="mt-1 text-xs text-[var(--color-text-muted)]">
          {body}
          {replayed && ' 本次为同一决定的重放，系统没有重复执行。'}
        </div>
      </div>
    </div>
  )
}
