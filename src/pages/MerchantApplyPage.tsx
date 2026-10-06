import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { applyMerchant } from '../api/merchant'
import { getMe } from '../api/auth'
import { useAuthStore } from '../stores/authStore'
import { getApiErrorMessage } from '../api/error'
import { getAuthSessionContext, matchesAuthSessionContext } from '../auth/sessionContext'
import { useAppStore } from '../stores/appStore'
import { showCompletionActivity } from '../lib/completionFeedback'

export default function MerchantApplyPage() {
  const authEpoch = useAuthStore((s) => s.authEpoch)
  const userId = useAuthStore((s) => s.user?.id)
  const sessionId = useAuthStore((s) => s.sessionId)
  return <MerchantApplyContent key={`${authEpoch}:${userId}:${sessionId}`} />
}

function MerchantApplyContent() {
  const navigate = useNavigate()
  const location = useLocation()
  const setUser = useAuthStore((s) => s.setUser)
  const user = useAuthStore((s) => s.user)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactPhone, setContactPhone] = useState('')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitting = useRef(false)
  const refreshRequest = useRef(0)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const statusRef = useRef<HTMLDivElement>(null)
  const viewStatus = new URLSearchParams(location.search).get('view') === 'status'

  const refreshStatus = useCallback(async () => {
    const context = getAuthSessionContext(useAuthStore.getState())
    if (!context) return
    const request = ++refreshRequest.current
    const isCurrent = () => request === refreshRequest.current
      && matchesAuthSessionContext(context, getAuthSessionContext(useAuthStore.getState()))
    setRefreshing(true)
    setRefreshError(null)
    try {
      const latestUser = await getMe()
      if (isCurrent()) setUser(latestUser, context)
    } catch {
      if (isCurrent()) setRefreshError('暂时无法刷新申请状态，请稍后重试。')
    } finally {
      if (isCurrent()) setRefreshing(false)
    }
  }, [setUser])

  useEffect(() => {
    if (viewStatus) void refreshStatus()
  }, [viewStatus, location.key, refreshStatus])

  useEffect(() => {
    if (viewStatus && !refreshing) statusRef.current?.focus({ preventScroll: true })
  }, [viewStatus, location.key, refreshing, user?.merchant?.status])

  const statusRefresh = (
    <div className="mt-4">
      {refreshError && <p role="alert" className="text-sm text-[var(--color-danger)] mb-3">{refreshError}</p>}
      <button type="button" className="btn-secondary" disabled={refreshing || loading} onClick={() => void refreshStatus()}>
        {refreshing ? '刷新中…' : '刷新申请状态'}
      </button>
    </div>
  )

  const isPending = user?.merchant?.status === 'pending'
  const isRejected = user?.merchant?.status === 'rejected'
  const isSuspended = user?.merchant?.status === 'suspended'
  const isActive = user?.merchant?.status === 'active'

  if (isActive) {
    return (
      <div ref={statusRef} tabIndex={-1} className="max-w-xl mx-auto mt-10 text-center">
        <h2 className="font-heading text-2xl font-bold mb-4 text-[var(--color-text)]">您已经是商家了</h2>
        <button
          onClick={() => navigate('/merchant')}
          className="btn-primary"
        >
          进入商家后台
        </button>
      </div>
    )
  }

  if (isPending) {
    return (
      <div ref={statusRef} tabIndex={-1} className="card max-w-xl mx-auto mt-10 text-center">
        <h2 className="font-heading text-2xl font-bold mb-4 text-[var(--color-text)]">商家申请审核中</h2>
        <p className="text-[var(--color-text-muted)]">您的入驻申请已提交，请耐心等待平台审核。</p>
        {statusRefresh}
      </div>
    )
  }

  if (isSuspended) {
    return (
      <div ref={statusRef} tabIndex={-1} className="card max-w-xl mx-auto mt-10 text-center">
        <h2 className="font-heading text-2xl font-bold mb-4 text-[var(--color-text)]">账号已停用</h2>
        <p className="text-[var(--color-text-muted)]">您的商家账号已被停用，请联系平台管理员。</p>
        {statusRefresh}
      </div>
    )
  }

  // The register API rejects every existing application, including rejected ones.
  if (isRejected) {
    return (
      <div ref={statusRef} tabIndex={-1} className="card max-w-xl mx-auto mt-10 text-center">
        <h2 className="font-heading text-2xl font-bold mb-4 text-[var(--color-text)]">商家申请未通过</h2>
        <p className="text-[var(--color-text-muted)]">如需进一步处理，请联系平台管理员。</p>
        {statusRefresh}
      </div>
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const requestContext = getAuthSessionContext(useAuthStore.getState())
    if (!requestContext || submitting.current || refreshing) return
    const isCurrent = () => matchesAuthSessionContext(requestContext, getAuthSessionContext(useAuthStore.getState()))
    submitting.current = true
    setLoading(true)
    setError(null)

    try {
      const result = await applyMerchant({
        name: name.trim(),
        description: description || undefined,
        contactEmail: contactEmail || undefined,
        contactPhone: contactPhone || undefined
      })
      if (!isCurrent()) return
      if (result.userId !== requestContext.userId || result.status !== 'pending') {
        setError('申请结果待确认，请刷新申请状态后查看。')
        await refreshStatus()
        return
      }
      // Commit the confirmed application before refreshing the full account.
      // A failed read must not invite a second write or erase the successful result.
      const currentUser = useAuthStore.getState().user!
      setUser({ ...currentUser, merchant: {
        id: result.id, name: result.name, status: result.status, commissionRate: result.commissionRate,
      } }, requestContext)
      if (window.matchMedia('(max-width: 767px)').matches && useAppStore.getState().islandNoticeAvailable) {
        showCompletionActivity({
          title: '入驻申请已提交，待审核',
          subtitle: result.name,
          groupKey: `merchant-application:${result.id}`,
          actionLabel: '查看申请状态',
          onAction: () => navigate('/merchant/apply?view=status'),
        })
      }
      await refreshStatus()
    } catch (err: unknown) {
      if (isCurrent()) {
        setError(getApiErrorMessage(err, '入驻申请失败'))
      }
    } finally {
      submitting.current = false
      if (isCurrent()) setLoading(false)
    }
  }

  return (
    <div ref={statusRef} tabIndex={-1} className="max-w-xl mx-auto mt-10">
      <h2 className="font-heading text-2xl font-bold mb-6 text-[var(--color-text)]">商家入驻申请</h2>
      {(viewStatus || refreshError || error) && statusRefresh}
      <form onSubmit={handleSubmit} className="card flex flex-col gap-5">
        {error && (
          <div role="alert" className="text-[var(--color-danger)] text-sm p-3 bg-[var(--color-danger)]/10 rounded-lg border border-[var(--color-danger)]/20">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="merchant-apply-name" className="block text-sm font-medium mb-1.5 text-[var(--color-text)]">
            商家名称 <span className="text-[var(--color-danger)]">*</span>
          </label>
          <input
            id="merchant-apply-name"
            type="text"
            required
            maxLength={100}
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="请输入商家名称"
          />
        </div>

        <div>
          <label htmlFor="merchant-apply-description" className="block text-sm font-medium mb-1.5 text-[var(--color-text)]">商家简介</label>
          <textarea
            id="merchant-apply-description"
            className="input min-h-[100px] resize-y"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="介绍一下您的商店"
          />
        </div>

        <div>
          <label htmlFor="merchant-apply-email" className="block text-sm font-medium mb-1.5 text-[var(--color-text)]">联系邮箱</label>
          <input
            id="merchant-apply-email"
            type="email"
            className="input"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="方便平台联系您的邮箱"
          />
        </div>

        <div>
          <label htmlFor="merchant-apply-phone" className="block text-sm font-medium mb-1.5 text-[var(--color-text)]">联系电话</label>
          <input
            id="merchant-apply-phone"
            type="text"
            className="input"
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            placeholder="方便平台联系您的电话"
          />
        </div>

        <button
          type="submit"
          disabled={loading || refreshing || !name.trim()}
          className="btn-primary mt-2"
        >
          {loading ? '提交中...' : '提交入驻申请'}
        </button>
      </form>
    </div>
  )
}
