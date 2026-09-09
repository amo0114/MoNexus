import { useEffect, useState } from 'react'
import {
  approveAdminAssuranceApplication,
  getAdminProductAssurance,
  grantAdminProductAssurance,
  listAdminAssuranceApplications,
  rejectAdminAssuranceApplication,
  revokeAdminAssuranceGrant,
  type AssuranceApplicationDto,
  type AssuranceGrantDto,
} from '../../api/assurance'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'

function defaultValidUntil() {
  return new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 16)
}

export default function AdminAssurancePanel({ productId }: { productId: number | null }) {
  const showToast = useAppStore((s) => s.showToast)
  const [applications, setApplications] = useState<AssuranceApplicationDto[]>([])
  const [grant, setGrant] = useState<AssuranceGrantDto | null>(null)
  const [reason, setReason] = useState('审核通过，授予平台保障。')
  const [validUntil, setValidUntil] = useState(defaultValidUntil)
  const [loading, setLoading] = useState(false)

  async function reload() {
    const [list, current] = await Promise.all([
      listAdminAssuranceApplications({ status: 'pending', pageSize: 20 }),
      productId ? getAdminProductAssurance(productId) : Promise.resolve({ application: null, grant: null }),
    ])
    setApplications(list.items)
    setGrant(current.grant)
  }

  useEffect(() => {
    void reload().catch((err) => showToast(getApiErrorMessage(err, '保障信息加载失败'), 'error'))
  }, [productId])

  async function approve(id: number) {
    setLoading(true)
    try {
      await approveAdminAssuranceApplication(id, { validUntil: new Date(validUntil).toISOString(), reason })
      await reload()
      showToast('已批准保障申请')
    } catch (err) {
      showToast(getApiErrorMessage(err, '批准失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  async function reject(id: number) {
    setLoading(true)
    try {
      await rejectAdminAssuranceApplication(id, reason)
      await reload()
      showToast('已拒绝保障申请')
    } catch (err) {
      showToast(getApiErrorMessage(err, '拒绝失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  async function grantCurrent() {
    if (!productId) return
    setLoading(true)
    try {
      await grantAdminProductAssurance(productId, { validUntil: new Date(validUntil).toISOString(), reason })
      await reload()
      showToast('已授予保障')
    } catch (err) {
      showToast(getApiErrorMessage(err, '授予失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  async function revokeCurrent() {
    if (!grant || grant.status !== 'active') return
    setLoading(true)
    try {
      await revokeAdminAssuranceGrant(grant.id, reason)
      await reload()
      showToast('已撤销保障')
    } catch (err) {
      showToast(getApiErrorMessage(err, '撤销失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mb-6 rounded-xl border border-[var(--color-border)] p-4 space-y-3" data-testid="admin-assurance-panel">
      <h3 className="font-heading text-sm font-bold">平台保障</h3>
      <p className="text-xs text-[var(--color-text-muted)]">到期日与原因需管理员明确确认。有效授权最长 365 天，默认建议 90 天。</p>
      <div className="flex flex-wrap gap-2">
        <input
          type="datetime-local"
          className="input max-w-xs"
          value={validUntil}
          onChange={(event) => setValidUntil(event.target.value)}
        />
        <input
          className="input max-w-sm"
          value={reason}
          maxLength={500}
          onChange={(event) => setReason(event.target.value)}
          placeholder="审核/授权/撤销原因"
        />
      </div>
      {productId && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary min-h-[44px] px-4" disabled={loading} onClick={() => void grantCurrent()}>
            授予当前商品
          </button>
          {grant?.status === 'active' && (
            <button type="button" className="btn-secondary min-h-[44px] px-4" disabled={loading} onClick={() => void revokeCurrent()}>
              撤销当前授权
            </button>
          )}
          {grant && (
            <span className="self-center text-xs text-[var(--color-text-muted)]">
              当前授权 {grant.status}，至 {new Date(grant.validUntil).toLocaleString()}
            </span>
          )}
        </div>
      )}
      <div className="space-y-2">
        {applications.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">没有待审核申请</p>
        ) : applications.map((item) => (
          <div key={item.id} className="rounded-lg border border-[var(--color-border)] p-3 text-sm">
            <p>商品 #{item.productId} · {item.reason}</p>
            <div className="mt-2 flex gap-2">
              <button type="button" className="btn-primary min-h-[44px] px-3" disabled={loading} onClick={() => void approve(item.id)}>
                批准
              </button>
              <button type="button" className="btn-secondary min-h-[44px] px-3" disabled={loading} onClick={() => void reject(item.id)}>
                拒绝
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
