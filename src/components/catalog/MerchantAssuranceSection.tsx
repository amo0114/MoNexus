import { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import {
  applyMerchantAssurance,
  getMerchantAssurance,
  withdrawMerchantAssurance,
  type AssuranceApplicationDto,
  type AssuranceGrantDto,
} from '../../api/assurance'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'

export default function MerchantAssuranceSection({ productId }: { productId: number }) {
  const showToast = useAppStore((s) => s.showToast)
  const [application, setApplication] = useState<AssuranceApplicationDto | null>(null)
  const [grant, setGrant] = useState<AssuranceGrantDto | null>(null)
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)

  async function reload() {
    const data = await getMerchantAssurance(productId)
    setApplication(data.application)
    setGrant(data.grant)
  }

  useEffect(() => {
    let cancelled = false
    getMerchantAssurance(productId)
      .then((data) => {
        if (cancelled) return
        setApplication(data.application)
        setGrant(data.grant)
      })
      .catch(() => {
        if (!cancelled) showToast('保障状态加载失败', 'error')
      })
    return () => { cancelled = true }
  }, [productId, showToast])

  async function apply() {
    setLoading(true)
    try {
      await applyMerchantAssurance(productId, reason.trim())
      setReason('')
      await reload()
      showToast('已提交保障申请')
    } catch (err) {
      showToast(getApiErrorMessage(err, '申请失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  async function withdraw() {
    if (!application) return
    setLoading(true)
    try {
      await withdrawMerchantAssurance(application.id)
      await reload()
      showToast('已撤回申请')
    } catch (err) {
      showToast(getApiErrorMessage(err, '撤回失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  const grantActive = grant?.status === 'active'
  const canApply = !grantActive && application?.status !== 'pending'

  return (
    <div data-testid="merchant-assurance-section" className="space-y-3">
      <p className="text-xs text-[var(--color-text-muted)]">
        平台保障由管理员审核后授予，不能自行勾选。兑换始终按订单当时的条款快照执行。
      </p>
      {grant && (
        <p className="text-sm text-[var(--color-text)]">
          当前授权：{grant.status === 'active' ? '有效' : grant.status === 'expired' ? '已到期' : '已撤销'}
          ，至 {new Date(grant.validUntil).toLocaleDateString()}
        </p>
      )}
      {application && (
        <p className="text-sm text-[var(--color-text)]">
          最近申请：{application.status === 'pending' ? '待审核' : application.status === 'approved' ? '已通过' : application.status === 'rejected' ? '已拒绝' : '已撤回'}
        </p>
      )}
      {application?.status === 'pending' && (
        <button type="button" className="btn-secondary min-h-[44px] px-4" disabled={loading} onClick={() => void withdraw()}>
          撤回申请
        </button>
      )}
      {canApply && (
        <div className="space-y-2">
          <textarea
            className="input min-h-[88px]"
            maxLength={1000}
            placeholder="说明申请平台保障的原因（20-1000 字）"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <button
            type="button"
            className="btn-primary min-h-[44px] px-4"
            disabled={loading || reason.trim().length < 20}
            onClick={() => void apply()}
          >
            提交保障申请
          </button>
        </div>
      )}
    </div>
  )
}
