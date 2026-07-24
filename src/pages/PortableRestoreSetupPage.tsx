import { FormEvent, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ShieldCheck } from 'lucide-react'
import { getApiErrorMessage } from '../api/error'
import {
  createPortableRestoreBootstrapAdmin,
  getPortableRestoreBootstrapStatus,
} from '../api/portableBackups'
import { useAppStore } from '../stores/appStore'

export default function PortableRestoreSetupPage() {
  const navigate = useNavigate()
  const showToast = useAppStore((state) => state.showToast)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [token, setToken] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    getPortableRestoreBootstrapStatus()
      .then((status) => setAvailable(status.available))
      .catch(() => setAvailable(false))
  }, [])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (password.length < 12) {
      showToast('管理员密码至少 12 个字符', 'error')
      return
    }
    setLoading(true)
    try {
      await createPortableRestoreBootstrapAdmin({ token, email, password })
      showToast('引导管理员已创建，请登录后进入数据备份与恢复')
      navigate('/login')
    } catch (err) {
      showToast(getApiErrorMessage(err, '恢复引导失败'), 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-[var(--color-background)] z-[60] flex items-center justify-center fade-in overflow-y-auto py-8">
      <form onSubmit={handleSubmit} className="card w-full max-w-md p-8 mx-4 space-y-5">
        <div className="text-center">
          <ShieldCheck className="w-9 h-9 text-[var(--color-primary)] mx-auto mb-3" />
          <h1 className="font-heading text-2xl font-bold text-[var(--color-text)]">恢复引导</h1>
          <p className="text-sm text-[var(--color-text-muted)] mt-2">
            仅用于全新实例导入可移植备份。创建后请登录管理后台完成导入。
          </p>
        </div>

        {available === null && <p className="text-sm text-[var(--color-text-muted)] text-center">正在检查恢复引导状态…</p>}
        {available === false && (
          <div className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 text-[var(--color-danger)] text-sm p-3">
            恢复引导不可用：实例已有用户，或未在环境变量中配置恢复引导令牌。
          </div>
        )}
        {available && (
          <div className="space-y-4">
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="恢复引导令牌"
              autoComplete="off"
              required
              className="input w-full"
            />
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="引导管理员邮箱"
              autoComplete="email"
              required
              className="input w-full"
            />
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="管理员密码（至少 12 位）"
              autoComplete="new-password"
              required
              minLength={12}
              className="input w-full"
            />
            <button type="submit" disabled={loading} className="btn-primary w-full disabled:opacity-50">
              {loading ? '创建中…' : '创建引导管理员'}
            </button>
          </div>
        )}

        <div className="text-center text-sm">
          <Link to="/login" className="text-[var(--color-primary)] hover:underline">返回登录</Link>
        </div>
      </form>
    </div>
  )
}
