import { Link } from 'react-router-dom'
import { Lock } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { hasMerchantCapability, isMerchantReadOnly } from '../../auth/merchantAccess'

/** Explains a suspended merchant's read-only state instead of bouncing them out. */
export default function MerchantReadOnlyBanner() {
  const user = useAuthStore((s) => s.user)
  if (!isMerchantReadOnly(user)) return null
  const canHandleExisting = hasMerchantCapability(user, 'orders.existing.write')
  return (
    <div
      role="status"
      data-testid="merchant-readonly-banner"
      className="mb-4 flex gap-3 rounded-xl border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] p-3.5"
    >
      <Lock aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" />
      <div className="text-sm">
        <div className="font-semibold text-[var(--color-text)]">商家经营已停用，当前为只读</div>
        <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
          你仍可查看历史订单与结算，但不能发布商品或接新单。
          {canHandleExisting ? '已有订单可按要求继续处理。' : '已有订单由平台接管处理。'}
          {' '}
          <Link to="/merchant/apply?view=status" className="font-semibold text-[var(--color-primary)] hover:underline">查看停用说明</Link>
        </p>
      </div>
    </div>
  )
}
