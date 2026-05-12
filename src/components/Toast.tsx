import { useAppStore } from '../stores/appStore'
import { CheckCircle2, AlertCircle } from 'lucide-react'

export default function Toast() {
  const toasts = useAppStore((s) => s.toasts)

  return (
    <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-[80] flex flex-col gap-3 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast-enter ${
            t.type === 'success'
              ? 'bg-[var(--color-text)] text-[var(--color-background)] border-[var(--color-border)]'
              : 'bg-red-500 text-white border-red-400'
          } px-5 py-3 rounded-lg shadow-xl flex items-center gap-2 font-semibold pointer-events-auto z-[90] relative text-sm border`}
        >
          {t.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4" />
          ) : (
            <AlertCircle className="w-4 h-4" />
          )}
          {t.message}
        </div>
      ))}
    </div>
  )
}
