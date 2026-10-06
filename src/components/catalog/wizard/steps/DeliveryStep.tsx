import type { DeliveryField, DeliveryMode, StockMode } from '../../../../types/merchant'
import DeliveryFieldsEditor from '../DeliveryFieldsEditor'
import StructuredContentEditor from '../StructuredContentEditor'
import FieldLabel from '../FieldLabel'
import type { FixedContentType, StructuredRequirement } from './wizardStepTypes'

interface Props {
  deliveryMode: DeliveryMode
  /** Parent-owned coercion; the step only reports the chosen mode. */
  onDeliveryModeChange: (deliveryMode: DeliveryMode) => void
  /** Parent-resolved requirement for the primary offer; never recomputed here. */
  requirement: StructuredRequirement
  allowedFixedTypes: FixedContentType[]
  deliveryModeOptions: Array<{ value: DeliveryMode; label: string }>
  deliveryFields: DeliveryField[]
  onDeliveryFieldsChange: (fields: DeliveryField[]) => void
  structuredFields: DeliveryField[]
  structuredValues: Record<string, string>
  onStructuredFieldsChange: (fields: DeliveryField[]) => void
  onStructuredValuesChange: (values: Record<string, string>) => void
  fixedContentType: FixedContentType
  onFixedContentTypeChange: (type: FixedContentType) => void
  fixedContent: string
  onFixedContentChange: (content: string) => void
  stockMode: StockMode
  onStockModeChange: (stockMode: StockMode) => void
  /** Label set switches on manual_service; owned by the parent. */
  availabilityLabels: { mode: string; unlimited: string; limited: string }
  disabled?: boolean
}

/**
 * 交付方式 step (step 3) for the primary offer.
 *
 * Holds only the primary offer's controlled values; fulfillment coercion and
 * every validation live in the parent, so this component stays presentational.
 */
export default function DeliveryStep({
  deliveryMode,
  onDeliveryModeChange,
  requirement,
  allowedFixedTypes,
  deliveryModeOptions,
  deliveryFields,
  onDeliveryFieldsChange,
  structuredFields,
  structuredValues,
  onStructuredFieldsChange,
  onStructuredValuesChange,
  fixedContentType,
  onFixedContentTypeChange,
  fixedContent,
  onFixedContentChange,
  stockMode,
  onStockModeChange,
  availabilityLabels,
  disabled,
}: Props) {
  return (
    <div className="space-y-5">
      <div>
        <FieldLabel required>交付方式</FieldLabel>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {deliveryModeOptions.map(mode => (
            <label key={mode.value}
              className={`flex items-center gap-2 p-3 rounded-lg border cursor-pointer text-sm ${
                deliveryMode === mode.value
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/8'
                  : 'border-[var(--color-border)]'
              }`}>
              <input type="radio" name="wizardDeliveryMode" value={mode.value}
                checked={deliveryMode === mode.value}
                onChange={(e) => onDeliveryModeChange(e.target.value as DeliveryMode)}
                className="w-4 h-4" />
              {mode.label}
            </label>
          ))}
        </div>
      </div>

      {deliveryMode === 'instant_inventory' && (
        <div className="rounded-lg border border-[var(--color-primary)]/20 bg-[var(--color-primary)]/8 px-4 py-3 text-xs text-[var(--color-text-muted)]">
          即时库存商品按「一个交付单元对应一位买家」管理。保存草稿后请在「可售量」步骤为每个规格导入账号、卡密、邀请码等独立交付内容。
        </div>
      )}

      {requirement === 'inventory_fields' && (
        <DeliveryFieldsEditor variant="create"
          fields={deliveryFields}
          onChange={onDeliveryFieldsChange}
          disabled={disabled}
          testIdPrefix="wizard-delivery"
        />
      )}

      {deliveryMode === 'instant_fixed' && (
        <div className="space-y-4 border-t border-[var(--color-border)] pt-4">
          {allowedFixedTypes.length > 0 && requirement !== 'fixed_fields' && (
            <div>
              <FieldLabel required>交付内容类型</FieldLabel>
              <div className="flex gap-4 items-center flex-wrap">
                {allowedFixedTypes.map(value => (
                  <label key={value} className="flex items-center gap-2 cursor-pointer text-sm">
                    <input type="radio" name="wizardFixedContentType" value={value}
                      checked={fixedContentType === value}
                      onChange={() => onFixedContentTypeChange(value)}
                      className="w-4 h-4" />
                    {value === 'url' ? '外部链接' : value === 'file' ? '文件' : '固定文本'}
                  </label>
                ))}
              </div>
            </div>
          )}
          {fixedContentType === 'file' ? (
            <p className="text-xs text-[var(--color-text-muted)]">
              草稿允许暂不绑定文件；发布前再在编辑中挂载交付文件。
            </p>
          ) : requirement === 'fixed_fields' ? (
            <StructuredContentEditor variant="create"
              fields={structuredFields}
              values={structuredValues}
              onFieldsChange={onStructuredFieldsChange}
              onValuesChange={onStructuredValuesChange}
              disabled={disabled}
              testIdPrefix="wizard-structured"
            />
          ) : (
            <div>
              <FieldLabel required>交付内容（每位买家收到同一份）</FieldLabel>
              {fixedContentType === 'url' ? (
                <input type="url" className="input font-mono" placeholder="https://example.com/invite"
                  value={fixedContent} onChange={(e) => onFixedContentChange(e.target.value)}
                  data-testid="fixed-content-input" />
              ) : (
                <textarea className="input min-h-[80px] resize-y font-mono"
                  placeholder="买家付款后立即收到的内容..."
                  value={fixedContent} onChange={(e) => onFixedContentChange(e.target.value)}
                  data-testid="fixed-content-input" />
              )}
            </div>
          )}
        </div>
      )}

      {deliveryMode !== 'instant_inventory' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div>
            <FieldLabel required>{availabilityLabels.mode}</FieldLabel>
            <select className="input appearance-none cursor-pointer" value={stockMode}
              onChange={(e) => onStockModeChange(e.target.value as StockMode)} data-testid="stock-mode-select">
              <option value="unlimited">{availabilityLabels.unlimited}</option>
              <option value="limited">{availabilityLabels.limited}</option>
            </select>
          </div>
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-2.5 flex items-center">
            <p className="text-xs text-[var(--color-text-muted)]" data-testid="wizard-initial-stock-hint">
              新草稿初始名额为 0；保存草稿后可在「可售量」步骤独立调整。
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
