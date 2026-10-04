import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

// 商家后台各列表面板（商品/订单/结算）共用的表头单元格。
export function Th({ children, align }: { children: ReactNode; align?: 'left' | 'right' }) {
  return (
    <th className={`py-3 px-2 font-medium text-[var(--color-text-muted)] text-xs uppercase tracking-wider ${align === 'right' ? 'text-right' : 'text-left'}`}>
      {children}
    </th>
  )
}

// 商品/订单列表面板共用分页控件；pageSize 固定 20，与列表请求参数保持一致。
export function PaginationControls({ page, total, setPage, testId }: { page: number; total: number; setPage: (p: number) => void; testId?: string }) {
  const pageSize = 20
  const totalPages = Math.ceil(total / pageSize) || 1

  return (
    <div className="flex items-center justify-between mt-4 px-2 pb-2 border-t border-[var(--color-border)] pt-4" data-testid={testId}>
      <div className="text-sm text-[var(--color-text-muted)]">
        共 {total} 条记录，第 {page} / {totalPages} 页
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setPage(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="btn-secondary btn-sm disabled:opacity-50 flex items-center cursor-pointer"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <button
          onClick={() => setPage(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          className="btn-secondary btn-sm disabled:opacity-50 flex items-center cursor-pointer"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
