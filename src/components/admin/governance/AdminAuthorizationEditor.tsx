import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { getAdminAuthorization, updateAdminAuthorization } from '../../../api/governance'
import { useAppStore } from '../../../stores/appStore'
import type { AdminPermission, AdminTier, GVAuthorization } from '../../../types/governance'
import { IntentKey, classifyGovernanceError, formatDateTime, type GovernanceFailure } from '../../../utils/governance'
import { ConflictNotice, ForbiddenNotice, Notice } from './GovernanceKit'

const PERMISSION_GROUPS: Array<{ title: string; items: Array<[AdminPermission, string]> }> = [
  { title: '用户与积分', items: [['users.read', '查看用户'], ['users.ban', '封禁/解封'], ['points.read', '查看积分'], ['points.adjust', '调整积分']] },
  { title: '商家与商品', items: [['merchants.read', '查看商家'], ['merchants.review', '审核入驻'], ['merchants.suspend', '停用/恢复商家'], ['catalog.read', '查看商品'], ['catalog.write', '编辑商品'], ['inventory.manage', '库存治理']] },
  { title: '订单与结算', items: [['orders.read', '查看订单'], ['orders.delivery.read', '查看交付内容'], ['orders.resolve', '裁决订单'], ['orders.after_sales.execute', '执行售后'], ['settlements.read', '查看结算'], ['settlements.execute', '执行结算']] },
  { title: '支付', items: [['payments.read', '查看支付'], ['payments.refunds.review', '审核退款'], ['payments.disputes.resolve', '处理争议'], ['wallet.integrity.read', '资金巡检']] },
  { title: '审计与导出', items: [['audit.read', '查看审计'], ['audit.details.read', '审计详情与安全事件'], ['exports.create', '创建导出']] },
  { title: '运营内容', items: [['marketing.read', '查看营销'], ['marketing.write', '编辑营销'], ['announcements.read', '查看公告'], ['announcements.write', '编辑公告'], ['videos.read', '查看视频'], ['videos.manage', '审核视频']] },
  { title: '系统', items: [['settings.manage', '系统配置'], ['files.manage', '文件治理'], ['backups.manage', '备份恢复'], ['ai.manage', 'AI 设置'], ['admin.permissions.manage', '管理后台权限']] },
]

/** super-only editor for another admin's tier and permission set. */
export default function AdminAuthorizationEditor({ userId }: { userId: number }) {
  const showToast = useAppStore((s) => s.showToast)
  const [current, setCurrent] = useState<GVAuthorization | null>(null)
  const [tier, setTier] = useState<AdminTier>('operator')
  const [selected, setSelected] = useState<Set<AdminPermission>>(new Set())
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<GovernanceFailure | null>(null)
  const intentKey = useRef(new IntentKey())

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true)
    setLoadError(null)
    getAdminAuthorization(userId, signal)
      .then((auth) => {
        if (signal?.aborted) return
        setCurrent(auth)
        setTier(auth.tier)
        setSelected(new Set(auth.permissions))
      })
      .catch((err) => {
        if (signal?.aborted) return
        const f = classifyGovernanceError(err, '读取后台权限失败')
        if (f.kind === 'forbidden') setForbidden(true)
        else setLoadError(f.message)
      })
      .finally(() => { if (!signal?.aborted) setLoading(false) })
  }, [userId])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  if (forbidden) return <ForbiddenNotice what="后台权限" />
  if (loading && !current) return <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />读取中…</div>
  if (loadError || !current) return <Notice tone="danger" role="alert" title="读取后台权限失败">{loadError}</Notice>

  const permissions = [...selected].sort()
  const dirty = tier !== current.tier || permissions.join() !== [...current.permissions].sort().join()

  async function save() {
    if (!current || !dirty || !reason.trim() || saving) return
    const input = { tier, expectedVersion: current.version, permissions, reason: reason.trim() }
    const key = intentKey.current.for({ userId, ...input })
    setSaving(true)
    setFailure(null)
    try {
      const next = await updateAdminAuthorization(userId, input, key)
      intentKey.current.reset()
      setCurrent(next)
      setTier(next.tier)
      setSelected(new Set(next.permissions))
      setReason('')
      showToast('后台权限已更新')
    } catch (err) {
      const f = classifyGovernanceError(err, '保存后台权限失败')
      if (f.kind !== 'unconfirmed') intentKey.current.reset()
      setFailure(f)
      if (f.kind === 'conflict' || f.kind === 'unconfirmed') load()
    } finally {
      setSaving(false)
    }
  }

  const toggle = (p: AdminPermission) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(p)) next.delete(p)
    else next.add(p)
    return next
  })

  return (
    <div className="space-y-4" data-testid="admin-authorization-editor">
      {failure?.kind === 'conflict' && <ConflictNotice message={failure.message} />}
      {failure && failure.kind !== 'conflict' && (
        <Notice tone={failure.kind === 'unconfirmed' ? 'warning' : 'danger'} role="alert" title="保存未确认">{failure.message}</Notice>
      )}
      <div role="radiogroup" aria-label="管理员级别" className="grid grid-cols-2 gap-2">
        {(['operator', 'super'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={tier === t}
            disabled={saving}
            onClick={() => setTier(t)}
            className={`rounded-xl border p-3 text-left cursor-pointer transition-colors ${tier === t ? 'border-[var(--color-primary)] bg-[var(--color-primary-tint)]' : 'border-[var(--color-border)] hover:bg-[var(--color-background)]'}`}
          >
            <div className="text-sm font-bold">{t === 'super' ? '超级管理员' : '运营管理员'}</div>
            <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{t === 'super' ? '拥有全部权限，可管理其他管理员' : '仅拥有下方勾选的权限'}</div>
          </button>
        ))}
      </div>
      {tier === 'operator' && (
        <div className="space-y-3">
          {PERMISSION_GROUPS.map((g) => (
            <fieldset key={g.title}>
              <legend className="mb-1.5 text-[11px] font-bold text-[var(--color-text-muted)]">{g.title}</legend>
              <div className="flex flex-wrap gap-1.5">
                {g.items.map(([p, label]) => (
                  <label
                    key={p}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs cursor-pointer transition-colors ${selected.has(p) ? 'border-[var(--color-primary)] bg-[var(--color-primary-tint)] text-[var(--color-primary)]' : 'border-[var(--color-border)] text-[var(--color-text-muted)]'}`}
                  >
                    <input type="checkbox" className="accent-[var(--color-primary)]" checked={selected.has(p)} disabled={saving} onChange={() => toggle(p)} />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      )}
      <div>
        <label htmlFor="authorization-reason" className="mb-1.5 block text-xs font-semibold">变更理由 <span className="text-[var(--color-danger)]">*</span></label>
        <input id="authorization-reason" className="input py-2 text-sm" maxLength={1000} value={reason} disabled={saving} onChange={(e) => setReason(e.target.value)} placeholder="例如：调岗为客服，只保留用户与订单查看" />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-[var(--color-text-muted)]">v{current.version} · 更新于 {formatDateTime(current.updatedAt)}</span>
        <button type="button" className="btn-primary px-5 py-2" disabled={!dirty || !reason.trim() || saving} onClick={() => void save()}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}保存权限
        </button>
      </div>
    </div>
  )
}
