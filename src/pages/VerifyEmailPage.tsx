import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Loader2, CheckCircle2, XCircle } from 'lucide-react'
import { verifyEmail } from '../api/auth'
import { getApiErrorMessage } from '../api/error'

type Status = 'pending' | 'success' | 'error'

export default function VerifyEmailPage() {
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const [status, setStatus] = useState<Status>('pending')
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    const token = search.get('token')
    if (!token) {
      setStatus('error')
      setErrorMsg('链接无效，缺少验证令牌')
      return
    }
    verifyEmail(token)
      .then(() => {
        setStatus('success')
        setTimeout(() => navigate('/profile'), 2500)
      })
      .catch((err) => {
        setStatus('error')
        setErrorMsg(getApiErrorMessage(err, '验证失败，链接可能已失效'))
      })
  }, [search, navigate])

  return (
    <div className="fixed inset-0 bg-[var(--c-bg-app)] z-[60] flex items-center justify-center fade-in">
      <div className="apple-card w-full max-w-md p-10 mx-4 text-center bg-[var(--c-bg-card)]/90 backdrop-blur-xl shadow-2xl">
        {status === 'pending' && (
          <>
            <div className="w-16 h-16 rounded-full bg-[var(--c-accent)]/10 flex items-center justify-center mx-auto mb-4">
              <Loader2 className="w-8 h-8 text-[var(--c-accent)] animate-spin" />
            </div>
            <h2 className="text-xl font-bold text-[var(--c-text-main)] mb-2">正在验证邮箱…</h2>
          </>
        )}
        {status === 'success' && (
          <>
            <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-8 h-8 text-green-600" />
            </div>
            <h2 className="text-2xl font-bold text-[var(--c-text-main)] mb-2">邮箱已验证</h2>
            <p className="text-sm text-[var(--c-text-sub)]">即将跳转到个人中心...</p>
          </>
        )}
        {status === 'error' && (
          <>
            <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
              <XCircle className="w-8 h-8 text-red-600" />
            </div>
            <h2 className="text-2xl font-bold text-[var(--c-text-main)] mb-2">验证失败</h2>
            <p className="text-sm text-[var(--c-text-sub)] mb-6">{errorMsg}</p>
            <button
              onClick={() => navigate('/login')}
              className="btn-primary px-6 py-3 rounded-xl text-sm"
            >
              返回登录
            </button>
          </>
        )}
      </div>
    </div>
  )
}
