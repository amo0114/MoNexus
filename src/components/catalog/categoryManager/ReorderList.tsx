import { ArrowDown, ArrowUp, FolderTree } from 'lucide-react'
import EmptyState from '../../ui/EmptyState'
import { CATEGORY_STATUS, type CategoryAdminDto } from '../../../types/catalog'
import CategoryStatusBadge from './CategoryStatusBadge'

/** Drag-free, arrow-based reorder list (keyboard friendly). */
export default function ReorderList({
  rows,
  busy,
  onMove,
}: {
  rows: CategoryAdminDto[]
  busy: boolean
  onMove: (index: number, delta: -1 | 1) => void
}) {
  if (rows.length === 0) {
    return <EmptyState icon={FolderTree} title="暂无分类" description="没有可排序的分类。" compact />
  }
  return (
    <ol className="divide-y divide-[var(--color-border)]" data-testid="reorder-list">
      {rows.map((c, index) => (
        <li key={c.id} data-testid={`reorder-row-${c.id}`} className="flex items-center gap-3 px-4 py-2.5">
          <span className="w-6 text-sm text-[var(--color-text-muted)] tabular-nums">{index + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-sm text-[var(--color-text)] flex items-center gap-2">
              {c.label}
              {c.status === CATEGORY_STATUS.INACTIVE && <CategoryStatusBadge status={c.status} />}
            </div>
            <div className="font-mono text-xs text-[var(--color-text-muted)]">{c.code}</div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="icon-btn p-1.5 rounded-md hover:bg-[var(--color-border)] cursor-pointer"
              aria-label={`上移 ${c.label}`}
              data-testid={`reorder-up-${c.id}`}
              disabled={busy || index === 0}
              onClick={() => onMove(index, -1)}
            >
              <ArrowUp className="w-4 h-4" />
            </button>
            <button
              type="button"
              className="icon-btn p-1.5 rounded-md hover:bg-[var(--color-border)] cursor-pointer"
              aria-label={`下移 ${c.label}`}
              data-testid={`reorder-down-${c.id}`}
              disabled={busy || index === rows.length - 1}
              onClick={() => onMove(index, 1)}
            >
              <ArrowDown className="w-4 h-4" />
            </button>
          </div>
        </li>
      ))}
    </ol>
  )
}
