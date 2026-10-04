import { CheckCircle2, XCircle } from 'lucide-react'
import { CATEGORY_STATUS_LABEL } from '../../../types/catalogGovernance'
import { CATEGORY_STATUS, type CategoryStatus } from '../../../types/catalog'

/** Category repository status pill — used by the table and the reorder list. */
export default function CategoryStatusBadge({ status }: { status: CategoryStatus }) {
  const active = status === CATEGORY_STATUS.ACTIVE
  return (
    <span
      data-testid={`category-status-${status}`}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${
        active
          ? 'bg-[var(--color-success)]/10 text-[var(--color-success)]'
          : 'bg-[var(--color-muted)]/20 text-[var(--color-text-muted)]'
      }`}
    >
      {active ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
      {CATEGORY_STATUS_LABEL[status]}
    </span>
  )
}
