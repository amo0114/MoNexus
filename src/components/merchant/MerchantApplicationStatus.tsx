import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Clock, Loader2, PauseCircle, RefreshCw, XCircle } from 'lucide-react'
import { getMyMerchantApplication, resubmitMerchantApplication } from '../../api/governance'
import type { GVMerchantApplication, GVMerchantEvent } from '../../types/governance'
import { IntentKey, classifyGovernanceError, formatDateTime, merchantActionLabel, type GovernanceFailure } from '../../utils/governance'
import { ConflictNotice, Notice, Timeline } from '../admin/governance/GovernanceKit'

function latest(app: GVMerchantApplication, action: GVMerchantEvent['action']): GVMerchantEvent | undefined {
  return [...app.history].reverse().find((e) => e.action === action)
}

/**
 * governance-v1 application view for an existing merchant record: pending,
 * rejected (with reason + edit & resubmit on the same Merchant), or suspended
 * (explanation + read-only entry). The backend decides every allowed action.
 */
export default function MerchantApplicationStatus({ onChanged }: { onChanged: () => Promise<void> | void }) {
  const navigate = useNavigate()
  const [app, setApp] = useState<GVMerchantApplication | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ name: '', description: '', contactEmail: '', contactPhone: '' })
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<GovernanceFailure | null>(null)
  const [justResubmitted, setJustResubmitted] = useState(false)
  const intentKey = useRef(new IntentKey())
  const seqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++seqRef.current
    setLoading(true)
    setLoadError(null)
    try {
      const next = await getMyMerchantApplication()
      if (seq !== seqRef.current) return
      setApp(next)
    } catch (err) {
      if (seq !== seqRef.current) return
      setLoadError(classifyGovernanceError(err, '暂时无法读取申请状态').message)
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    return () => { seqRef.current++ }
  }, [load])

  function startEditing(current: GVMerchantApplication) {
    const c = current.currentApplication
    setForm({ name: c?.name ?? '', description: c?.description ?? '', contactEmail: c?.contactEmail ?? '', contactPhone: c?.contactPhone ?? '' })
    setFailure(null)
    setEditing(true)
  }

  async function resubmit() {
    if (!app || submitting || !form.name.trim()) return
    const input = {
      name: form.name.trim(),
      description: form.description,
      contactEmail: form.contactEmail.trim(),
      contactPhone: form.contactPhone.trim(),
      expectedLifecycleVersion: app.lifecycleVersion,
    }
    const key = intentKey.current.for(input)
    setSubmitting(true)
    setFailure(null)
    try {
      const next = await resubmitMerchantApplication(input, key)
      intentKey.current.reset()
      setApp(next)
      setEditing(false)
      setJustResubmitted(true)
      await onChanged()
    } catch (err) {
      const f = classifyGovernanceError(err, '重新提交失败')
      setFailure(f)
      if (f.kind === 'conflict') {
        intentKey.current.reset()
        void load()
      } else if (f.kind === 'unconfirmed') {
        void load()
      } else {
        intentKey.current.reset()
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (loading && !app) {
    return (
      <div className="card max-w-3xl mx-auto flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />读取申请状态…
      </div>
    )
  }
  if (!app) {
    return (
      <div className="card max-w-3xl mx-auto">
        <Notice tone="danger" role="alert" title="暂时无法读取申请状态" action={<button type="button" className="btn-tonal" onClick={() => void load()}>重试</button>}>
          {loadError}
        </Notice>
      </div>
    )
  }

  const canResubmit = app.allowedActions.includes('resubmit') && app.merchantCapabilities.includes('application.resubmit')
  const rejection = latest(app, 'reject')
  const suspension = latest(app, 'suspend')
  const timeline = app.history.map((e) => ({
    id: e.id,
    title: merchantActionLabel(e.action).label,
    at: formatDateTime(e.createdAt),
    // Reviewer notes on reject/suspend are written for the applicant.
    body: e.action === 'reject' || e.action === 'suspend' ? e.note : undefined,
  }))

  const header = app.status === 'rejected'
    ? { Icon: XCircle, tone: 'text-[var(--color-danger)]', title: '商家申请未通过' }
    : app.status === 'suspended'
      ? { Icon: PauseCircle, tone: 'text-[var(--color-warning)]', title: '商家经营已停用' }
      : { Icon: Clock, tone: 'text-[var(--color-info)]', title: '商家申请审核中' }

  return (
    <div className="max-w-3xl mx-auto space-y-4" data-testid="merchant-application-status" data-status={app.status ?? ''}>
      <div className="card space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <header.Icon aria-hidden="true" className={`mt-1 h-6 w-6 shrink-0 ${header.tone}`} />
            <div>
              <h2 className="font-heading text-2xl font-bold text-[var(--color-text)]">{header.title}</h2>
              {app.currentApplication && (
                <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                  {app.currentApplication.name} · 第 {app.currentApplication.version} 版资料，提交于 {formatDateTime(app.currentApplication.submittedAt)}
                </p>
              )}
            </div>
          </div>
          <button type="button" aria-label="刷新申请状态" className="icon-btn rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-border)] cursor-pointer" disabled={loading} onClick={() => void load()}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {justResubmitted && app.status === 'pending' && (
          <Notice tone="info" role="status" title="已重新提交，等待平台审核">原申请记录与驳回意见都会保留。</Notice>
        )}

        {app.status === 'pending' && !justResubmitted && (
          <p className="text-sm text-[var(--color-text-muted)]">平台正在审核你的入驻申请，结果会通过站内通知告诉你。</p>
        )}

        {app.status === 'rejected' && (
          <div className="rounded-xl border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-4" data-testid="merchant-rejection">
            <div className="text-xs font-semibold text-[var(--color-danger-text)]">驳回意见</div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--color-text)]">{rejection?.note || '平台没有留下具体意见，如有疑问请联系管理员。'}</p>
            {rejection && <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{formatDateTime(rejection.createdAt)}</p>}
          </div>
        )}

        {app.status === 'suspended' && (
          <div className="space-y-3">
            <div className="rounded-xl border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] p-4">
              <div className="text-xs font-semibold text-[var(--color-warning-text)]">停用说明</div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--color-text)]">{suspension?.note || '平台没有留下具体说明，如有疑问请联系管理员。'}</p>
            </div>
            <p className="text-sm text-[var(--color-text-muted)]">停用期间不能发布商品或接新单。商家资料、历史订单与结算仍可查看。</p>
            {app.merchantCapabilities.includes('history.read') && (
              <button type="button" className="btn-secondary" onClick={() => navigate('/merchant')}>进入商家中心（只读）</button>
            )}
          </div>
        )}

        {app.blockers.length > 0 && (
          <ul className="space-y-1 text-xs text-[var(--color-warning-text)]">
            {app.blockers.map((b) => <li key={b.code}>· {b.message}</li>)}
          </ul>
        )}

        {canResubmit && !editing && (
          <button type="button" className="btn-primary" onClick={() => startEditing(app)} data-testid="merchant-resubmit-start">
            修改资料并重新提交
          </button>
        )}
      </div>

      {canResubmit && editing && (
        <form
          className="card flex flex-col gap-5"
          data-testid="merchant-resubmit-form"
          onSubmit={(e) => { e.preventDefault(); void resubmit() }}
        >
          <h3 className="font-heading text-lg font-bold">修改申请资料</h3>
          {failure?.kind === 'conflict' && <ConflictNotice message="申请状态已经变化。" onReload={() => void load()} />}
          {failure && failure.kind !== 'conflict' && (
            <Notice tone={failure.kind === 'unconfirmed' ? 'warning' : 'danger'} role="alert" title={failure.kind === 'unconfirmed' ? '提交结果未确认' : '提交未成功'}>
              {failure.message}
            </Notice>
          )}
          <Field id="resubmit-name" label="商家名称" required>
            <input id="resubmit-name" className="input" required maxLength={100} value={form.name} disabled={submitting} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field id="resubmit-description" label="商家简介">
            <textarea id="resubmit-description" className="input min-h-[100px] resize-y" maxLength={2000} value={form.description} disabled={submitting} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field id="resubmit-email" label="联系邮箱">
              <input id="resubmit-email" type="email" className="input" value={form.contactEmail} disabled={submitting} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
            </Field>
            <Field id="resubmit-phone" label="联系电话">
              <input id="resubmit-phone" className="input" maxLength={50} value={form.contactPhone} disabled={submitting} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
            </Field>
          </div>
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" className="btn-secondary" disabled={submitting} onClick={() => setEditing(false)}>取消</button>
            <button type="submit" className="btn-primary" disabled={submitting || !form.name.trim()} data-testid="merchant-resubmit-submit">
              {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {submitting ? '提交中…' : '重新提交审核'}
            </button>
          </div>
        </form>
      )}

      {timeline.length > 0 && (
        <div className="card">
          <h3 className="mb-4 text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">处理记录</h3>
          <Timeline entries={timeline} empty="" />
        </div>
      )}
    </div>
  )
}

function Field({ id, label, required, children }: { id: string; label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium mb-1.5 text-[var(--color-text)]">
        {label} {required && <span className="text-[var(--color-danger)]">*</span>}
      </label>
      {children}
    </div>
  )
}
