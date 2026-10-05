import { ChevronLeft, ChevronRight } from 'lucide-react'

interface Props {
  page: number
  total: number
  pageSize: number
  onPageChange: (page: number) => void
  onPageSizeChange?: (size: number) => void
}

function getPageNumbers(current: number, total: number): (number | string)[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1)
  }
  const pages: (number | string)[] = []
  pages.push(1)
  if (current > 3) {
    pages.push('...')
  }
  const start = Math.max(2, current - 1)
  const end = Math.min(total - 1, current + 1)
  for (let i = start; i <= end; i++) {
    pages.push(i)
  }
  if (current < total - 2) {
    pages.push('....')
  }
  pages.push(total)
  return pages
}

export default function OrdersPagination({
  page,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: Props) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const clampedPage = Math.max(1, Math.min(totalPages, page))

  if (total <= 0) return null

  const startRecord = (clampedPage - 1) * pageSize + 1
  const endRecord = Math.min(clampedPage * pageSize, total)

  return (
    <div
      className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-5 mt-6 border-t border-[var(--color-border)] text-xs text-[var(--color-text-muted)]"
      data-testid="orders-pagination"
    >
      <div className="flex items-center gap-2 flex-wrap justify-center sm:justify-start">
        <span>
          显示第 <strong className="text-[var(--color-text)] font-semibold">{startRecord}-{endRecord}</strong> 笔，共 <strong className="text-[var(--color-text)] font-semibold">{total}</strong> 笔订单
        </span>
        {onPageSizeChange && (
          <div className="flex items-center gap-1 ml-1 sm:ml-2">
            <span className="text-[var(--color-text-muted)]">每页</span>
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              aria-label="每页显示条数"
              data-testid="orders-page-size-select"
              className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md px-1.5 py-0.5 text-xs text-[var(--color-text)] focus:outline-none focus:border-[var(--color-primary)] cursor-pointer"
            >
              <option value={10}>10 笔</option>
              <option value={20}>20 笔</option>
              <option value={30}>30 笔</option>
            </select>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 flex-wrap justify-center">
        <button
          type="button"
          onClick={() => onPageChange(clampedPage - 1)}
          disabled={clampedPage <= 1}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-[var(--color-primary)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
          data-testid="orders-page-prev"
          aria-label="上一页"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">上一页</span>
        </button>

        <div className="flex items-center gap-1">
          {getPageNumbers(clampedPage, totalPages).map((p, idx) => {
            if (typeof p === 'string') {
              return (
                <span key={`ellipsis-${idx}`} className="px-1 text-[var(--color-text-muted)]">
                  ...
                </span>
              )
            }
            const active = p === clampedPage
            return (
              <button
                key={p}
                type="button"
                onClick={() => onPageChange(p)}
                className={`min-w-8 h-8 px-2 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                  active
                    ? 'bg-[var(--color-primary)] text-white shadow-xs'
                    : 'bg-[var(--color-surface)] hover:bg-[var(--color-background)] border border-[var(--color-border)] text-[var(--color-text)]'
                }`}
                data-testid={`orders-page-number-${p}`}
                aria-current={active ? 'page' : undefined}
              >
                {p}
              </button>
            )
          })}
        </div>

        <button
          type="button"
          onClick={() => onPageChange(clampedPage + 1)}
          disabled={clampedPage >= totalPages}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-[var(--color-primary)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
          data-testid="orders-page-next"
          aria-label="下一页"
        >
          <span className="hidden sm:inline">下一页</span>
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}
