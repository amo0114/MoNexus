import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  Copy,
  Headphones,
  HelpCircle,
  Mail,
  ShieldCheck,
  Store,
  X,
  Zap,
} from 'lucide-react'
import { useAppStore } from '../../stores/appStore'

export interface MerchantSupportModalProps {
  open: boolean
  onClose: () => void
  merchantName?: string | null
  productId?: number
  onNavigateToFaq?: () => void
}

export default function MerchantSupportModal({
  open,
  onClose,
  merchantName,
  productId,
  onNavigateToFaq,
}: MerchantSupportModalProps) {
  const showToast = useAppStore((s) => s.showToast)
  const [copied, setCopied] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)

  const isPlatformOwned = !merchantName || merchantName === 'MoNexus 自营' || merchantName === '平台自营'
  const displayName = merchantName || 'MoNexus 官方自营'
  const supportEmail = 'support@monexus.io'

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  const handleCopyEmail = async () => {
    try {
      await navigator.clipboard.writeText(supportEmail)
      setCopied(true)
      showToast('客服邮箱已复制到剪贴板', 'success')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      showToast(`请手动复制客服邮箱：${supportEmail}`, 'info')
    }
  }

  const handleFaqClick = () => {
    onClose()
    if (onNavigateToFaq) {
      onNavigateToFaq()
    } else {
      const el = document.getElementById('product-section-faq')
      if (el) {
        el.scrollIntoView({ behavior: 'smooth' })
      }
    }
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="merchant-support-title"
      data-testid="merchant-support-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal Dialog Card */}
      <div
        ref={modalRef}
        className="relative z-10 w-full max-w-md rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-[var(--color-primary-tint)] border border-[var(--color-primary-border-subtle)] flex items-center justify-center text-[var(--color-primary)] shrink-0">
              <Headphones className="w-5 h-5" />
            </div>
            <div>
              <h3 id="merchant-support-title" className="text-base font-bold text-[var(--color-text)]">
                服务支持与客服
              </h3>
              <p className="text-xs text-[var(--color-text-muted)]">
                服务时间：周一至周日 09:00 - 23:00
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭窗口"
            className="w-8 h-8 rounded-full flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-background)] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-4 sm:p-5 space-y-4">
          {/* Merchant Profile Banner */}
          <div className="p-3.5 rounded-xl bg-[var(--color-background)] border border-[var(--color-border)] flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] flex items-center justify-center text-[var(--color-primary)] font-bold text-base shrink-0 shadow-2xs">
                <Store className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="font-bold text-sm text-[var(--color-text)]">{displayName}</span>
                  <span
                    className={
                      isPlatformOwned
                        ? 'px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30'
                        : 'px-1.5 py-0.5 rounded text-[10px] font-bold bg-[var(--color-primary-tint)] text-[var(--color-primary)] border border-[var(--color-primary-border-subtle)]'
                    }
                  >
                    {isPlatformOwned ? '官方自营' : '认证商家'}
                  </span>
                </div>
                <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                  {isPlatformOwned ? '平台直营履约，极速自动开通交付' : '平台实名认证入驻商户，质保无忧'}
                </p>
              </div>
            </div>
          </div>

          {/* Service Promises (Truthful Platform Fulfillment) */}
          <div className="space-y-2">
            <span className="text-xs font-bold text-[var(--color-text)] block">
              履约保障与售后指引
            </span>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="p-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] flex items-start gap-2">
                <Zap className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold text-[var(--color-text)]">自动履约交付</div>
                  <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                    兑换后系统即时发放卡密或配置，可在订单中随时查看
                  </div>
                </div>
              </div>
              <div className="p-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] flex items-start gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold text-[var(--color-text)]">平台协助售后</div>
                  <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                    平台协助售后与争议处理，保障正常交付与权益
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Contact Channels */}
          <div className="space-y-2">
            <span className="text-xs font-bold text-[var(--color-text)] block">
              联系客服渠道
            </span>
            <div className="p-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <Mail className="w-4 h-4 text-[var(--color-primary)] shrink-0" />
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-[var(--color-text)]">官方服务邮箱</div>
                  <div className="text-xs font-mono text-[var(--color-text-muted)] truncate select-all">
                    {supportEmail}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={handleCopyEmail}
                className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--color-border)] hover:border-[var(--color-primary)] bg-[var(--color-background)] text-[var(--color-text)] hover:text-[var(--color-primary)] transition-colors flex items-center gap-1 cursor-pointer"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? '已复制' : '复制邮箱'}</span>
              </button>
            </div>
          </div>

          {/* Order Help & FAQ Link */}
          <div className="p-3 rounded-xl bg-[var(--color-background)] border border-[var(--color-border)] text-xs space-y-1.5">
            <div className="flex items-center justify-between text-[var(--color-text)]">
              <span className="font-semibold">遇到问题需要指引？</span>
              <button
                type="button"
                onClick={handleFaqClick}
                className="text-[var(--color-primary)] hover:underline inline-flex items-center gap-1 font-medium cursor-pointer"
              >
                <HelpCircle className="w-3.5 h-3.5" />
                <span>查看商品 FAQ</span>
              </button>
            </div>
            <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
              兑换成功后可在「个人中心 → 我的订单」查看完整卡密与凭据；平台协助售后与争议处理，不另作先行垫付承诺。
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 bg-[var(--color-background)] border-t border-[var(--color-border)] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="w-full sm:w-auto px-6 py-2 rounded-xl text-xs font-bold btn-cta cursor-pointer"
          >
            我知道了
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
