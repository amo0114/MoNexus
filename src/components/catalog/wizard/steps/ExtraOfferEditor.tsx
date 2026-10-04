import { Trash2 } from 'lucide-react'
import type { ProductTemplateDefinition } from '../../../../types/catalog'
import type { DeliveryMode, StockMode } from '../../../../types/merchant'
import StructuredContentEditor from '../StructuredContentEditor'
import DeliveryFieldsEditor from '../DeliveryFieldsEditor'
import TemplateAttributeFields from '../../TemplateAttributeFields'
import FieldLabel from '../FieldLabel'
import type { ExtraOffer, FixedContentType, StructuredRequirement } from './wizardStepTypes'

interface Props {
  index: number
  offer: ExtraOffer
  /** Registry template for the per-offer attribute block; drives both render and labels. */
  template: ProductTemplateDefinition | null
  /** Parent-resolved requirement for this offer (kept out of the step layer). */
  requirement: StructuredRequirement
  allowedFixedTypes: FixedContentType[]
  deliveryModeOptions: Array<{ value: DeliveryMode; label: string }>
  disabled?: boolean
  onChange: (patch: Partial<ExtraOffer>) => void
  /** Coercion stays in the parent (fulfillment selection policy). */
  onDeliveryModeChange: (deliveryMode: DeliveryMode) => void
  onRemove: () => void
}

/**
 * One 附加规格 row inside the pricing step.
 *
 * Holds only the row's field values plus update/remove callbacks; it never
 * saves, never coerces a delivery selection and never validates.
 */
export default function ExtraOfferEditor({
  index,
  offer,
  template,
  requirement,
  allowedFixedTypes,
  deliveryModeOptions,
  disabled,
  onChange,
  onDeliveryModeChange,
  onRemove,
}: Props) {
  const isInventory = offer.deliveryMode === 'instant_inventory'
  const isFixed = offer.deliveryMode === 'instant_fixed'
  const showStructured = requirement === 'fixed_fields'
  const showDeliveryFields = requirement === 'inventory_fields'
  const showFixedContent = isFixed && offer.fixedContentType !== 'file' && !showStructured

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-4"
      data-testid={`wizard-extra-offer-${index}`}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-bold text-[var(--color-text)]">附加规格 {index + 1}</span>
        <button type="button" aria-label="删除该规格"
          onClick={onRemove}
          className="icon-btn p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] cursor-pointer"
          data-testid={`wizard-extra-offer-remove-${index}`}>
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <FieldLabel required>规格名称</FieldLabel>
          <input type="text" maxLength={50} className="input" placeholder="如：季卡 / 256G / 美区"
            value={offer.name} onChange={(e) => onChange({ name: e.target.value })} />
        </div>
        <div>
          <FieldLabel required>售价（积分）</FieldLabel>
          <input type="number" step="1" min="1" className="input font-mono" placeholder="0"
            value={offer.price} onChange={(e) => onChange({ price: e.target.value })} />
        </div>
        <div>
          <FieldLabel>划线原价 - 可选</FieldLabel>
          <input type="number" step="1" min="1" className="input font-mono" placeholder="0"
            value={offer.originalPrice} onChange={(e) => onChange({ originalPrice: e.target.value })} />
        </div>
        <div>
          <FieldLabel>有效期（天）- 可选</FieldLabel>
          <input type="number" step="1" min="1" max="3650" className="input font-mono" placeholder="留空为永久"
            value={offer.validityDays} onChange={(e) => onChange({ validityDays: e.target.value })} />
          <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">留空为永久有效；改动仅影响新订单</p>
        </div>
        <div>
          <FieldLabel required>交付方式</FieldLabel>
          <select className="input appearance-none cursor-pointer" value={offer.deliveryMode}
            onChange={(e) => onDeliveryModeChange(e.target.value as DeliveryMode)}>
            {deliveryModeOptions.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
        {!isInventory && (
          <div>
            <FieldLabel required>名额模式</FieldLabel>
            <select className="input appearance-none cursor-pointer" value={offer.stockMode}
              onChange={(e) => onChange({ stockMode: e.target.value as StockMode })}>
              <option value="unlimited">不限量</option>
              <option value="limited">限量</option>
            </select>
          </div>
        )}
        {isFixed && allowedFixedTypes.length > 0 && (
          <div>
            <FieldLabel required>内容类型</FieldLabel>
            <select className="input appearance-none cursor-pointer" value={offer.fixedContentType}
              onChange={(e) => onChange({ fixedContentType: e.target.value as FixedContentType })}>
              {allowedFixedTypes.map(type => (
                <option key={type} value={type}>
                  {type === 'url' ? '链接' : type === 'file' ? '文件' : '文本'}
                </option>
              ))}
            </select>
          </div>
        )}
        {showFixedContent && (
          <div className="sm:col-span-2">
            <FieldLabel required>固定交付内容</FieldLabel>
            <textarea className="input min-h-[72px] resize-y" maxLength={5000}
              value={offer.fixedContent} onChange={(e) => onChange({ fixedContent: e.target.value })} />
          </div>
        )}
        {showStructured && (
          <div className="sm:col-span-2">
            <StructuredContentEditor variant="create"
              fields={offer.structuredFields}
              values={offer.structuredValues}
              onFieldsChange={(structuredFields) => onChange({ structuredFields })}
              onValuesChange={(structuredValues) => onChange({ structuredValues })}
              disabled={disabled}
              testIdPrefix={`wizard-extra-offer-${index}-structured`}
            />
          </div>
        )}
        {showDeliveryFields && (
          <div className="sm:col-span-2">
            <DeliveryFieldsEditor variant="create"
              fields={offer.deliveryFields}
              onChange={(deliveryFields) => onChange({ deliveryFields })}
              disabled={disabled}
              testIdPrefix={`wizard-extra-offer-${index}-delivery`}
            />
          </div>
        )}
        {isFixed && offer.fixedContentType === 'file' && (
          <p className="sm:col-span-2 text-xs text-[var(--color-text-muted)]">
            草稿允许暂不绑定文件；发布前再在编辑中挂载交付文件。
          </p>
        )}
        {isInventory && !showDeliveryFields && (
          <p className="sm:col-span-2 text-xs text-[var(--color-text-muted)]">
            该规格的卡密在商品创建后通过「可售量」步骤按规格导入交付库存。
          </p>
        )}
      </div>
      {template && template.ui.offerOrder.length > 0 && (
        <div className="mt-4 pt-3 border-t border-[var(--color-border)]">
          <TemplateAttributeFields
            template={template}
            target="offer"
            value={offer.attributes}
            onChange={(attributes) => onChange({ attributes })}
            disabled={disabled}
            mode="draft"
          />
        </div>
      )}
    </div>
  )
}
