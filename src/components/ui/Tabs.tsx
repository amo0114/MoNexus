import * as TabsPrimitive from '@radix-ui/react-tabs'
import { forwardRef } from 'react'

export const Tabs = TabsPrimitive.Root

type ListProps = React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
export const TabsList = forwardRef<HTMLDivElement, ListProps>(({ className = '', ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={`inline-flex items-center justify-center gap-1 rounded-lg bg-[var(--color-image-placeholder)] p-1 ${className}`}
    {...props}
  />
))
TabsList.displayName = 'TabsList'

type TriggerProps = React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
export const TabsTrigger = forwardRef<HTMLButtonElement, TriggerProps>(({ className = '', ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={`inline-flex items-center justify-center cursor-pointer whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors
      text-[var(--color-text-muted)]
      hover:text-[var(--color-text)]
      data-[state=active]:bg-[var(--color-surface)]
      data-[state=active]:text-[var(--color-text)]
      data-[state=active]:shadow-sm
      focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]
      disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
    {...props}
  />
))
TabsTrigger.displayName = 'TabsTrigger'

type ContentProps = React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
export const TabsContent = forwardRef<HTMLDivElement, ContentProps>(({ className = '', ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={`mt-4 focus-visible:outline-none ${className}`}
    {...props}
  />
))
TabsContent.displayName = 'TabsContent'
