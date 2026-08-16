// Searchable, replaceable product combobox for editorial administration.
// Product names are the primary UI; raw ids only appear in technical details.

import { useEffect, useRef, useState } from 'react'
import { Loader2, RefreshCw, Search } from 'lucide-react'
import api from '../../api/client'

interface SearchOption {
  id: number
  name: string
}

interface AdminProductSearchSelectProps {
  value: number | null
  onChange: (id: number | null) => void
  disabled?: boolean
  readOnly?: boolean
  inputId?: string
  labelledBy?: string
  testId?: string
}

export default function AdminProductSearchSelect({
  value,
  onChange,
  disabled = false,
  readOnly = false,
  inputId,
  labelledBy,
  testId = 'admin-product-search',
}: AdminProductSearchSelectProps) {
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<SearchOption[]>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [searching, setSearching] = useState(false)
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const requestRef = useRef(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const resolvedInputId = inputId ?? `${testId}-input`
  const listboxId = `${testId}-listbox`

  useEffect(() => {
    if (value == null) {
      setSelectedName(null)
      return
    }
    let cancelled = false
    api
      .get<{ name: string }>(`/products/${value}`)
      .then((res) => { if (!cancelled) setSelectedName(res.data.name) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [value])

  useEffect(() => {
    const trimmed = query.trim()
    if (readOnly || value != null || !trimmed) {
      setOptions([])
      setOpen(false)
      setActiveIndex(-1)
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
          setOpen(res.data.items.length > 0)
          setActiveIndex(res.data.items.length > 0 ? 0 : -1)
        })
        .catch(() => {
          if (requestId !== requestRef.current) return
          setOptions([])
          setOpen(false)
          setActiveIndex(-1)
        })
        .finally(() => { if (requestId === requestRef.current) setSearching(false) })
    }, 300)
    return () => {
      clearTimeout(timer)
      requestRef.current += 1
    }
  }, [query, readOnly, value])

  function selectOption(option: SearchOption) {
    setSelectedName(option.name)
    setQuery('')
    setOptions([])
    setOpen(false)
    setActiveIndex(-1)
    onChange(option.id)
  }

  const technicalDetails = value == null ? null : (
    <details className="mt-1 text-xs text-[var(--color-text-muted)]">
      <summary className="cursor-pointer w-fit">技术详情</summary>
      <code>Product ID: {value}</code>
    </details>
  )

  if (readOnly) {
    return (
      <div data-testid={testId}>
        <div id={resolvedInputId} role="textbox" aria-readonly="true" aria-labelledby={labelledBy} className="input bg-[var(--color-muted)]/10" data-testid={`${testId}-fixed`}>
          {selectedName ?? '商品名称暂不可用'}
        </div>
        {technicalDetails}
      </div>
    )
  }

  if (value != null) {
    return (
      <div data-testid={testId}>
        <div className="flex items-center gap-2">
          <div id={resolvedInputId} role="textbox" aria-readonly="true" aria-labelledby={labelledBy} className="input flex-1" data-testid={`${testId}-selected`}>
            已选择：{selectedName ?? '正在加载商品名称…'}
          </div>
          <button
            type="button"
            className="btn-secondary inline-flex items-center gap-2 shrink-0"
            disabled={disabled}
            onClick={() => {
              onChange(null)
              requestAnimationFrame(() => inputRef.current?.focus())
            }}
          >
            <RefreshCw className="w-4 h-4" aria-hidden="true" />
            更换商品
          </button>
        </div>
        {technicalDetails}
      </div>
    )
  }

  return (
    <div data-testid={testId} className="relative">
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" aria-hidden="true" />
        <input
          ref={inputRef}
          id={resolvedInputId}
          type="text"
          role="combobox"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => { if (options.length > 0) setOpen(true) }}
          onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && options.length > 0) {
              event.preventDefault()
              setOpen(true)
              setActiveIndex(index => Math.min(index + 1, options.length - 1))
            } else if (event.key === 'ArrowUp' && options.length > 0) {
              event.preventDefault()
              setOpen(true)
              setActiveIndex(index => Math.max(index - 1, 0))
            } else if (event.key === 'Enter' && open && activeIndex >= 0) {
              event.preventDefault()
              selectOption(options[activeIndex]!)
            } else if (event.key === 'Escape') {
              setOpen(false)
              setActiveIndex(-1)
            }
          }}
          placeholder="搜索商品名称…"
          className="input pl-9"
          disabled={disabled}
          aria-label="搜索商品"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={open && activeIndex >= 0 ? `${testId}-option-${options[activeIndex]!.id}` : undefined}
          aria-busy={searching}
          data-testid={`${testId}-input`}
        />
        {searching && (
          <Loader2 className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-[var(--color-text-muted)]" aria-hidden="true" />
        )}
      </div>
      {open && options.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-20 mt-1 w-full max-h-60 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg"
          data-testid={`${testId}-options`}
        >
          {options.map((option, index) => (
            <li
              key={option.id}
              id={`${testId}-option-${option.id}`}
              role="option"
              aria-selected={index === activeIndex}
              className={`cursor-pointer px-3 py-2 text-sm ${index === activeIndex ? 'bg-[var(--color-primary)]/8' : ''}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectOption(option)}
              data-testid={`${testId}-option-${option.id}`}
            >
              <span className="truncate">{option.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
