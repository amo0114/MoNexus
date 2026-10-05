import { CheckCircle2, XCircle, Info, AlertTriangle } from 'lucide-react'

export const FEEDBACK_TONES = {
  success: { token: 'var(--color-toast-success)', label: '成功', icon: CheckCircle2 },
  error: { token: 'var(--color-toast-error)', label: '错误', icon: XCircle },
  info: { token: 'var(--color-toast-info)', label: '提示', icon: Info },
  warning: { token: 'var(--color-toast-warning)', label: '注意', icon: AlertTriangle },
} as const

export default function FeedbackIcon({ tone, className = 'w-4 h-4 shrink-0' }: {
  tone: keyof typeof FEEDBACK_TONES
  className?: string
}) {
  const { icon: Icon, token } = FEEDBACK_TONES[tone]
  return <Icon aria-hidden="true" className={className} style={{ color: token }} />
}
