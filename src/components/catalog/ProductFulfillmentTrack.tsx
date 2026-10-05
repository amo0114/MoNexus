import { CheckCircle2, CreditCard, KeyRound, Sparkles } from 'lucide-react'
import type { Product } from '../../pages/ProductDetailPage'

interface ProductFulfillmentTrackProps {
  offer?: NonNullable<Product['offers']>[number]
  preview?: boolean
}

export default function ProductFulfillmentTrack({
  offer,
  preview = false,
}: ProductFulfillmentTrackProps) {
  const deliveryText = offer?.autoProvision
    ? '系统自动开通服务'
    : offer?.deliveryMode === 'instant_fixed' || offer?.deliveryMode === 'instant_inventory'
      ? '卡密/凭据秒级直出'
      : offer?.deliveryMode === 'manual_service'
        ? '商家专员协助交付'
        : '按套餐交付规范履约'

  const steps = [
    {
      num: '01',
      title: '选定套餐',
      desc: offer?.name ? `当前：${offer.name}` : '选择适配的规格时长',
      icon: Sparkles,
    },
    {
      num: '02',
      title: preview ? '快捷结算' : '积分兑换',
      desc: preview ? '支持主流在线支付' : '确认密码即可秒级划扣',
      icon: CreditCard,
    },
    {
      num: '03',
      title: '自动履约',
      desc: deliveryText,
      icon: KeyRound,
    },
    {
      num: '04',
      title: '即刻体验',
      desc: '在订单中心提取凭据并查阅配置指引',
      icon: CheckCircle2,
    },
  ]

  return (
    <div className="product-fulfillment-track my-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4 pb-2 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <span className="flex h-2 w-2 rounded-full bg-[var(--color-primary)] animate-pulse" />
          <h4 className="text-sm font-semibold text-[var(--color-text)]">数字化履约流程</h4>
        </div>
        <span className="text-xs text-[var(--color-text-muted)]">全流程自动化保障</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {steps.map((step, idx) => {
          const Icon = step.icon
          return (
            <div
              key={step.num}
              className="relative flex flex-col justify-between p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] hover:border-[var(--color-primary-border-subtle)] transition-all duration-200"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-mono font-bold text-[var(--color-primary)] px-1.5 py-0.5 rounded bg-[var(--color-primary-tint)]">
                  STEP {step.num}
                </span>
                <Icon size={16} className="text-[var(--color-text-muted)]" />
              </div>
              <div>
                <p className="text-sm font-semibold text-[var(--color-text)]">{step.title}</p>
                <p className="text-xs text-[var(--color-text-muted)] mt-1 line-clamp-2 leading-relaxed">
                  {step.desc}
                </p>
              </div>
              {idx < steps.length - 1 && (
                <div
                  className="hidden lg:block absolute -right-2 top-1/2 -translate-y-1/2 z-10 text-[var(--color-border)]"
                  aria-hidden="true"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
