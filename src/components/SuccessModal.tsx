import { Check, Copy } from 'lucide-react'
import { useAppStore } from '../stores/appStore'

export default function SuccessModal({
  deliveryContent,
  merchantName,
  onClose,
}: {
  deliveryContent: string
  merchantName?: string
  onClose: () => void
}) {
  const showToast = useAppStore((s) => s.showToast)

  function copyAndClose() {
    navigator.clipboard.writeText(deliveryContent).catch(() => {})
    showToast('发货信息已复制')
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="apple-card w-full max-w-sm p-8 mx-4 text-center relative z-10 fade-in">
        <div className="w-16 h-16 bg-[var(--c-bg-app)] border-2 border-[var(--c-accent)] text-[var(--c-accent)] rounded-full flex items-center justify-center mx-auto mb-5 shadow-sm">
          <Check className="w-8 h-8" />
        </div>
        <h3 className="text-2xl font-bold mb-2 text-[var(--c-text-main)]">兑换成功</h3>
        <p className="text-[var(--c-text-sub)] mb-6 text-sm font-medium">商品已下发，请查收下方信息</p>

        {merchantName && (
          <div className="text-sm text-[var(--c-text-sub)] mb-4 bg-blue-50 dark:bg-blue-900/20 p-2 rounded-lg border border-blue-100 dark:border-blue-900/30">
            本商品由商家 <span className="font-bold text-blue-600 dark:text-blue-400">{merchantName}</span> 提供
          </div>
        )}

        <div className="bg-[var(--c-bg-app)] rounded-2xl p-4 mb-6 border border-[var(--c-border-light)] text-left">
          <p className="text-[10px] text-[var(--c-text-sub)] mb-2 font-bold">提卡内容区</p>
          <div className="font-mono text-sm break-all text-[var(--c-text-main)] select-all bg-[var(--c-bg-card)] p-3 rounded-xl border border-[var(--c-border-faint)] shadow-sm leading-relaxed whitespace-pre-wrap">
            {deliveryContent}
          </div>
        </div>

        <button
          onClick={copyAndClose}
          className="w-full bg-[var(--c-text-main)] text-[var(--c-bg-app)] py-3.5 rounded-2xl text-base font-bold shadow-md flex justify-center items-center gap-2 hover:bg-[var(--c-text-sub)] transition-all"
        >
          <Copy className="w-4 h-4" /> 复制发货信息并关闭
        </button>
      </div>
    </div>
  )
}
