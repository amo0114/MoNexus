import { useId } from 'react'
import { Tags } from 'lucide-react'
import type { CategoryRegistryItem } from '../../types/catalog'

interface Props {
  /** Active categories only — new first publish requires an active category (D-CAT-22). */
  categories: CategoryRegistryItem[]
  value: number | null
  onChange: (categoryId: number | null) => void
  disabled?: boolean
  label?: string
  error?: string | null
}

/**
 * Category selector for product draft forms (T-CAT-FE-001A primitive).
 *
 * Category is taxonomy only — it NEVER switches the deliveryMode (D-CAT-05,
 * CHK-CAT-005). Selecting a category emits its `categoryId`; fulfillment
 * config stays an independent choice.
 */
export default function ProductCategorySelect({
  categories,
  value,
  onChange,
  disabled = false,
  label = '商品分类',
  error = null,
}: Props) {
  const id = useId()
  const selected = value != null && categories.some((c) => c.id === value)
  const empty = categories.length === 0

  return (
    <div data-testid="product-category-field">
      <label htmlFor={id} className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">
        {label} <span className="text-red-500 normal-case">*</span>
      </label>
      <div className="relative">
        <Tags className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-text-muted)] pointer-events-none" />
        <select
          id={id}
          className="input pl-9 appearance-none cursor-pointer"
          value={selected ? String(value) : ''}
          onChange={(event) => {
            if (disabled || empty) return
            onChange(event.target.value === '' ? null : Number(event.target.value))
          }}
          disabled={disabled || empty}
          data-testid="product-category-select"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
        >
          <option value="" disabled>
            {empty ? '暂无可选分类' : '请选择分类'}
          </option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.label}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-1.5 text-xs text-[var(--color-text-muted)]" data-testid="product-category-hint">
        分类仅影响展示与检索，不会改变交付方式。
      </p>
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1.5 text-xs text-[var(--color-danger)]" data-testid="product-category-error">
          {error}
        </p>
      )}
    </div>
  )
}
