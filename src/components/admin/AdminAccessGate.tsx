import type { ReactNode } from 'react'
import { Loader2, ShieldOff } from 'lucide-react'
import { useAdminAccess, type AdminTabAction } from '../../auth/adminAccess'
import type { AdminTab } from './AdminNav'
import EmptyState from '../ui/EmptyState'
import ErrorState from '../ui/ErrorState'

interface Props<T extends AdminTab> {
  tab: T
  /** Extra action required beyond the tab entry. */
  action?: AdminTabAction<T>
  children: ReactNode
}

/** Holds admin-only routes until capabilities settle; never renders them on an assumed super role. */
export default function AdminAccessGate<T extends AdminTab>({ tab, action, children }: Props<T>) {
  const access = useAdminAccess()
  if (access.mode === 'pending') {
    return (
      <div className="flex min-h-[240px] items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]" data-testid="admin-access-loading">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        正在读取后台权限…
      </div>
    )
  }
  if (access.mode === 'error') {
    return <ErrorState title="无法读取后台权限" description={access.errorMessage ?? undefined} onRetry={access.reload} />
  }
  if (!access.canEnter(tab) || (action && !access.can(tab, action))) {
    return <EmptyState icon={ShieldOff} title="没有该操作的权限" description="请联系超级管理员分配相应的后台权限。" />
  }
  return <>{children}</>
}
