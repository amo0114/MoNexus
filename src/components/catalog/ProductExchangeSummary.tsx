import type { Product } from '../../pages/ProductDetailPage'

export default function ProductExchangeSummary({
  offer,
  stockTitle,
  stockLabel,
  shortfall = 0,
}: {
  offer?: NonNullable<Product['offers']>[number]
  stockTitle: string
  stockLabel: string
  shortfall?: number
}) {
  const delivery = offer?.autoProvision
    ? '商家自动开通'
    : offer?.deliveryMode === 'manual_service'
      ? '人工服务交付'
      : offer?.deliveryMode === 'instant_fixed'
        ? '凭据直出'
        : offer?.deliveryMode === 'instant_inventory'
          ? '自动发货'
          : '以套餐交付说明为准'
  const stock =
    stockTitle === '剩余名额' ? '外部剩余名额' : offer?.stockMode === 'unlimited' ? '库存不限' : '现货库存'
  const period = offer?.validityDays != null ? `有效期 ${offer.validityDays} 天` : null
  return (
    <div className="my-4 space-y-2 text-xs" data-testid="product-exchange-summary">
      <div className="flex flex-wrap gap-2 text-[var(--color-text-muted)]">
        {[delivery, stock === '库存不限' ? stock : `${stock}：${stockLabel}`, period, '争议平台协助处理']
          .filter(Boolean)
          .map((label) => (
            <span
              key={label}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5"
            >
              {label}
            </span>
          ))}
      </div>
      {shortfall > 0 && (
        <p role="status" data-testid="product-points-shortfall" className="text-[var(--color-danger-text)]">
          积分不足（还差 {shortfall.toLocaleString()} 积分）
        </p>
      )}
    </div>
  )
}
