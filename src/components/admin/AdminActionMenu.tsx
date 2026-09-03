import { useState, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal } from 'lucide-react'

export interface AdminActionMenuItem {
  id: string
  label: React.ReactNode
  onClick: () => void
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>
  tone?: 'default' | 'danger' | 'primary' | 'cta'
  disabled?: boolean
  testId?: string
}

export interface AdminActionMenuProps {
  items: AdminActionMenuItem[]
  triggerLabel?: string
  triggerTestId?: string
  align?: 'left' | 'right'
}

export default function AdminActionMenu({
  items,
  triggerLabel = '更多操作',
  triggerTestId = 'admin-action-menu-trigger',
  align = 'right',
}: AdminActionMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  // Only non-disabled items participate in keyboard arrow navigation
  const enabledIndices = useMemo(() => {
    return items
      .map((item, index) => (!item.disabled ? index : -1))
      .filter((idx) => idx !== -1)
  }, [items])

  const updatePosition = () => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const viewportHeight = window.innerHeight
    const viewportWidth = window.innerWidth
    const spaceBelow = viewportHeight - rect.bottom
    const spaceAbove = rect.top
    const estimatedHeight = Math.min(items.length * 36 + 16, 260)
    const openAbove = spaceBelow < estimatedHeight && spaceAbove > spaceBelow

    const menuWidth = 140
    let left = align === 'left' ? rect.left : rect.right - menuWidth
    if (left + menuWidth > viewportWidth - 8) {
      left = viewportWidth - menuWidth - 8
    }
    if (left < 8) {
      left = 8
    }

    const top = openAbove ? rect.top - estimatedHeight - 4 : rect.bottom + 4

    setMenuStyle({
      position: 'fixed',
      top: `${Math.max(8, top)}px`,
      left: `${left}px`,
      zIndex: 9999,
    })
  }

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  // Track window scroll/resize to update portal position
  useEffect(() => {
    if (!isOpen) return
    updatePosition()
    const handleScroll = (e: Event) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) {
        return
      }
      updatePosition()
    }
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', updatePosition)
    return () => {
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', updatePosition)
    }
  }, [isOpen, items.length, align])

  // Focus management: initial focus on first enabled item
  useEffect(() => {
    if (isOpen) {
      setFocusedIndex(enabledIndices.length > 0 ? enabledIndices[0] : -1)
    } else {
      setFocusedIndex(-1)
    }
  }, [isOpen, enabledIndices])

  useEffect(() => {
    if (isOpen && focusedIndex >= 0 && itemRefs.current[focusedIndex]) {
      itemRefs.current[focusedIndex]?.focus()
    }
  }, [focusedIndex, isOpen])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        setIsOpen(true)
      }
      return
    }

    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        setIsOpen(false)
        triggerRef.current?.focus()
        break
      case 'ArrowDown': {
        e.preventDefault()
        if (enabledIndices.length === 0) break
        const currentPos = enabledIndices.indexOf(focusedIndex)
        const nextPos = currentPos === -1 ? 0 : (currentPos + 1) % enabledIndices.length
        setFocusedIndex(enabledIndices[nextPos])
        break
      }
      case 'ArrowUp': {
        e.preventDefault()
        if (enabledIndices.length === 0) break
        const currentPos = enabledIndices.indexOf(focusedIndex)
        const prevPos =
          currentPos === -1
            ? enabledIndices.length - 1
            : (currentPos - 1 + enabledIndices.length) % enabledIndices.length
        setFocusedIndex(enabledIndices[prevPos])
        break
      }
      case 'Home':
        e.preventDefault()
        if (enabledIndices.length > 0) {
          setFocusedIndex(enabledIndices[0])
        }
        break
      case 'End':
        e.preventDefault()
        if (enabledIndices.length > 0) {
          setFocusedIndex(enabledIndices[enabledIndices.length - 1])
        }
        break
      case 'Tab':
        setIsOpen(false)
        break
    }
  }

  const toneClasses = (tone?: AdminActionMenuItem['tone']) => {
    switch (tone) {
      case 'danger':
        return 'text-red-500 hover:bg-red-500/10 focus:bg-red-500/10'
      case 'primary':
        return 'text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 focus:bg-[var(--color-primary)]/10'
      case 'cta':
        return 'text-[var(--color-cta)] hover:bg-[var(--color-cta)]/10 focus:bg-[var(--color-cta)]/10'
      default:
        return 'text-[var(--color-text)] hover:bg-[var(--color-background)] focus:bg-[var(--color-background)]'
    }
  }

  return (
    <div className="relative inline-block text-left" onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={triggerLabel}
        data-testid={triggerTestId}
        onClick={() => setIsOpen((prev) => !prev)}
        className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-background)] border border-[var(--color-border)] transition-colors cursor-pointer inline-flex items-center justify-center focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
      >
        <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
      </button>

      {isOpen &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={triggerLabel}
            style={menuStyle}
            className="min-w-[140px] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg backdrop-blur-md focus:outline-none"
            onKeyDown={handleKeyDown}
          >
            {items.map((item, idx) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  ref={(el) => {
                    itemRefs.current[idx] = el
                  }}
                  type="button"
                  role="menuitem"
                  tabIndex={focusedIndex === idx ? 0 : -1}
                  disabled={item.disabled}
                  data-testid={item.testId}
                  onClick={() => {
                    if (item.disabled) return
                    setIsOpen(false)
                    triggerRef.current?.focus()
                    item.onClick()
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-medium transition-colors cursor-pointer text-left disabled:opacity-40 disabled:cursor-not-allowed ${toneClasses(
                    item.tone,
                  )}`}
                >
                  {Icon && <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
                  <span className="truncate">{item.label}</span>
                </button>
              )
            })}
          </div>,
          document.body,
        )}
    </div>
  )
}
