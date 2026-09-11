import { Plus, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import {
  TEMPLATE_WIDGETS,
  type ProductTemplateDefinition,
  type TemplateAttributes,
  type TemplateWidget,
} from '../../types/catalog'

export type TemplateAttributeTarget = 'product' | 'offer'
export type TemplateAttributeMode = 'draft' | 'publish'

export type TemplateAttributeFieldsProps = {
  template: ProductTemplateDefinition
  target: TemplateAttributeTarget
  value: TemplateAttributes
  onChange: (next: TemplateAttributes) => void
  disabled?: boolean
  /** draft: missing required allowed; still reject wrong types in the control */
  mode?: TemplateAttributeMode
}

const WIDGET_SET: ReadonlySet<string> = new Set(TEMPLATE_WIDGETS)

type SchemaProperty = {
  title?: string
  description?: string
  enumValues: Array<string | number>
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  itemMaxLength?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readSchema(schema: Record<string, unknown>): {
  properties: Record<string, SchemaProperty>
  required: Set<string>
} {
  const properties: Record<string, SchemaProperty> = {}
  const rawProps = isRecord(schema.properties) ? schema.properties : {}
  for (const [key, raw] of Object.entries(rawProps)) {
    if (!isRecord(raw)) continue
    const items = isRecord(raw.items) ? raw.items : null
    properties[key] = {
      title: typeof raw.title === 'string' ? raw.title : undefined,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      enumValues: Array.isArray(raw.enum)
        ? raw.enum.filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
        : [],
      minLength: readNumber(raw.minLength),
      maxLength: readNumber(raw.maxLength),
      minimum: readNumber(raw.minimum),
      maximum: readNumber(raw.maximum),
      minItems: readNumber(raw.minItems),
      maxItems: readNumber(raw.maxItems),
      itemMaxLength: items ? readNumber(items.maxLength) : undefined,
    }
  }
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [],
  )
  return { properties, required }
}

function projectAttributes(
  order: string[],
  current: TemplateAttributes,
  key: string,
  fieldValue: TemplateAttributes[string] | undefined,
): TemplateAttributes {
  const next: TemplateAttributes = {}
  for (const orderKey of order) {
    if (orderKey === key) {
      if (fieldValue !== undefined) next[orderKey] = fieldValue
      continue
    }
    if (Object.prototype.hasOwnProperty.call(current, orderKey)) {
      next[orderKey] = current[orderKey]
    }
  }
  return next
}

function parseIntegerInput(raw: string): number | undefined | 'invalid' {
  if (raw === '') return undefined
  if (!/^-?\d+$/.test(raw)) return 'invalid'
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed)) return 'invalid'
  return parsed
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

type StringListControlProps = {
  id: string
  fieldKey: string
  title: string
  items: string[]
  disabled: boolean
  maxItems?: number
  maxLength?: number
  onCommit: (next: string[]) => void
}

