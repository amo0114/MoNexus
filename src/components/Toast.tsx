import { useEffect, useState } from 'react'
import { CheckCircle2, XCircle, Info, AlertTriangle, X } from 'lucide-react'
import { useAppStore, type Toast as ToastItem } from '../stores/appStore'

// Solid deep-tone bars with white text — every pair meets WCAG 4.5:1+
// for 14px body text in all three themes (the previous token-based
// pairs measured 1.5–4.2:1 in the review).
const TONE: Record<ToastItem['type'], { bar: string; icon: typeof CheckCircle2 }> = {
  success: {
    bar: 'bg-[#15803D] text-white border-[#15803D]', // green-800, white ≈ 5.5:1
    icon: CheckCircle2,
  },
  error: {
    bar: 'bg-[#B91C1C] text-white border-[#B91C1C]', // red-700, white ≈ 5.9:1
    icon: XCircle,
  },
  info: {
    bar: 'bg-[#1D4ED8] text-white border-[#1D4ED8]', // blue-700, white ≈ 6.4:1
    icon: Info,
  },
  warning: {
    bar: 'bg-[#B45309] text-white border-[#B45309]', // amber-700, white ≈ 5.8:1
    icon: AlertTriangle,
  },
}

function ToastCard({ toast }: { toast: ToastItem }) {
  const removeToast = useAppStore((s) => s.removeToast)
  const [leaving, setLeaving] = useState(false)

  // Auto-dismiss: errors linger longer (they carry failure detail).
  useEffect(() => {
    const duration = toast.type === 'error' ? 4500 : 3000
    const timer = setTimeout(() => setLeaving(true), duration)
    return () => clearTimeout(timer)
  }, [toast.id, toast.type])

  // Play the exit animation before actually removing from the store.
  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(() => removeToast(toast.id), 200)
    return () => clearTimeout(timer)
  }, [leaving, toast.id, removeToast])

  const { bar, icon: Icon } = TONE[toast.type]

  return (
    <div
      role="status"
      className={`${leaving ? 'toast-exit' : 'toast-enter'} ${bar} px-5 py-3 rounded-lg shadow-xl flex items-center gap-2 font-semibold pointer-events-auto z-[90] relative text-sm border max-w-[calc(100vw-2rem)]`}
    >
      <Icon className="w-4 h-4 shrink-0" />
      <span className="break-words">{toast.message}</span>
      <button
        type="button"
        onClick={() => setLeaving(true)}
        aria-label="关闭提示"
        className="icon-btn ml-1 -mr-1 p-1 rounded-md opacity-70 hover:opacity-100 hover:bg-white/15 transition-opacity cursor-pointer shrink-0"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

export default function Toast() {
  const toasts = useAppStore((s) => s.toasts)

  return (
    <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-[80] flex flex-col gap-3 pointer-events-none items-center">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  )
}
