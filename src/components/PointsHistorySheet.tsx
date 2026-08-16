import { useEffect, useState } from 'react'
import {
  ArrowDownLeft,
  ArrowUpRight,
  Coins,
  Lock,
  Unlock,
  RotateCcw,
  ChevronRight,
  ExternalLink,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/Dialog'
import EmptyState from './ui/EmptyState'
import { Skeleton } from './ui/Skeleton'
import { formatPointLogAmount, pointLogVisual, type PointLogType } from '../utils/pointLogDisplay'

const PAGE_SIZE = 30

export interface PointsHistoryItem {
  id: number
  type: PointLogType
  amount: number
  balanceAfter?: number | null
  reason: string
  orderId?: number | null
  createdAt: string
}

interface PointsHistorySheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: PointsHistoryItem[]
  loading: boolean
}

function TypeIcon({ type }: { type: PointLogType }) {
  const cls = 'w-4 h-4'
  switch (type) {
    case 'in':
      return <ArrowDownLeft className={cls} />
    case 'out':
      return <ArrowUpRight className={cls} />
    case 'hold':
      return <Lock className={cls} />
    case 'release':
      return <Unlock className={cls} />
    case 'refund':
      return <RotateCcw className={cls} />
    default:
      return <Coins className={cls} />
  }
}

/**
 * 积分流水明细（V3-T1）。
 * - hold 与 out 分色：冻结=warning+锁，扣除=danger，避免「扣两次」误会
 * - 点击行展开详情（类型说明、变动后余额、关联订单入口）
 */