function StringListControl({
  id,
  fieldKey,
  title,
  items,
  disabled,
  maxItems,
  maxLength,
  onCommit,
}: StringListControlProps) {
  const [blanks, setBlanks] = useState<string[]>([])
  const canAdd = !disabled && (maxItems == null || items.length + blanks.length < maxItems)

  return (
    <div className="space-y-2" id={id} data-testid={`template-attr-${fieldKey}-list`}>
      {items.map((item, index) => (
        <div key={`item-${index}`} className="flex items-center gap-2">
          <input
            type="text"
            className="input flex-1 min-h-[44px]"
            value={item}
            maxLength={maxLength}
            disabled={disabled}
            aria-label={`${title} ${index + 1}`}
            data-testid={`template-attr-${fieldKey}-item-${index}`}
            onChange={(event) => {
              const next = items.slice()
              next[index] = event.target.value
              onCommit(next.filter((row) => row.length > 0))
            }}
          />
          <button
            type="button"
            className="min-h-[44px] min-w-[44px] p-2 rounded text-[var(--color-danger)] hover:bg-[var(--color-background)] cursor-pointer disabled:opacity-50"
            disabled={disabled}
            aria-label={`删除${title} ${index + 1}`}
            data-testid={`template-attr-${fieldKey}-remove-${index}`}
            onClick={() => onCommit(items.filter((_, itemIndex) => itemIndex !== index))}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ))}
      {blanks.map((blank, index) => (
        <div key={`blank-${index}`} className="flex items-center gap-2">
          <input
            type="text"
            className="input flex-1 min-h-[44px]"
            value={blank}
            maxLength={maxLength}
            disabled={disabled}
            aria-label={`${title} 新项 ${index + 1}`}
            data-testid={`template-attr-${fieldKey}-blank-${index}`}
            onChange={(event) => {
              const text = event.target.value
              if (text.length > 0) {
                onCommit([...items, text])
                setBlanks((current) => current.filter((_, blankIndex) => blankIndex !== index))
                return
              }
              setBlanks((current) => current.map((row, blankIndex) => (blankIndex === index ? text : row)))
            }}
          />
          <button
            type="button"
            className="min-h-[44px] min-w-[44px] p-2 rounded text-[var(--color-danger)] hover:bg-[var(--color-background)] cursor-pointer disabled:opacity-50"
            disabled={disabled}
            aria-label={`删除${title} 新项 ${index + 1}`}
            data-testid={`template-attr-${fieldKey}-blank-remove-${index}`}
            onClick={() => setBlanks((current) => current.filter((_, blankIndex) => blankIndex !== index))}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn-secondary min-h-[44px] px-3"
        disabled={!canAdd}
        data-testid={`template-attr-${fieldKey}-add`}
        onClick={() => setBlanks((current) => [...current, ''])}
      >
        <Plus className="w-4 h-4" /> 添加
      </button>
    </div>
  )
}

export default function TemplateAttributeFields({
  template,
  target,
  value,
  onChange,
  disabled = false,
  mode = 'draft',
}: TemplateAttributeFieldsProps) {
  const idPrefix = useId()
  const order = target === 'offer' ? template.ui.offerOrder : template.ui.productOrder
  const schema = target === 'offer' ? template.offerSchema : template.productSchema
  const { properties, required } = readSchema(schema)
  const widgets = template.ui.widgets
  const enumLabels = template.ui.enumLabels

  function setField(key: string, fieldValue: TemplateAttributes[string] | undefined) {
    onChange(projectAttributes(order, value, key, fieldValue))
  }

  return (
    <div className="space-y-4" data-testid="template-attribute-fields" data-target={target} data-mode={mode}>
      {order.map((key) => {
        const widget = widgets[key]
        const property = properties[key]
        const title = property?.title ?? key
        const description = property?.description
        const isRequired = required.has(key)
        const fieldId = `${idPrefix}-${key}`
        const current = Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined
        const showPublishHint = mode === 'publish' && isRequired && (current === undefined || current === '' || (Array.isArray(current) && current.length === 0))
        const knownWidget = typeof widget === 'string' && WIDGET_SET.has(widget) ? (widget as TemplateWidget) : null

        return (
          <div key={key} className="min-w-0" data-testid={`template-attr-${key}`}>
            <label htmlFor={knownWidget === 'stringList' ? undefined : fieldId} className="block text-sm font-semibold text-[var(--color-text)] mb-1.5">
              {title}
              {isRequired ? <span className="text-[var(--color-danger)]"> *</span> : null}
            </label>

            {knownWidget == null ? (
              <p
                className="text-sm text-[var(--color-text-muted)] rounded-lg border border-dashed border-[var(--color-border)] px-3 py-2"
                data-testid={`template-attr-${key}-unsupported`}
              >
                不支持的控件类型{widget ? `「${String(widget)}」` : ''}，无法编辑
              </p>
            ) : knownWidget === 'textarea' ? (
              <textarea
                id={fieldId}
                className="input min-h-[88px] resize-y"
                value={typeof current === 'string' ? current : ''}
                maxLength={property?.maxLength}
                disabled={disabled}
                data-testid={`template-attr-${key}-control`}
                onChange={(event) => {
                  const next = event.target.value
                  setField(key, next === '' ? undefined : next)
                }}
              />
            ) : knownWidget === 'select' ? (
              <select
                id={fieldId}
                className="input min-h-[44px] appearance-none cursor-pointer"
                value={typeof current === 'string' || typeof current === 'number' ? String(current) : ''}
                disabled={disabled}
                data-testid={`template-attr-${key}-control`}
                onChange={(event) => {
                  const selected = event.target.value
                  if (selected === '') {
                    setField(key, undefined)
                    return
                  }
                  const match = (property?.enumValues ?? []).find((item) => String(item) === selected)
                  if (match === undefined) return
                  setField(key, match)
                }}
              >
                <option value="">请选择</option>
                {(property?.enumValues ?? []).map((item) => {
                  const optionValue = String(item)
                  const label = enumLabels?.[key]?.[optionValue] ?? optionValue
                  return (
                    <option key={optionValue} value={optionValue}>
                      {label}
                    </option>
                  )
                })}
              </select>
            ) : knownWidget === 'integer' ? (
              <input
                id={fieldId}
                type="number"
                inputMode="numeric"
                step={1}
                min={property?.minimum}
                max={property?.maximum}
                className="input min-h-[44px] font-mono"
                value={typeof current === 'number' && Number.isInteger(current) ? String(current) : ''}
                disabled={disabled}
                data-testid={`template-attr-${key}-control`}
                onChange={(event) => {
                  const parsed = parseIntegerInput(event.target.value)
                  if (parsed === 'invalid') return
                  setField(key, parsed)
                }}
              />
            ) : knownWidget === 'stringList' ? (
              <StringListControl
                id={fieldId}
                fieldKey={key}
                title={title}
                items={asStringList(current)}
                disabled={disabled}
                maxItems={property?.maxItems}
                maxLength={property?.itemMaxLength}
                onCommit={(next) => setField(key, next)}
              />
            ) : (
              <input
                id={fieldId}
                type="text"
                className="input min-h-[44px]"
                value={typeof current === 'string' ? current : ''}
                maxLength={property?.maxLength}
                disabled={disabled}
                data-testid={`template-attr-${key}-control`}
                onChange={(event) => {
                  const next = event.target.value
                  setField(key, next === '' ? undefined : next)
                }}
              />
            )}

            {description ? (
              <p className="text-xs text-[var(--color-text-muted)] mt-1">{description}</p>
            ) : null}
            {showPublishHint ? (
              <p className="text-xs text-[var(--color-danger)] mt-1" data-testid={`template-attr-${key}-required-hint`}>
                发布前必填
              </p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
