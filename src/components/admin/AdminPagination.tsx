import { useState, useEffect } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface Props {
  page: number
  total: number
  pageSize?: number
  onPageChange: (page: number) => void
  testId?: string
  className?: string
  showQuickJumper?: boolean
  hideOnSinglePage?: boolean
}

/** 管理端列表通用分页控件（与商家端 PaginationControls 同构并增强快速跳转与移动端触控） */
export default function AdminPagination({
  page,
  total,
  pageSize = 20,
  onPageChange,
  testId,
  className = '',
  showQuickJumper = true,
  hideOnSinglePage = false,
}: Props) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const clampedPage = Math.max(1, Math.min(totalPages, page))
  const [jumpPage, setJumpPage] = useState('')

  useEffect(() => {
    if (page > totalPages) {
      onPageChange(totalPages)
    } else if (page < 1) {
      onPageChange(1)
    }
  }, [page, totalPages, onPageChange])

  useEffect(() => {
    setJumpPage('')
  }, [clampedPage, totalPages])

  if (hideOnSinglePage && total <= pageSize) {
    return null
  }

  function handleJump() {
    const p = parseInt(jumpPage, 10)
    if (!isNaN(p)) {
      const target = Math.max(1, Math.min(totalPages, p))
      onPageChange(target)
      setJumpPage('')
    }
  }

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 mt-4 px-2 pb-2 border-t border-[var(--color-border)] pt-4 ${className}`}
      data-testid={testId}
    >
      <div className="text-sm text-[var(--color-text-muted)] min-h-10 flex items-center">
        共 {total} 条记录，第 {clampedPage} / {totalPages} 页
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onPageChange(Math.max(1, clampedPage - 1))}
          disabled={clampedPage <= 1}
          className="btn-secondary min-h-10 min-w-10 px-3 py-2 text-sm disabled:opacity-50 flex items-center justify-center cursor-pointer"
          aria-label="上一页"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        {totalPages > 1 && (
          <span className="text-sm font-medium text-[var(--color-text-muted)] px-1">
            {clampedPage} / {totalPages}
          </span>
        )}

        <button
          type="button"
          onClick={() => onPageChange(Math.min(totalPages, clampedPage + 1))}
          disabled={clampedPage >= totalPages}
          className="btn-secondary min-h-10 min-w-10 px-3 py-2 text-sm disabled:opacity-50 flex items-center justify-center cursor-pointer"
          aria-label="下一页"
        >
          <ChevronRight className="w-4 h-4" />
        </button>

        {showQuickJumper && totalPages > 3 && (
          <div className="flex items-center gap-1.5 ml-2">
            <span className="text-xs text-[var(--color-text-muted)]">跳至</span>
            <input
              type="number"
              min={1}
              max={totalPages}
              value={jumpPage}
              onChange={(e) => setJumpPage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleJump()
              }}
              placeholder={`${clampedPage}`}
              className="input py-1 px-2 text-xs w-14 text-center min-h-10"
              aria-label="跳转页码"
            />
            <span className="text-xs text-[var(--color-text-muted)]">页</span>
            <button
              type="button"
              onClick={handleJump}
              disabled={!jumpPage}
              className="btn-secondary min-h-10 px-3 py-1 text-xs disabled:opacity-50 cursor-pointer"
            >
              跳转
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