export default function PointsHistorySheet({ open, onOpenChange, items, loading }: PointsHistorySheetProps) {
  const navigate = useNavigate()
  const [shown, setShown] = useState(PAGE_SIZE)
  const [selected, setSelected] = useState<PointsHistoryItem | null>(null)

  useEffect(() => {
    if (open) {
      setShown(PAGE_SIZE)
      setSelected(null)
    }
  }, [open])

  const visible = items.slice(0, shown)
  const hasMore = items.length > shown

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg max-h-[85dvh] flex flex-col" data-testid="points-history-sheet">
          <DialogTitle className="pr-10 flex items-center gap-2">
            <Coins className="w-5 h-5 text-[var(--color-cta)]" />
            积分变动明细
          </DialogTitle>
          <DialogDescription>
            入账 / 待支付 / 已支付 / 已返还。人工服务下单后，积分会暂时锁定；订单完成后才正式支付，取消或退款后会自动返还。
          </DialogDescription>

          <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-[var(--color-text-muted)]">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-[var(--color-cta)]/25 bg-[var(--color-cta)]/8 text-[var(--color-cta)]">
              入账 +
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-[var(--color-danger)]/25 bg-[var(--color-danger)]/8 text-[var(--color-danger)]">
              已支付 −
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 text-[var(--color-warning)]">
              待支付
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-[var(--color-primary)]/25 bg-[var(--color-primary)]/8 text-[var(--color-primary)]">
              已返还
            </span>
          </div>

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
              <div className="space-y-1">
                {visible.map(item => {
                  const visual = pointLogVisual(item.type)
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSelected(item)}
                      data-testid={`points-history-row-${item.id}`}
                      className="w-full flex items-center justify-between gap-3 p-3 border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--color-background)] rounded-lg transition-colors cursor-pointer text-left focus-visible:outline-none focus-visible:[box-shadow:var(--shadow-focus)]"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center shadow-sm ${visual.iconWrapClass}`}
                        >
                          <TypeIcon type={item.type} />
                        </div>
                        <div className="min-w-0">
                          <p className="font-bold text-xs text-[var(--color-text)] break-words line-clamp-2">
                            {item.reason}
                          </p>
                          <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span
                              className={`font-semibold ${
                                item.type === 'hold'
                                  ? 'text-[var(--color-warning)]'
                                  : item.type === 'out'
                                    ? 'text-[var(--color-danger)]'
                                    : 'text-[var(--color-text-muted)]'
                              }`}
                            >
                              {visual.typeLabel}
                            </span>
                            <span>{new Date(item.createdAt).toLocaleString()}</span>
                          </p>
                        </div>
                      </div>
                      <div className="shrink-0 flex items-center gap-1">
                        <span className={`font-bold text-sm tabular-nums ${visual.amountClass}`}>
                          {formatPointLogAmount(item.type, item.amount)}
                        </span>
                        <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] opacity-60" />
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {!loading && hasMore && (
            <button
              type="button"
              onClick={() => setShown(n => n + PAGE_SIZE)}
              className="btn-secondary btn-sm w-full mt-4 shrink-0"
              data-testid="points-history-load-more"
            >
              加载更多（剩余 {items.length - shown} 条）
            </button>
          )}
        </DialogContent>
      </Dialog>

      {/* 单笔详情 */}
      <Dialog open={selected != null} onOpenChange={o => { if (!o) setSelected(null) }}>
        <DialogContent className="max-w-sm" data-testid="points-history-detail">
          {selected && (() => {
            const visual = pointLogVisual(selected.type)
            return (
              <>
                <DialogTitle className="pr-10 flex items-center gap-2">
                  <span
                    className={`w-8 h-8 rounded-full flex items-center justify-center ${visual.iconWrapClass}`}
                  >
                    <TypeIcon type={selected.type} />
                  </span>
                  积分{visual.typeLabel}详情
                </DialogTitle>
                <DialogDescription className="sr-only">单笔积分流水详情</DialogDescription>

                <dl className="mt-4 space-y-3 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-[var(--color-text-muted)] shrink-0">类型</dt>
                    <dd className={`font-bold ${visual.amountClass}`}>{visual.typeLabel}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-[var(--color-text-muted)] shrink-0">金额</dt>
                    <dd className={`font-bold tabular-nums ${visual.amountClass}`}>
                      {formatPointLogAmount(selected.type, selected.amount)}
                    </dd>
                  </div>
                  {selected.balanceAfter != null && (
                    <div className="flex justify-between gap-3">
                      <dt className="text-[var(--color-text-muted)] shrink-0">变动后可用余额</dt>
                      <dd className="font-mono font-bold text-[var(--color-text)]">
                        {selected.balanceAfter}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt className="text-[var(--color-text-muted)] mb-1">说明</dt>
                    <dd className="font-medium text-[var(--color-text)] break-words leading-relaxed">
                      {selected.reason}
                    </dd>
                  </div>
                  {visual.hint && (
                    <p className="text-xs text-[var(--color-text-muted)] leading-relaxed bg-[var(--color-background)] border border-[var(--color-border)] rounded-lg p-3">
                      {visual.hint}
                    </p>
                  )}
                  <div className="flex justify-between gap-3 text-xs text-[var(--color-text-muted)]">
                    <span>时间</span>
                    <span>{new Date(selected.createdAt).toLocaleString()}</span>
                  </div>
                  {selected.orderId != null && (
                    <div className="flex justify-between gap-3 text-xs">
                      <span className="text-[var(--color-text-muted)]">关联订单</span>
                      <span className="font-mono font-bold text-[var(--color-text)]">#{selected.orderId}</span>
                    </div>
                  )}
                </dl>

                <div className="mt-5 flex flex-col gap-2">
                  {selected.orderId != null && (
                    <button
                      type="button"
                      className="btn-primary w-full"
                      data-testid="points-history-open-order"
                      onClick={() => {
                        setSelected(null)
                        onOpenChange(false)
                        // 独立 /orders 页上线后可改为 /orders?highlight=
                        navigate('/profile')
                      }}
                    >
                      <ExternalLink className="w-4 h-4" /> 去个人中心查看订单
                    </button>
                  )}
                  <button type="button" className="btn-secondary w-full" onClick={() => setSelected(null)}>
                    关闭
                  </button>
                </div>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>
    </>
  )
}
