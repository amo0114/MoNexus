import { Coins } from 'lucide-react'
import { PRODUCT_VISIBILITY, type ProductVisibility } from '../../../../types/catalog'
import type { DeliveryMode } from '../../../../types/merchant'
import { DEFAULT_OFFER_NAME } from './wizardStepTypes'

interface Props {
  name: string
  categoryLabel: string | null
  /** Registry label when loaded, else the raw key, else null. */
  templateName: string | null
  visibility: ProductVisibility
  price: string
  deliveryMode: DeliveryMode
  primaryOfferName: string
  extraOfferCount: number
  /** Parent-owned sanitized 图文详情 HTML; null when there is nothing to preview. */
  safePreviewHtml: string
}

/**
 * 确认草稿 step (step 4): draft summary plus the buyer confirmation preview.
 *
 * Read-only projection of parent state. The sanitized preview HTML arrives as
 * a prop so DOMPurify keeps running in the parent — no raw descriptions are
 * re-sanitized here, and no save/publish affordance lives in this step.
 */
export default function DraftReviewStep({
  name,
  categoryLabel,
  templateName,
  visibility,
  price,
  deliveryMode,
  primaryOfferName,
  extraOfferCount,
  safePreviewHtml,
}: Props) {
  return (
    <div className="space-y-8" data-testid="wizard-step-confirm">
      <div>
        <h2 className="font-heading text-lg font-bold text-[var(--color-text)] mb-3">确认草稿内容</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-4 text-sm">
          <div>
            <dt className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">商品名称</dt>
            <dd className="mt-0.5 text-[var(--color-text)]" data-testid="wizard-confirm-name">{name || '（未填写）'}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">商品分类</dt>
            <dd className="mt-0.5 text-[var(--color-text)]" data-testid="wizard-confirm-category">
              {categoryLabel !== null ? `${categoryLabel}` : '（未选择）'}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">商品形态</dt>
            <dd className="mt-0.5 text-[var(--color-text)]">{templateName ?? '（未选择）'}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">浏览可见性</dt>
            <dd className="mt-0.5 text-[var(--color-text)]">
              {visibility === PRODUCT_VISIBILITY.PUBLIC ? '游客可浏览商品信息' : '仅登录后可浏览'}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">价格</dt>
            <dd className="mt-0.5 text-[var(--color-text)] font-mono" data-testid="wizard-confirm-price">{price || '0'}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">主规格</dt>
            <dd className="mt-0.5 text-[var(--color-text)]">{primaryOfferName.trim() || DEFAULT_OFFER_NAME}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">交付方式</dt>
            <dd className="mt-0.5 text-[var(--color-text)]">{deliveryMode}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">规格数</dt>
            <dd className="mt-0.5 text-[var(--color-text)]">{extraOfferCount + 1} 个</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">
          保存为草稿后不会在商店展示，可继续进入「可售量」配置与「发布」检查。兑换始终需要登录。
        </p>
      </div>

      <div>
        <h2 className="font-heading text-lg font-bold text-[var(--color-text)] mb-3">买家看到的确认弹窗</h2>
        <div className="max-w-sm mx-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-background)] p-5 pointer-events-none select-none" data-testid="buyer-preview">
          <div className="font-bold text-lg mb-1">确认兑换</div>
          <div className="bg-[var(--color-surface)] rounded-lg p-4 my-3 border border-[var(--color-border)]">
            <div className="font-bold text-sm line-clamp-1">{name || '（商品名称）'}</div>
            <div className="flex justify-between items-center text-sm mt-2 pt-2 border-t border-dashed border-[var(--color-border)]">
              <span className="text-[var(--color-text-muted)]">
                {deliveryMode === 'manual_service' ? '本次冻结积分' : '本次支付积分'}
              </span>
              <span className="font-bold text-[var(--color-cta)] flex items-center gap-1">
                <Coins className="w-4 h-4" /> {price || '0'}
              </span>
            </div>
          </div>
          <div className="flex gap-3">
            <span className="btn-secondary flex-1 px-0 text-center opacity-70">再想想</span>
            <span className="btn-cta flex-1 px-0 text-center opacity-70">确认支付</span>
          </div>
        </div>
        {safePreviewHtml && (
          <details className="mt-4">
            <summary className="text-sm text-[var(--color-text-muted)] cursor-pointer">图文详情预览</summary>
            <div className="mt-2 p-4 rounded-lg border border-[var(--color-border)] prose prose-neutral dark:prose-invert max-w-none text-sm"
              dangerouslySetInnerHTML={{ __html: safePreviewHtml }} />
          </details>
        )}
      </div>
    </div>
  )
}
