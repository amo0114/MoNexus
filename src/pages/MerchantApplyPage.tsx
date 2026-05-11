import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { applyMerchant } from '../api/merchant'
import { getMe } from '../api/auth'
import { useAuthStore } from '../stores/authStore'
import { getApiErrorMessage } from '../api/error'

export default function MerchantApplyPage() {
  const navigate = useNavigate()
  const setUser = useAuthStore((s) => s.setUser)
  const user = useAuthStore((s) => s.user)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactPhone, setContactPhone] = useState('')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isPending = user?.merchant?.status === 'pending'
  const isRejected = user?.merchant?.status === 'rejected'
  const isSuspended = user?.merchant?.status === 'suspended'
  const isActive = user?.merchant?.status === 'active'

  if (isActive) {
    return (
      <div className="max-w-xl mx-auto mt-10 text-center">
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
      <div className="card max-w-xl mx-auto mt-10 text-center p-8">
        <h2 className="font-heading text-2xl font-bold mb-4 text-[var(--color-text)]">商家申请审核中</h2>
        <p className="text-[var(--color-text-muted)]">您的入驻申请已提交，请耐心等待平台审核。</p>
      </div>
    )
  }

  if (isSuspended) {
    return (
      <div className="card max-w-xl mx-auto mt-10 text-center p-8">
        <h2 className="font-heading text-2xl font-bold mb-4 text-[var(--color-text)]">账号已停用</h2>
        <p className="text-[var(--color-text-muted)]">您的商家账号已被停用，请联系平台管理员。</p>
      </div>
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      await applyMerchant({
        name,
        description: description || undefined,
        contactEmail: contactEmail || undefined,
        contactPhone: contactPhone || undefined
      })
      const latestUser = await getMe()
      setUser(latestUser)
    } catch (err: any) {
      setError(getApiErrorMessage(err, '入驻申请失败'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-xl mx-auto mt-10">
      <h2 className="font-heading text-2xl font-bold mb-6 text-[var(--color-text)]">商家入驻申请</h2>
      {isRejected && (
        <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg border border-red-200 dark:border-red-900/30 text-sm">
          您的上次申请被拒绝，您可以重新提交申请。
        </div>
      )}
      <form onSubmit={handleSubmit} className="card flex flex-col gap-5">
        {error && (
          <div className="text-red-600 dark:text-red-400 text-sm p-3 bg-red-50 dark:bg-red-900/10 rounded-lg border border-red-200 dark:border-red-900/20">
            {error}
          </div>
        )}

        <div>
          <label className="block text-sm font-medium mb-1.5 text-[var(--color-text)]">
            商家名称 <span className="text-red-500">*</span>
          </label>
          <input
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
          <label className="block text-sm font-medium mb-1.5 text-[var(--color-text)]">商家简介</label>
          <textarea
            className="input min-h-[100px] resize-y"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="介绍一下您的商店"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5 text-[var(--color-text)]">联系邮箱</label>
          <input
            type="email"
            className="input"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="方便平台联系您的邮箱"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5 text-[var(--color-text)]">联系电话</label>
          <input
            type="text"
            className="input"
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            placeholder="方便平台联系您的电话"
          />
        </div>

        <button
          type="submit"
          disabled={loading || !name.trim()}
          className="btn-primary mt-2"
        >
          {loading ? '提交中...' : '提交入驻申请'}
        </button>
      </form>
    </div>
  )
}
