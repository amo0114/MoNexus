import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { forwardRef, useEffect } from 'react'
import { useAppStore } from '../../stores/appStore'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogPortal = DialogPrimitive.Portal
export const DialogClose = DialogPrimitive.Close

type OverlayProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
export const DialogOverlay = forwardRef<HTMLDivElement, OverlayProps>(({ className = '', ...props }, ref) => {
  // 全局模态计数：overlay 挂载即 +1、卸载 -1（嵌套弹窗自然正确）。
  // navbar 据此淡出（appStore.modalDepth），避免玻璃 chrome 被 overlay
  // 的 backdrop-blur 二次模糊成「半透隐约可见」的脏条。
  const modalOpened = useAppStore((s) => s.modalOpened)
  const modalClosed = useAppStore((s) => s.modalClosed)
  useEffect(() => {
    modalOpened()
    return () => modalClosed()
  }, [modalOpened, modalClosed])
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={`modal-overlay ${className}`}
      {...props}
    />
  )
})
DialogOverlay.displayName = 'DialogOverlay'

type ContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  /** Hide the default top-right X (e.g. nested crop dialog provides its own). */
  hideClose?: boolean
}
/**
 * Dual-form dialog content (spec M3):
 * - ≥md: centered card (original behavior, visually unchanged).
 * - <md: bottom sheet — full-bleed, top-rounded, slides up, capped at
 *   92dvh with internal scroll (.modal baseline) and safe-area bottom
 *   padding. max-md: utilities sit in the utilities layer after the
 *   unprefixed centering classes, so they cleanly override below md.
 */
export const DialogContent = forwardRef<HTMLDivElement, ContentProps>(
  ({ className = '', children, hideClose = false, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={`modal fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 focus-visible:outline-none
        max-md:sheet-enter max-md:inset-x-0 max-md:bottom-0 max-md:top-auto
        max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0
        max-md:rounded-b-none max-md:rounded-t-2xl max-md:max-h-[92dvh]
        max-md:p-5 max-md:pb-[calc(1.25rem+var(--safe-bottom))] ${className}`}
      {...props}
    >
      <div aria-hidden="true" className="md:hidden mx-auto -mt-1 mb-3 h-1 w-10 rounded-full bg-[var(--color-border)] shrink-0" />
      {children}
      {!hideClose && (
        <DialogPrimitive.Close
          className="icon-btn absolute right-4 top-4 rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-border)] hover:text-[var(--color-text)] transition-colors focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] cursor-pointer"
          aria-label="关闭"
        >
          <X className="w-4 h-4" />
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = 'DialogContent'

type TitleProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
export const DialogTitle = forwardRef<HTMLHeadingElement, TitleProps>(({ className = '', ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={`font-heading text-lg font-semibold text-[var(--color-text)] ${className}`}
    {...props}
  />
))
DialogTitle.displayName = 'DialogTitle'

type DescriptionProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
export const DialogDescription = forwardRef<HTMLParagraphElement, DescriptionProps>(({ className = '', ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={`text-sm text-[var(--color-text-muted)] mt-2 ${className}`}
    {...props}
  />
))
DialogDescription.displayName = 'DialogDescription'
