import { AlertTriangle, CalendarDays, ShoppingBag } from 'lucide-react'
import type { Dispatch, SetStateAction } from 'react'
import type { ConfigRegistry } from '../../../types/config'
import type { MerchantOrder, MerchantStats } from '../../../types/merchant'
import { formatBookingDay } from '../../../utils/formatLocalDate'
import { PROCESSING_TIMEOUT_LABEL } from '../../../utils/settlementCopy'
import ProvisionBadge from '../../ProvisionBadge'
import EmptyState from '../../ui/EmptyState'
import RegistryPill from '../../ui/RegistryPill'
import { TableSkeleton } from '../../ui/Skeleton'
import { PaginationControls, Th } from './MerchantPanelPrimitives'
import { formatOrderRef } from '../../../utils/governance'
import { formatDateTime } from '../../../utils/datetime'

export type MerchantOrderAction =
  | 'start_fulfillment'
  | 'deliver'
  | 'respond_dispute'
  | 'reject'
  | 'post_progress'
  | 'report_unfulfillable'

export interface MerchantOrdersPanelProps {
  orders: MerchantOrder[]
  loading: boolean
  orderPage: number
  orderTotal: number
  setOrderPage: (page: number) => void
  orderStatusFilter: string
  setOrderStatusFilter: (value: string) => void
  orderSortBooking: boolean
  /** 保留父层原有函数式切换（v => !v），避免闭包旧值覆盖。 */
  setOrderSortBooking: Dispatch<SetStateAction<boolean>>
  /** 概览统计的待办计数；与父层 dashboard tab 共用同一份 stats。 */
  todo: MerchantStats['todo'] | undefined
  registry: ConfigRegistry | null
  onOrderAction: (action: MerchantOrderAction, order: MerchantOrder) => void
  pendingOrderIds?: ReadonlySet<number>
}

