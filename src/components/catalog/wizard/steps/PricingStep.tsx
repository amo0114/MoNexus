import type { ProductTemplateDefinition, TemplateAttributes } from '../../../../types/catalog'
import type { DeliveryMode } from '../../../../types/merchant'
import TemplateAttributeFields from '../../TemplateAttributeFields'
import FieldLabel from '../FieldLabel'
import ExtraOfferEditor from './ExtraOfferEditor'
import { DEFAULT_OFFER_NAME, type ExtraOffer, type FixedContentType, type StructuredRequirement } from './wizardStepTypes'

interface Props {
  primaryOfferName: string
  onPrimaryOfferNameChange: (name: string) => void
  price: string
  onPriceChange: (price: string) => void
  originalPrice: string
  onOriginalPriceChange: (originalPrice: string) => void
  validityDays: string
  onValidityDaysChange: (validityDays: string) => void
  /** Registry template owning the primary 主规格参数 block. */
  template: ProductTemplateDefinition | null
  primaryOfferAttributes: TemplateAttributes
  onPrimaryOfferAttributesChange: (attributes: TemplateAttributes) => void
  extraOffers: ExtraOffer[]
  onExtraOfferChange: (index: number, patch: Partial<ExtraOffer>) => void
  onExtraOfferDeliveryModeChange: (index: number, deliveryMode: DeliveryMode) => void
  onExtraOfferRemove: (index: number) => void
  onAddExtraOffer: () => void
  /** Parent-resolved structured requirement per offer; never recomputed here. */
  requirementFor: (offer: ExtraOffer) => StructuredRequirement
  allowedFixedTypes: FixedContentType[]
  deliveryModeOptions: Array<{ value: DeliveryMode; label: string }>
  disabled?: boolean
}

/**
 * 定价 step (step 2): primary offer fields plus the 附加规格 list.
 *
 * Owns no draft state and no persistence: every field is a controlled value
 * mirrored from the parent, and adds/removes/edits only emit callbacks.
 */
export default function PricingStep({
  primaryOfferName,
  onPrimaryOfferNameChange,
  price,
  onPriceChange,
  originalPrice,
  onOriginalPriceChange,
  validityDays,
  onValidityDaysChange,
  template,
  primaryOfferAttributes,
  onPrimaryOfferAttributesChange,
  extraOffers,
  onExtraOfferChange,
  onExtraOfferDeliveryModeChange,
  onExtraOfferRemove,
  onAddExtraOffer,
  requirementFor,
  allowedFixedTypes,
  deliveryModeOptions,
  disabled,
}: Props) {
  return (
    <div className="space-y-6">
      <div className="space-y-5 max-w-sm">
        <div>
          <FieldLabel required>主规格名称</FieldLabel>
          <input type="text" maxLength={50} className="input" placeholder={DEFAULT_OFFER_NAME}
            value={primaryOfferName} onChange={(e) => onPrimaryOfferNameChange(e.target.value)} data-testid="wizard-primary-offer-name" />
          <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
            单规格商品保持「{DEFAULT_OFFER_NAME}」即可，买家端不会显示规格选择器。
          </p>
        </div>
        <div>
          <FieldLabel required>销售价格（积分）</FieldLabel>
          <input type="number" step="1" min="1" className="input font-mono text-lg" placeholder="0"
            value={price} onChange={(e) => onPriceChange(e.target.value)} data-testid="wizard-price" />
        </div>
        <div>
          <FieldLabel>划线原价 - 可选</FieldLabel>
          <input type="number" step="1" min="1" className="input font-mono" placeholder="0"
            value={originalPrice} onChange={(e) => onOriginalPriceChange(e.target.value)} />
        </div>
        <div>
          <FieldLabel>有效期（天）- 可选</FieldLabel>
          <input type="number" step="1" min="1" max="3650" className="input font-mono" placeholder="留空为永久"
            value={validityDays} onChange={(e) => onValidityDaysChange(e.target.value)}
            data-testid="wizard-validity-days" />
          <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">留空为永久有效；改动仅影响新订单</p>
        </div>
      </div>

      {template && template.ui.offerOrder.length > 0 && (
        <div data-testid="wizard-primary-offer-attributes">
          <FieldLabel>主规格参数</FieldLabel>
          <TemplateAttributeFields
            template={template}
            target="offer"
            value={primaryOfferAttributes}
            onChange={onPrimaryOfferAttributesChange}
            disabled={disabled}
            mode="draft"
          />
        </div>
      )}

      <div className="pt-2 border-t border-[var(--color-border)]" data-testid="wizard-extra-offers">
        <div className="flex items-center justify-between mb-1">
          <FieldLabel>附加规格 - 可选</FieldLabel>
          <span className="text-xs text-[var(--color-text-muted)]">共 {extraOffers.length + 1} 个规格</span>
        </div>
        <p className="text-xs text-[var(--color-text-muted)] mb-4">
          需要「月卡／季卡」「128G／256G」这类多规格时在此追加；每个规格有独立的价格与交付方式。
          规格名额一律在保存草稿后的「可售量」步骤独立调整。
        </p>

        <div className="space-y-4">
          {extraOffers.map((offer, index) => (
            <ExtraOfferEditor
              key={index}
              index={index}
              offer={offer}
              template={template}
              requirement={requirementFor(offer)}
              allowedFixedTypes={allowedFixedTypes}
              deliveryModeOptions={deliveryModeOptions}
              disabled={disabled}
              onChange={(patch) => onExtraOfferChange(index, patch)}
              onDeliveryModeChange={(deliveryMode) => onExtraOfferDeliveryModeChange(index, deliveryMode)}
              onRemove={() => onExtraOfferRemove(index)}
            />
          ))}
        </div>

        <button type="button" onClick={onAddExtraOffer}
          className="btn-secondary w-full py-2 mt-4 text-sm" data-testid="wizard-extra-offer-add">
          + 添加规格
        </button>
      </div>
    </div>
  )
}
