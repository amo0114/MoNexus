import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import SideSheet from '../../ui/SideSheet'
import { decideMerchant, getAdminMerchantHistory, type MerchantDecision } from '../../../api/governance'
import type { GVMerchantApplication } from '../../../types/governance'
import {
  IntentKey,
  classifyGovernanceError,
  formatDateTime,
  merchantActionLabel,
  merchantStatusLabel,
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

const DECISIONS: MerchantDecision[] = ['approve', 'reject', 'suspend', 'restore']

const DECISION_COPY: Record<MerchantDecision, { label: string; hint: string; danger: boolean }> = {
  approve: { label: '通过申请', hint: '开通商家经营能力。', danger: false },
  reject: { label: '驳回申请', hint: '申请人可以修改资料后重新提交，原记录保留。', danger: true },
  suspend: { label: '停用经营', hint: '禁止发布和接新单；历史资料保持只读，存量订单按受限处置。', danger: true },
  restore: { label: '恢复经营', hint: '只恢复商家经营，不会解除账号封禁或支付风险限制。', danger: false },
}

const REASONS: Record<MerchantDecision, ReasonOption[]> = {
  approve: [{ value: 'qualified', label: '资料齐全，符合入驻要求' }, { value: 'other', label: '其他' }],
  reject: [
    { value: 'incomplete', label: '资料不完整' },
    { value: 'unverifiable_contact', label: '联系方式无法核实' },
    { value: 'category_not_supported', label: '经营类目不支持' },
    { value: 'other', label: '其他' },
  ],
  suspend: [
    { value: 'policy_violation', label: '违反平台规则' },
    { value: 'fulfillment_quality', label: '履约质量问题' },
    { value: 'risk_review', label: '风险核查' },
    { value: 'other', label: '其他' },
  ],
  restore: [{ value: 'issue_resolved', label: '问题已整改' }, { value: 'appeal_accepted', label: '申诉成立' }, { value: 'other', label: '其他' }],
}

interface Props {
  merchantId: number | null
  merchantName?: string
  can: (decision: MerchantDecision) => boolean
  onOpenChange: (open: boolean) => void
  onDecided?: () => void
}

export default function MerchantReviewSheet({ merchantId, merchantName, can, onOpenChange, onDecided }: Props) {
  const [app, setApp] = useState<GVMerchantApplication | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [decision, setDecision] = useState<MerchantDecision | null>(null)
  const [reasonCode, setReasonCode] = useState('')
  const [note, setNote] = useState('')
  const [evidenceRef, setEvidenceRef] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<GovernanceFailure | null>(null)
  const [decided, setDecided] = useState<MerchantDecision | null>(null)
  const intentKey = useRef(new IntentKey())
  const controllerRef = useRef<AbortController | null>(null)

  const resetForm = () => {
    setDecision(null)
    setReasonCode('')
    setNote('')
    setEvidenceRef('')
  }

  const load = useCallback((id: number) => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setLoading(true)
    setLoadError(null)
    getAdminMerchantHistory(id, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return
        setApp(next)
        setForbidden(false)
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        const f = classifyGovernanceError(err, '加载商家审核记录失败')
        if (f.kind === 'forbidden') setForbidden(true)
        else setLoadError(f.message)
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
  }, [])

  useEffect(() => {
    setApp(null)
    setFailure(null)
    setDecided(null)
    setForbidden(false)
    resetForm()
    intentKey.current.reset()
    if (merchantId !== null) load(merchantId)
    return () => controllerRef.current?.abort()
  }, [merchantId, load])

  const available = app ? DECISIONS.filter((d) => app.allowedActions.includes(d) && can(d)) : []
  const canSubmit = Boolean(app && decision && available.includes(decision) && reasonCode && note.trim() && !submitting)

  async function submit() {
    if (!app || !decision || merchantId === null || !canSubmit) return
    const input = {
      expectedLifecycleVersion: app.lifecycleVersion,
      applicationVersion: app.applicationVersion,
      reasonCode,
      note: note.trim(),
      evidenceRef: decision === 'restore' && evidenceRef.trim() ? evidenceRef.trim() : null,
    }
    const key = intentKey.current.for({ merchantId, decision, ...input })
    setSubmitting(true)
    setFailure(null)
    try {
      const next = await decideMerchant(merchantId, decision, input, key)
      intentKey.current.reset()
      setApp(next)
      setDecided(decision)
      resetForm()
      onDecided?.()
    } catch (err) {
      const f = classifyGovernanceError(err, '提交决定失败')
      setFailure(f)
      if (f.kind === 'conflict') {
        intentKey.current.reset()
        resetForm()
        load(merchantId)
      } else if (f.kind === 'unconfirmed') {
        load(merchantId)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const current = app?.currentApplication
  // History entries for an older application revision are shown as superseded.
  const entries = (app?.history ?? []).map((e) => ({
    id: e.id,
    title: merchantActionLabel(e.action).label,
    status: merchantStatusLabel(e.toStatus),
    at: formatDateTime(e.createdAt),
    body: e.note,
    meta: `${e.actorUserId !== null ? `U${e.actorUserId}` : '系统'} · ${e.reasonCode} · 决定后 v${e.versionAfter}${
      current && e.applicationRevisionId && e.applicationRevisionId !== current.id ? ' · 针对旧版申请' : ''
    }`,
  }))

  return (
    <SideSheet
      open={merchantId !== null}
      onOpenChange={onOpenChange}
      locked={submitting}
      testId="merchant-review-sheet"
      title={current?.name ?? merchantName ?? '商家审核'}
      description={app ? `商家 #${app.merchantId ?? merchantId} · 生命周期 v${app.lifecycleVersion} · 申请第 ${app.applicationVersion} 版` : '读取中…'}
      meta={
        <>
          {app?.status && <StatusChip status={merchantStatusLabel(app.status)} testId="merchant-review-status" />}
          <button
            type="button"
            aria-label="刷新"
            disabled={merchantId === null || loading || submitting}
            onClick={() => merchantId !== null && load(merchantId)}
            className="icon-btn rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-border)] cursor-pointer"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </>
      }
      footer={app && available.length > 0 ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-[var(--color-text-muted)]">针对申请第 {app.applicationVersion} 版提交；资料或状态变化会被拒绝。</p>
          <button
            type="button"
            data-testid="merchant-review-submit"
            disabled={!canSubmit}
            onClick={() => void submit()}
            className={decision && DECISION_COPY[decision].danger ? 'btn-primary !bg-[var(--color-danger)] !shadow-none px-5 py-2.5' : 'btn-primary px-5 py-2.5'}
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {submitting ? '提交中…' : decision ? `确认${DECISION_COPY[decision].label}` : '选择决定'}
          </button>
        </div>
      ) : undefined}
    >
      {forbidden ? (
        <ForbiddenNotice what="商家审核记录" />
      ) : !app ? (
        loading ? (
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />读取审核记录…</div>
        ) : loadError ? (
          <Notice tone="danger" role="alert" title="加载失败">{loadError}</Notice>
        ) : null
      ) : (
        <div className="space-y-6">
          {decided && (
            <Notice tone="info" role="status" title={`已${DECISION_COPY[decided].label}`} testId="merchant-review-outcome">
              当前状态「{merchantStatusLabel(app.status).label}」。
              {decided === 'restore' && ' 账号封禁和支付限制不受影响，如有需要请分别处理。'}
            </Notice>
          )}
          {failure?.kind === 'conflict' && (
            <ConflictNotice
              message={failure.code === 'APPLICATION_VERSION_CHANGED' ? '申请人已提交了新版本资料。' : failure.message}
              onReload={() => merchantId !== null && load(merchantId)}
            />
          )}
          {failure && failure.kind !== 'conflict' && (
            <Notice tone={failure.kind === 'unconfirmed' ? 'warning' : 'danger'} role="alert" title={failure.kind === 'unconfirmed' ? '结果未确认' : '提交未成功'}>
              {failure.message}
              {failure.kind === 'unconfirmed' && ' 若时间线中没有你的决定，可再次提交，不会重复执行。'}
            </Notice>
          )}

          {current && (
            <Section
              title={`当前申请 · 第 ${current.version} 版`}
              aside={current.isLegacyBaseline && <StatusChip status={{ label: '历史基线', tone: 'neutral' }} />}
            >
              {current.isLegacyBaseline && (
                <p className="text-[11px] text-[var(--color-text-muted)]">这是系统升级时记录的已有资料，不是一次真实提交；之前的审核决定可能未留存。</p>
              )}
              <FactGrid
                items={[
                  { label: '商家名称', value: current.name },
                  { label: '联系邮箱', value: current.contactEmail || '未填写' },
                  { label: '联系电话', value: current.contactPhone || '未填写' },
                  { label: '提交时间', value: formatDateTime(current.submittedAt) },
                  { label: '提交人', value: current.submittedByUserId !== null ? `U${current.submittedByUserId}` : '未知' },
                ]}
              />
              {current.description && (
                <p className="whitespace-pre-wrap rounded-lg bg-[var(--color-background)] p-3 text-xs leading-relaxed text-[var(--color-text)]">{current.description}</p>
              )}
            </Section>
          )}

          {app.blockers.length > 0 && (
            <Section title="阻止原因"><BlockerList blockers={app.blockers} /></Section>
          )}

          {available.length > 0 && (
            <Section title="处理决定" testId="merchant-review-form">
              <div role="radiogroup" aria-label="处理决定" className="grid gap-2 sm:grid-cols-2">
                {available.map((d) => (
                  <button
                    key={d}
                    type="button"
                    role="radio"
                    aria-checked={decision === d}
                    data-testid={`merchant-review-action-${d}`}
                    disabled={submitting}
                    onClick={() => { setDecision(d); setReasonCode('') }}
                    className={`rounded-xl border p-3 text-left cursor-pointer transition-colors ${
                      decision === d
                        ? DECISION_COPY[d].danger
                          ? 'border-[var(--color-danger)] bg-[var(--color-danger-bg)]'
                          : 'border-[var(--color-primary)] bg-[var(--color-primary-tint)]'
                        : 'border-[var(--color-border)] hover:bg-[var(--color-background)]'
                    }`}
                  >
                    <div className="text-sm font-bold">{DECISION_COPY[d].label}</div>
                    <div className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">{DECISION_COPY[d].hint}</div>
                  </button>
                ))}
              </div>
              {decision && (
                <div className="space-y-3 pt-1">
                  <ReasonFields
                    options={REASONS[decision]}
                    reasonCode={reasonCode}
                    onReasonCodeChange={setReasonCode}
                    note={note}
                    onNoteChange={setNote}
                    noteLabel={decision === 'reject' ? '驳回理由（申请人可见）' : '处理说明'}
                    notePlaceholder={decision === 'reject' ? '说明需要补充或修改的内容，申请人据此重提' : '写明依据，将记入审计'}
                    disabled={submitting}
                  />
                  {decision === 'restore' && (
                    <div>
                      <label htmlFor="merchant-restore-evidence" className="mb-1.5 block text-xs font-semibold">恢复依据（可选）</label>
                      <input
                        id="merchant-restore-evidence"
                        className="input py-2 text-sm"
                        maxLength={500}
                        value={evidenceRef}
                        disabled={submitting}
                        onChange={(e) => setEvidenceRef(e.target.value)}
                        placeholder="整改记录或工单号"
                      />
                    </div>
                  )}
                </div>
              )}
            </Section>
          )}

          <Section title="审核时间线">
            <Timeline entries={entries} empty="没有留存的审核决定（历史商家可能早于审核记录上线）。" />
          </Section>
        </div>
      )}
    </SideSheet>
  )
}
