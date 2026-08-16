// AdminProductSearchSelect — searchable product selector (SPEC-CMI-UX-001
// §6.3 / D-UX-17; CHK-UX-P1-008). Admins pick a product by name instead of
// typing a raw Product ID. Only active products (public /products list) are
// offered, matching the editorial "only active product" server rule.
//
// - `readOnly` (edit mode) renders the fixed product name fetched from the
//   product detail endpoint; the product id itself is never editable.
// - The raw id is only shown as a secondary hint (`#id`), never as the primary
//   control or heading.

import { useEffect, useRef, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import api from '../../api/client'

interface SearchOption {
  id: number
  name: string
}

interface AdminProductSearchSelectProps {
  /** Currently selected product id (null = none). */
  value: number | null
  onChange: (id: number) => void
  disabled?: boolean
  /** Edit mode: the product is fixed and shown read-only. */
  readOnly?: boolean
  testId?: string
}

export default function AdminProductSearchSelect({
  value,
  onChange,
  disabled = false,
  readOnly = false,
  testId = 'admin-product-search',
}: AdminProductSearchSelectProps) {
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<SearchOption[]>([])
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const requestRef = useRef(0)
  const [selectedName, setSelectedName] = useState<string | null>(null)

  // Resolve the display name for the selected / fixed product.
  useEffect(() => {
    if (value == null) {
      setSelectedName(null)
      return
    }
    let cancelled = false
    api
      .get<{ name: string }>(`/products/${value}`)
      .then((res) => { if (!cancelled) setSelectedName(res.data.name) })
      .catch(() => { if (!cancelled) setSelectedName(null) })
    return () => { cancelled = true }
  }, [value])

  // Debounced name search against the public /products list.
  useEffect(() => {
    const trimmed = query.trim()
    if (readOnly || value != null || !trimmed) {
      setOptions([])
      setOpen(false)
      return
    }
    const requestId = ++requestRef.current
    setSearching(true)
    const timer = setTimeout(() => {
      api
        .get<{ items: SearchOption[] }>('/products', { params: { q: trimmed, pageSize: 10 } })
        .then((res) => {
          if (requestId !== requestRef.current) return
          setOptions(res.data.items)
          setOpen(true)
        })
        .catch(() => { if (requestId === requestRef.current) setOptions([]) })
        .finally(() => { if (requestId === requestRef.current) setSearching(false) })
    }, 300)
    return () => {
      clearTimeout(timer)
      requestRef.current += 1
    }
  }, [query, readOnly, value])

  if (readOnly) {
    return (
      <div data-testid={testId}>
        <div
          className="input bg-[var(--color-muted)]/10"
          data-testid={`${testId}-fixed`}
        >
          {selectedName ?? `商品 #${value ?? '—'}`}
        </div>
      </div>
    )
  }

  return (
    <div data-testid={testId} className="relative">
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" aria-hidden="true" />
        <input
          type="text"
          value={query}
          onChange={(event) => { setQuery(event.target.value); setOpen(true) }}
          onFocus={() => { if (options.length) setOpen(true) }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="搜索商品名称…"
          className="input pl-9"
          disabled={disabled}
          aria-label="搜索商品"
          data-testid={`${testId}-input`}
        />
        {searching && (
          <Loader2 className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-[var(--color-text-muted)]" aria-hidden="true" />
        )}
      </div>
      {open && options.length > 0 && (
        <ul
          className="absolute z-20 mt-1 w-full max-h-60 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg"
          data-testid={`${testId}-options`}
        >
          {options.map((opt) => (
            <li key={opt.id}>
              <button
                type="button"
                className="w-full text-left px-3 py-2 text-sm hover:bg-[var(--color-primary)]/8 flex justify-between gap-2"
                onClick={() => {
                  setQuery('')
                  setOpen(false)
                  setOptions([])
                  onChange(opt.id)
                }}
                data-testid={`${testId}-option-${opt.id}`}
              >
                <span className="truncate">{opt.name}</span>
                <span className="text-xs text-[var(--color-text-muted)] shrink-0">#{opt.id}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {value != null && (
        <p className="text-xs text-[var(--color-text-muted)] mt-1" data-testid={`${testId}-selected`}>
          已选择：{selectedName ?? `商品 #${value}`}
        </p>
      )}
    </div>
  )
}
