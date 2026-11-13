import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { DialogOverlay } from './Dialog'

interface SideSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  /** Right-aligned header slot (status chip, refresh…). */
  meta?: ReactNode
  /** Sticky footer for the primary decision of the sheet. */
  footer?: ReactNode
  children: ReactNode
  /** Width tier on ≥md. */
  size?: 'md' | 'lg'
  testId?: string
  /** Block dismissal while a command is in flight. */
  locked?: boolean
}

/**
 * Detail drawer for back-office records: slides in from the right on ≥md
 * (keeps the list visible for context), becomes a bottom sheet on phones.
 * Header and footer stay pinned; only the body scrolls.
 */
export default function SideSheet({
  open,
  onOpenChange,
  title,
  description,
  meta,
  footer,
  children,
  size = 'lg',
  testId,
  locked = false,
}: SideSheetProps) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (locked && !next) return
        onOpenChange(next)
      }}
    >
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content
          data-testid={testId}
          onEscapeKeyDown={(e) => { if (locked) e.preventDefault() }}
          onPointerDownOutside={(e) => { if (locked) e.preventDefault() }}
          className={`fixed z-50 flex flex-col bg-[var(--color-surface)] shadow-2xl focus-visible:outline-none
            inset-x-0 bottom-0 max-h-[92dvh] rounded-t-2xl border-t border-[var(--color-border)] max-md:sheet-enter
            md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:h-dvh md:rounded-none md:border-t-0 md:border-l
            md:[animation:slideInRight_0.3s_cubic-bezier(0.16,1,0.3,1)_both]
            ${size === 'lg' ? 'md:w-[min(46rem,100vw)]' : 'md:w-[min(32rem,100vw)]'}`}
        >
          <div aria-hidden="true" className="md:hidden mx-auto mt-2 h-1 w-10 rounded-full bg-[var(--color-border)] shrink-0" />
          <header className="flex items-start gap-3 px-5 md:px-6 pt-4 md:pt-5 pb-4 border-b border-[var(--color-border)] shrink-0">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="font-heading text-lg font-bold text-[var(--color-text)] truncate">
                {title}
              </DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-1 text-xs text-[var(--color-text-muted)]">
                  {description}
                </DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">详情</DialogPrimitive.Description>
              )}
            </div>
            {meta && <div className="flex items-center gap-2 shrink-0">{meta}</div>}
            <DialogPrimitive.Close
              disabled={locked}
              aria-label="关闭"
              className="icon-btn -mr-1.5 rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-border)] hover:text-[var(--color-text)] transition-colors cursor-pointer disabled:opacity-40 focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
            >
              <X className="w-4 h-4" />
            </DialogPrimitive.Close>
          </header>
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 md:px-6 py-5">{children}</div>
          {footer && (
            <footer className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-5 md:px-6 py-4 pb-[calc(1rem+var(--safe-bottom))] md:pb-4">
              {footer}
            </footer>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
