import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { forwardRef } from 'react'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogPortal = DialogPrimitive.Portal
export const DialogClose = DialogPrimitive.Close

type OverlayProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
export const DialogOverlay = forwardRef<HTMLDivElement, OverlayProps>(({ className = '', ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={`modal-overlay ${className}`}
    {...props}
  />
))
DialogOverlay.displayName = 'DialogOverlay'

type ContentProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
export const DialogContent = forwardRef<HTMLDivElement, ContentProps>(({ className = '', children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={`modal fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 focus-visible:outline-none ${className}`}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        className="absolute right-4 top-4 rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-border)] hover:text-[var(--color-text)] transition-colors focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)] cursor-pointer"
        aria-label="关闭"
      >
        <X className="w-4 h-4" />
      </DialogPrimitive.Close>
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
