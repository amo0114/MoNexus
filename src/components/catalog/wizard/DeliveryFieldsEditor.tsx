import { Trash2 } from 'lucide-react'
import type { DeliveryField } from '../../../types/merchant'
import FieldLabel from './FieldLabel'
import { DELIVERY_FIELDS_MAX } from './deliveryFields'

export default function DeliveryFieldsEditor({
  fields,
  onChange,
  disabled,
  testIdPrefix,
  variant,
}: {
  fields: DeliveryField[]
  onChange: (fields: DeliveryField[]) => void
  disabled?: boolean
  testIdPrefix: string
  variant: 'create' | 'edit'
}) {
  return (
    <div className="space-y-2" data-testid={`${testIdPrefix}-fields`}>
      <div className="flex items-center justify-between">
        {variant === 'create' ? <FieldLabel>交付字段模板</FieldLabel> : (
          <span className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">交付字段模板</span>
        )}
        <span className="text-xs text-[var(--color-text-muted)]">{fields.length}/{DELIVERY_FIELDS_MAX}</span>
      </div>
      {variant === 'create' && (
        <p className="text-xs text-[var(--color-text-muted)]">
          独享账号发布前需定义 1-8 个交付字段；草稿可先留空。买家购前可见字段名。
        </p>
      )}
      {fields.map((field, index) => (
        <div
          key={index}
          className={`flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] ${variant === 'create' ? 'bg-[var(--color-background)]' : 'bg-[var(--color-surface)]'} px-3 py-2`}
        >
          <input
            className="input flex-1 min-w-[7rem] py-1.5 font-mono"
            placeholder={variant === 'create' ? 'key（如 account）' : 'key'}
            maxLength={32}
            value={field.key}
            onChange={(event) => onChange(fields.map((item, i) => (
              i === index ? { ...item, key: event.target.value } : item
            )))}
            disabled={disabled}
            data-testid={`${testIdPrefix}-field-key-${index}`}
          />
          <input
            className="input flex-1 min-w-[7rem] py-1.5"
            placeholder={variant === 'create' ? '显示名称（如 账号）' : '显示名称'}
            maxLength={30}
            value={field.label}
            onChange={(event) => onChange(fields.map((item, i) => (
              i === index ? { ...item, label: event.target.value } : item
            )))}
            disabled={disabled}
            data-testid={`${testIdPrefix}-field-label-${index}`}
          />
          <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] cursor-pointer whitespace-nowrap">
            <input
              type="checkbox"
              checked={field.sensitive}
              onChange={(event) => onChange(fields.map((item, i) => (
                i === index ? { ...item, sensitive: event.target.checked } : item
              )))}
              disabled={disabled}
              data-testid={variant === 'create' ? `${testIdPrefix}-field-sensitive-${index}` : undefined}
            />
            敏感
          </label>
          <button
            type="button"
            onClick={() => onChange(fields.filter((_, i) => i !== index))}
            disabled={disabled}
            className="icon-btn p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] cursor-pointer"
            aria-label="删除字段"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ))}
      {fields.length < DELIVERY_FIELDS_MAX && (
        <button
          type="button"
          onClick={() => onChange([...fields, { key: '', label: '', sensitive: false }])}
          disabled={disabled}
          className="btn-secondary w-full py-1.5 text-xs"
          data-testid={`${testIdPrefix}-field-add`}
        >
          + 添加交付字段
        </button>
      )}
    </div>
  )
}
