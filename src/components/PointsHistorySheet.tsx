import { useEffect, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, Coins } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/Dialog'
import EmptyState from './ui/EmptyState'
import { Skeleton } from './ui/Skeleton'

const PAGE_SIZE = 30

interface PointsHistorySheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: any[]
  loading: boolean
}

/**
 * 积分流水明细（V3-T1）。原 Profile 底部 Tab 改为入口按钮 + 弹层：
 * 移动端经共享 DialogContent 自动呈现为 bottom sheet，免长滚动直达；
 * 桌面为居中弹窗。列表客户端分页（30 条/页「加载更多」），
 * 每次打开由父级重新拉取，数据始终新鲜。
 */
export default function PointsHistorySheet({ open, onOpenChange, items, loading }: PointsHistorySheetProps) {
  const [shown, setShown] = useState(PAGE_SIZE)

  // 每次打开重置分页位置
  useEffect(() => {
    if (open) setShown(PAGE_SIZE)
  }, [open])

  const visible = items.slice(0, shown)
  const hasMore = items.length > shown

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85dvh] flex flex-col" data-testid="points-history-sheet">
        <DialogTitle className="pr-10 flex items-center gap-2">
          <Coins className="w-5 h-5 text-[var(--color-cta)]" />
          积分变动明细
        </DialogTitle>
        <DialogDescription>每笔积分的来源与去向，按时间倒序排列。</DialogDescription>

        <div className="mt-4 -mr-2 pr-2 flex-1 min-h-0 overflow-y-auto" aria-live="polite">
          {loading ? (
            <div className="space-y-3 py-2" role="status" aria-label="加载中">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="w-8 h-8 rounded-full shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-2/3" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                  <Skeleton className="h-4 w-12 shrink-0" />
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState compact icon={Coins} title="暂无积分变动" description="每日签到即可获得第一笔积分" />
          ) : (
            <div className="space-y-2">
              {visible.map((item: any) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-3 p-3 border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--color-background)] rounded-lg transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center shadow-sm ${
                        item.type === 'in'
                          ? 'bg-[var(--color-cta)]/10 border border-[var(--color-cta)]/25 text-[var(--color-cta)]'
                          : 'bg-[var(--color-text-muted)]/15 border border-[var(--color-text-muted)]/25 text-[var(--color-text-muted)]'
                      }`}
                    >
                      {item.type === 'in' ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                    </div>
                    <div className="min-w-0">
                      <p className="font-bold text-xs text-[var(--color-text)] break-words">{item.reason}</p>
                      <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                        {new Date(item.createdAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  <div className={`shrink-0 font-bold text-sm ${item.type === 'in' ? 'text-[var(--color-cta)]' : 'text-[var(--color-text)]'}`}>
                    {item.type === 'in' ? '+' : '-'}{item.amount}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {!loading && hasMore && (
          <button
            type="button"
            onClick={() => setShown((n) => n + PAGE_SIZE)}
            className="btn-secondary btn-sm w-full mt-4 shrink-0"
            data-testid="points-history-load-more"
          >
            加载更多（剩余 {items.length - shown} 条）
          </button>
        )}
      </DialogContent>
    </Dialog>
  )
}
