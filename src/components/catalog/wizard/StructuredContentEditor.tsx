import { Trash2 } from 'lucide-react'
import type { DeliveryField } from '../../../types/merchant'
import FieldLabel from './FieldLabel'
import { DELIVERY_FIELDS_MAX } from './deliveryFields'

export default function StructuredContentEditor({
  fields,
  values,
  onFieldsChange,
  onValuesChange,
  disabled,
  testIdPrefix,
  variant,
}: {
  fields: DeliveryField[]
  values: Record<string, string>
  onFieldsChange: (fields: DeliveryField[]) => void
  onValuesChange: (values: Record<string, string>) => void
  disabled?: boolean
  testIdPrefix: string
  variant: 'create' | 'edit'
}) {
  function updateField(index: number, patch: Partial<DeliveryField>) {
    const current = fields[index]
    if (!current) return
    const next = fields.map((item, i) => (i === index ? { ...item, ...patch } : item))
    onFieldsChange(next)
    if (typeof patch.key === 'string' && patch.key !== current.key) {
      const nextValues = { ...values }
      nextValues[patch.key] = nextValues[current.key] ?? ''
      delete nextValues[current.key]
      onValuesChange(nextValues)
    }
  }

  return (
    <div className="space-y-2" data-testid={`${testIdPrefix}-content`}>
      <div className="flex items-center justify-between">
        {variant === 'create' ? <FieldLabel>共享账号固定内容</FieldLabel> : (
          <span className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">共享固定内容</span>
        )}
        <span className="text-xs text-[var(--color-text-muted)]">{fields.length}/{DELIVERY_FIELDS_MAX}</span>
      </div>
      {variant === 'create' && (
        <p className="text-xs text-[var(--color-text-muted)]">
          每位买家收到同一份结构化内容。草稿可先留空，发布前需填写 1-8 个字段及对应值。
        </p>
      )}
      {fields.map((field, index) => (
        <div
          key={index}
          className={`space-y-2 rounded-lg border border-[var(--color-border)] ${variant === 'create' ? 'bg-[var(--color-background)]' : 'bg-[var(--color-surface)]'} px-3 py-2`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input flex-1 min-w-[7rem] py-1.5 font-mono"
              placeholder={variant === 'create' ? 'key（如 user）' : 'key'}
              maxLength={32}
              value={field.key}
              onChange={(event) => updateField(index, { key: event.target.value })}
              disabled={disabled}
              data-testid={`${testIdPrefix}-field-key-${index}`}
            />
            <input
              className="input flex-1 min-w-[7rem] py-1.5"
              placeholder={variant === 'create' ? '显示名称（如 账号）' : '显示名称'}
              maxLength={30}
              value={field.label}
              onChange={(event) => updateField(index, { label: event.target.value })}
              disabled={disabled}
              data-testid={`${testIdPrefix}-field-label-${index}`}
            />
            {variant === 'create' && (
              <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] cursor-pointer whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={field.sensitive}
                  onChange={(event) => updateField(index, { sensitive: event.target.checked })}
                  disabled={disabled}
                  data-testid={`${testIdPrefix}-field-sensitive-${index}`}
                />
                敏感
              </label>
            )}
            <button
              type="button"
              onClick={() => {
                const removed = fields[index]
                onFieldsChange(fields.filter((_, i) => i !== index))
                if (removed) {
                  const nextValues = { ...values }
                  delete nextValues[removed.key]
                  onValuesChange(nextValues)
                }
              }}
              disabled={disabled}
              className="icon-btn p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] cursor-pointer"
              aria-label="删除字段"
              data-testid={variant === 'edit' ? `${testIdPrefix}-field-remove-${index}` : undefined}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
          <input
            className="input py-1.5 font-mono"
            placeholder="交付值"
            maxLength={2000}
            value={values[field.key] ?? ''}
            onChange={(event) => onValuesChange({ ...values, [field.key]: event.target.value })}
            disabled={disabled}
            data-testid={`${testIdPrefix}-field-value-${index}`}
          />
        </div>
      ))}
      {fields.length < DELIVERY_FIELDS_MAX && (
        <button
          type="button"
          onClick={() => onFieldsChange([...fields, { key: '', label: '', sensitive: false }])}
          disabled={disabled}
          className="btn-secondary w-full py-1.5 text-xs"
          data-testid={`${testIdPrefix}-field-add`}
        >
          + 添加固定字段
        </button>
      )}
    </div>
  )
}
