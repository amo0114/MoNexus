import { Plus, Trash2 } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import type { PurchaseFormField } from '../../types/merchant'

export const MAX_FORM_FIELDS = 6

/**
 * 校验购买前表单字段定义（提交前调用）。返回第一条错误文案，通过则返回 null。
 * 与后端 zod 契约（server/src/lib/purchaseForm.ts)对齐的前置提示。
 */
export function validatePurchaseFormFields(fields: PurchaseFormField[]): string | null {
  for (const field of fields) {
    if (!field.label.trim()) return '购买前信息字段名称不能为空'
    if (field.type === 'select' && (!field.options || field.options.length === 0)) {
      return `「${field.label || '未命名字段'}」是下拉字段，请填写至少一个选项`
    }
    if (field.type === 'date') {
      const min = field.minDaysAhead ?? 1
      const max = field.maxDaysAhead ?? 30
      if (!Number.isInteger(min) || min < 0 || min > 365 || !Number.isInteger(max) || max < 0 || max > 365) {
        return `「${field.label || '未命名字段'}」的可约范围必须是 0-365 的整数`
      }
      if (max < min) {
        return `「${field.label || '未命名字段'}」的最晚可约不能早于最早可约`
      }
    }
  }
  return null
}

/** 序列化为提交给后端的形状（去空白、按类型裁剪多余属性）。 */
export function serializePurchaseFormFields(fields: PurchaseFormField[]) {
  return fields.map(f => ({
    key: f.key,
    label: f.label.trim(),
    type: f.type,
    required: f.required,
    ...(f.placeholder?.trim() ? { placeholder: f.placeholder.trim() } : {}),
    ...(f.type === 'select' ? { options: f.options } : {}),
    // P6c：可约范围仅随 date 字段提交（服务端默认 1 / 30 天）。
    ...(f.type === 'date' ? { minDaysAhead: f.minDaysAhead ?? 1, maxDaysAhead: f.maxDaysAhead ?? 30 } : {}),
  }))
}

interface Props {
  fields: PurchaseFormField[]
  onChange: (fields: PurchaseFormField[]) => void
}

/**
 * 购买前表单字段编辑器：创建向导第 5 步与编辑弹窗共用。
 * 受控组件——校验与提交序列化由调用方在保存时执行。
 */
export default function PurchaseFormFieldsEditor({ fields, onChange }: Props) {
  const showToast = useAppStore((s) => s.showToast)

  function addField() {
    if (fields.length >= MAX_FORM_FIELDS) {
      showToast(`最多 ${MAX_FORM_FIELDS} 个字段`, 'error')
      return
    }
    // key 是稳定标识符，不暴露给商家编辑；按序号生成并避开已占用值。
    let index = fields.length + 1
    while (fields.some(f => f.key === `field_${index}`)) index += 1
    onChange([...fields, { key: `field_${index}`, label: '', type: 'text', required: false }])
  }

  function updateField(index: number, patch: Partial<PurchaseFormField>) {
    onChange(fields.map((f, i) => (i === index ? { ...f, ...patch } : f)))
  }

  function removeField(index: number) {
    onChange(fields.filter((_, i) => i !== index))
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <p className="text-sm text-[var(--color-text-muted)]">
          可选。买家在确认兑换时填写；答案仅你、买家和管理员可见。
        </p>
        <button type="button" onClick={addField} className="btn-secondary px-3 py-1.5 text-sm"
          disabled={fields.length >= MAX_FORM_FIELDS} data-testid="add-form-field">
          <Plus className="w-4 h-4" /> 添加字段
        </button>
      </div>
      {fields.length === 0 ? (
        <div className="mt-3 rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]">
          未配置——买家无需填写任何信息即可兑换
        </div>
      ) : (
        <div className="mt-3 space-y-3" data-testid="form-field-list">
          {fields.map((field, index) => (
            <div key={field.key} className="rounded-lg border border-[var(--color-border)] p-4 space-y-3">
              <div className="flex items-center gap-3">
                <input type="text" className="input flex-1" placeholder="字段名称，如：联系方式"
                  value={field.label} onChange={(e) => updateField(index, { label: e.target.value })}
                  data-testid={`form-field-label-${index}`} />
                <select className="input w-32 appearance-none cursor-pointer" value={field.type}
                  onChange={(e) => {
                    const type = e.target.value as PurchaseFormField['type']
                    updateField(index, {
                      type,
                      options: type === 'select' ? (field.options ?? []) : undefined,
                      // P6c：切到日期字段时给默认可约范围；切走时清掉。
                      minDaysAhead: type === 'date' ? (field.minDaysAhead ?? 1) : undefined,
                      maxDaysAhead: type === 'date' ? (field.maxDaysAhead ?? 30) : undefined,
                    })
                  }}
                  data-testid={`form-field-type-${index}`}>
                  <option value="text">文本</option>
                  <option value="select">下拉</option>
                  <option value="date">日期（预约）</option>
                </select>
                <label className="flex items-center gap-1.5 text-sm whitespace-nowrap cursor-pointer">
                  <input type="checkbox" checked={field.required}
                    onChange={(e) => updateField(index, { required: e.target.checked })} className="w-4 h-4" />
                  必填
                </label>
                <button type="button" onClick={() => removeField(index)} aria-label="删除字段"
                  className="p-2 rounded text-[var(--color-danger)] hover:bg-[var(--color-background)] cursor-pointer">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              {field.type === 'text' ? (
                <input type="text" className="input" placeholder="占位提示（可选），如：TG / 邮箱"
                  value={field.placeholder ?? ''} onChange={(e) => updateField(index, { placeholder: e.target.value })} />
              ) : field.type === 'date' ? (
                /* P6c：预约日期字段——可约窗口 [今天+min, 今天+max]，服务端强校验 */
                <div className="flex flex-wrap items-end gap-4">
                  <div>
                    <label className="block text-xs text-[var(--color-text-muted)] mb-1">最早可约（N 天后）</label>
                    <input type="number" step="1" min="0" max="365" className="input w-28 font-mono"
                      value={field.minDaysAhead ?? 1}
                      onChange={(e) => updateField(index, {
                        minDaysAhead: e.target.value === '' ? undefined : Number(e.target.value),
                      })}
                      data-testid={`form-field-min-days-${index}`} />
                  </div>
                  <div>
                    <label className="block text-xs text-[var(--color-text-muted)] mb-1">最晚可约（N 天内）</label>
                    <input type="number" step="1" min="0" max="365" className="input w-28 font-mono"
                      value={field.maxDaysAhead ?? 30}
                      onChange={(e) => updateField(index, {
                        maxDaysAhead: e.target.value === '' ? undefined : Number(e.target.value),
                      })}
                      data-testid={`form-field-max-days-${index}`} />
                  </div>
                  <p className="text-xs text-[var(--color-text-muted)] pb-2.5">
                    0-365 的整数，最晚不能早于最早
                  </p>
                </div>
              ) : (
                <textarea className="input min-h-[60px] resize-y" placeholder="下拉选项，每行一个"
                  value={(field.options ?? []).join('\n')}
                  onChange={(e) => updateField(index, {
                    options: e.target.value.split('\n').map(s => s.trim()).filter(Boolean),
                  })}
                  data-testid={`form-field-options-${index}`} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
