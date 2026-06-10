import { ChevronLeft, ChevronRight } from 'lucide-react'

interface Props {
  page: number
  total: number
  pageSize?: number
  onPageChange: (page: number) => void
  testId?: string
}

/** 管理端列表通用分页控件（与商家端 PaginationControls 同构） */
export default function AdminPagination({ page, total, pageSize = 20, onPageChange, testId }: Props) {
  const totalPages = Math.ceil(total / pageSize) || 1

  return (
    <div
      className="flex items-center justify-between mt-4 px-2 pb-2 border-t border-[var(--color-border)] pt-4"
      data-testid={testId}
    >
      <div className="text-sm text-[var(--color-text-muted)]">
        共 {total} 条记录，第 {page} / {totalPages} 页
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="btn-secondary !px-2 !py-1 !text-xs disabled:opacity-50 flex items-center cursor-pointer"
          aria-label="上一页"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <button
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          className="btn-secondary !px-2 !py-1 !text-xs disabled:opacity-50 flex items-center cursor-pointer"
          aria-label="下一页"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
