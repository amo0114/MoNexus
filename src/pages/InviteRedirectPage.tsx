import { useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'

export default function InviteRedirectPage() {
  const { code } = useParams<{ code: string }>()
  const navigate = useNavigate()

  useEffect(() => {
    if (code) {
      navigate(`/login?invite=${encodeURIComponent(code)}`)
    } else {
      navigate('/login')
    }
  }, [code, navigate])

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-background)]">
      <p className="text-[var(--color-text-muted)]">正在跳转...</p>
    </div>
  )
}