export default function MerchantOrdersPanel({
  orders,
  loading,
  orderPage,
  orderTotal,
  setOrderPage,
  orderStatusFilter,
  setOrderStatusFilter,
  orderSortBooking,
  setOrderSortBooking,
  todo,
  registry,
  onOrderAction,
  pendingOrderIds,
}: MerchantOrdersPanelProps) {
  return (
    <div className="fade-in">
      <h2 className="font-heading text-xl font-bold mb-4 text-[var(--color-text)]">订单管理</h2>

      <div className="grid grid-cols-3 gap-2 md:gap-3 mb-4" data-testid="merchant-order-todo">
        <button
          type="button"
          onClick={() => { setOrderStatusFilter('pending'); setOrderPage(1) }}
          className={`flex flex-col justify-between rounded-xl p-2.5 md:p-3.5 text-left cursor-pointer border bg-[var(--color-background)] transition-colors ${orderStatusFilter === 'pending' ? 'border-[var(--color-primary)] ring-1 ring-[var(--color-primary-tint-strong)]' : 'border-[var(--color-border)] hover:border-[var(--color-primary-border-subtle)]'}`}
        >
          <div className="text-[11px] md:text-xs text-[var(--color-text-muted)] font-semibold">待处理</div>
          <div className="mt-1 text-lg md:text-xl font-bold tabular-nums text-[var(--color-warning-accent)]">{todo?.pending ?? '—'}</div>
        </button>
        <button
          type="button"
          onClick={() => { setOrderStatusFilter('processing'); setOrderPage(1) }}
          className={`flex flex-col justify-between rounded-xl p-2.5 md:p-3.5 text-left cursor-pointer border bg-[var(--color-background)] transition-colors ${orderStatusFilter === 'processing' ? 'border-[var(--color-primary)] ring-1 ring-[var(--color-primary-tint-strong)]' : 'border-[var(--color-border)] hover:border-[var(--color-primary-border-subtle)]'}`}
        >
          <div className="text-[11px] md:text-xs text-[var(--color-text-muted)] font-semibold">履约中</div>
          <div className="mt-1 text-lg md:text-xl font-bold tabular-nums text-[var(--color-primary)]">{todo?.processing ?? '—'}</div>
        </button>
        <button
          type="button"
          onClick={() => { setOrderStatusFilter(''); setOrderPage(1) }}
          className="flex flex-col justify-between rounded-xl p-2.5 md:p-3.5 text-left cursor-pointer border border-[var(--color-border)] bg-[var(--color-background)] transition-colors hover:border-[var(--color-primary-border-subtle)]"
          data-testid="merchant-sla-todo"
        >
          <div className="text-[11px] md:text-xs text-[var(--color-text-muted)] font-semibold leading-snug">{PROCESSING_TIMEOUT_LABEL}</div>
          <div className="mt-1 text-lg md:text-xl font-bold tabular-nums text-[var(--color-danger)]">{todo?.slaExceeded ?? '—'}</div>
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select
          value={orderStatusFilter}
          onChange={(e) => { setOrderStatusFilter(e.target.value); setOrderPage(1) }}
          className="input py-1.5 w-40 appearance-none cursor-pointer"
          data-testid="merchant-order-status-filter"
        >
          <option value="">全部状态</option>
          {(registry?.orderStatuses ?? []).map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => { setOrderSortBooking(v => !v); setOrderPage(1) }}
          aria-pressed={orderSortBooking}
          className={`btn-secondary btn-sm ${
            orderSortBooking ? 'border-[var(--color-primary)] text-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)]' : ''
          }`}
          data-testid="merchant-orders-sort-booking"
        >
          <CalendarDays className="w-4 h-4" /> 按预约日期
        </button>
      </div>

      <div className="overflow-x-auto">
        {loading && orders.length === 0 ? (
          <TableSkeleton />
        ) : (
        <table className="table-cards w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-[var(--color-border)]">
              <Th>订单号</Th>
              <Th>商品</Th>
              <Th>用户</Th>
              <Th>金额/抽成</Th>
              <Th>结算金额</Th>
              <Th>状态</Th>
              <Th align="right">操作</Th>
            </tr>
          </thead>
          <tbody>
            {!loading && orders.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <EmptyState compact icon={ShoppingBag} title="你还没有订单" description="订单产生后将显示在这里" />
                </td>
              </tr>
            ) : (
              orders.map((o) => (
                <tr key={o.id} className="border-b border-[var(--color-border)] hover:bg-[var(--color-background)] transition-colors">
                  <td className="py-3 px-2.5 text-sm text-[var(--color-text-muted)] whitespace-nowrap" data-label="订单号">
                    <div className="flex flex-col max-md:items-end tabular-nums">
                      <div>{formatOrderRef(o.orderNo, o.id)}</div>
                      {typeof o.holdingPoints === 'number' && o.holdingPoints > 0 && (
                        <div className="text-xs text-[var(--color-text-muted)] mt-0.5">冻结 {o.holdingPoints}</div>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-2.5 text-sm font-medium text-[var(--color-text)] min-w-[150px]" data-label="商品">
                    <div className="flex flex-col max-md:items-end">
                      <div className="max-w-[220px] line-clamp-2 max-md:text-right" title={o.product?.name}>{o.product?.name}</div>
                      {o.offerNameSnapshot && o.offerNameSnapshot !== '默认规格' && (
                        <div className="mt-0.5 text-xs font-semibold text-[var(--color-text-muted)]">规格：{o.offerNameSnapshot}</div>
                      )}
                      {o.bookingDate && (
                        <div
                          className="mt-0.5 text-xs font-bold text-[var(--color-primary)]"
                          data-testid={`merchant-order-booking-${o.id}`}
                        >
                          预约日期 {formatBookingDay(o.bookingDate)}
                        </div>
                      )}
                      {o.product?.deliveryMode && <div className="mt-1"><RegistryPill value={o.product.deliveryMode} category="deliveryModes" /></div>}
                    </div>
                  </td>
                  <td className="py-3 px-2.5 text-sm text-[var(--color-text-muted)]" data-label="用户">
                    <span className="block max-w-[160px] truncate" title={o.user?.email}>{o.user?.email}</span>
                  </td>
                  <td className="py-3 px-2.5 text-sm text-[var(--color-text)] tabular-nums whitespace-nowrap" data-label="金额/抽成">
                    {o.price}积分 <span className="text-[var(--color-text-muted)]">(抽成 {(Number(o.commissionRate) * 100).toFixed(0)}%)</span>
                  </td>
                  <td className="py-3 px-2.5 text-sm font-bold text-[var(--color-cta)] tabular-nums whitespace-nowrap" data-label="结算金额">
                    {o.settlementAmount}积分
                  </td>
                  <td className="py-3 px-2.5 text-sm" data-label="状态">
                    <div className="flex flex-col max-md:items-end gap-1">
                      <RegistryPill value={o.status} category="orderStatuses" />
                      {o.slaExceeded && (
                        <span
                          className="inline-flex w-fit items-center gap-1 px-2 py-0.5 rounded text-xs font-bold border bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] text-[var(--color-danger)] border-[color-mix(in_srgb,var(--color-danger)_25%,transparent)] whitespace-nowrap"
                          data-testid={`sla-exceeded-badge-${o.id}`}
                        >
                          <AlertTriangle className="w-3 h-3" /> {PROCESSING_TIMEOUT_LABEL}
                        </span>
                      )}
                      {o.fulfillmentDeadline && (
                        <div className="text-xs text-[var(--color-text-muted)] whitespace-nowrap tabular-nums">
                          截止 {formatDateTime(o.fulfillmentDeadline)}
                        </div>
                      )}
                      {o.provisionTask && (
                        <div>
                          <ProvisionBadge task={o.provisionTask} idSuffix={o.id} />
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-2.5 text-right" data-label="操作">
                    <div className="flex flex-wrap items-center justify-end gap-1.5 min-w-[140px] max-w-[240px] ml-auto">
                      {o.availableActions?.includes('start_fulfillment') && (
                        <button type="button" onClick={() => onOrderAction('start_fulfillment', o)} disabled={pendingOrderIds?.has(o.id)} className="btn-secondary btn-sm whitespace-nowrap" data-testid={`merchant-start-order-${o.id}`}>
                          {pendingOrderIds?.has(o.id) ? '接单中…' : '开始履约'}
                        </button>
                      )}
                      {o.availableActions?.includes('reject') && (
                        <button
                          type="button"
                          onClick={() => onOrderAction('reject', o)}
                          disabled={pendingOrderIds?.has(o.id)}
                          className="btn-secondary btn-sm whitespace-nowrap border-[var(--color-danger)] text-[var(--color-danger)]"
                          data-testid={`merchant-reject-order-${o.id}`}
                        >
                          拒单
                        </button>
                      )}
                      {o.availableActions?.includes('post_progress') && (
                        <button
                          type="button"
                          onClick={() => onOrderAction('post_progress', o)}
                          className="btn-secondary btn-sm whitespace-nowrap"
                          data-testid={`merchant-post-progress-${o.id}`}
                        >
                          进度更新
                        </button>
                      )}
                      {o.availableActions?.includes('deliver') && (
                        <button type="button" onClick={() => onOrderAction('deliver', o)} className="btn-primary btn-sm whitespace-nowrap">
                          发货
                        </button>
                      )}
                      {o.availableActions?.includes('report_unfulfillable') && (
                        <button
                          type="button"
                          onClick={() => onOrderAction('report_unfulfillable', o)}
                          className="btn-secondary btn-sm whitespace-nowrap"
                          data-testid={`merchant-unfulfillable-${o.id}`}
                        >
                          无法履约
                        </button>
                      )}
                      {o.availableActions?.includes('respond_dispute') && (
                        <button type="button" onClick={() => onOrderAction('respond_dispute', o)} className="btn-secondary btn-sm whitespace-nowrap">
                          处理争议
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        )}
      </div>
      <PaginationControls page={orderPage} total={orderTotal} setPage={setOrderPage} />
    </div>
  )
}
