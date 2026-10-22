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
  const selectedCategory = categories.find(c => c.id === value) ?? null
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
              {/* SPEC-CATALOG-VIS-001 §3.1：选到受限分类时商家必须知情——
                  选它会让商品对游客完全不可见（不只是列表里少一条）。 */}
              {category.guestVisibility === 'members_only'
                ? `${category.label}（仅登录可见）`
                : category.label}
            </option>
          ))}
        </select>
      </div>
      <p className="mt-1.5 text-xs text-[var(--color-text-muted)]" data-testid="product-category-hint">
        分类仅影响展示与检索，不会改变交付方式。
      </p>
      {selectedCategory?.guestVisibility === 'members_only' && (
        <p
          className="mt-1 rounded px-2 py-1 text-xs bg-[var(--color-primary-tint)] text-[var(--color-text-muted)]"
          data-testid="product-category-guest-locked-hint"
        >
          该分类仅登录用户可见，选择后商品对游客不可见（不影响已登录用户的购买）。
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1.5 text-xs text-[var(--color-danger)]" data-testid="product-category-error">
          {error}
        </p>
      )}
    </div>
  )
}
