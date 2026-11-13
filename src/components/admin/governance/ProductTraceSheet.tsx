import { useEffect, useRef, useState } from 'react'
import { ArrowRight, ChevronLeft, Loader2 } from 'lucide-react'
import SideSheet from '../../ui/SideSheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/Tabs'
import { getInventoryBatch, listInventoryBatches, listOfferRevisions, voidInventoryBatch, type TraceScope } from '../../../api/governance'
import { useCursorList } from '../../../hooks/useCursorList'
import { useAppStore } from '../../../stores/appStore'
import type { GVCommercialSnapshot, GVInventoryBatch, GVInventoryBatchDetail, GVOfferRevision } from '../../../types/governance'
import { IntentKey, classifyGovernanceError, formatDateTime, formatOrderRef, type GovernanceFailure } from '../../../utils/governance'
import { ConflictNotice, ForbiddenNotice, LoadMore, Notice, ReasonFields, StatusChip, type ReasonOption } from './GovernanceKit'

export interface TraceProduct {
  id: number
  name: string
  offers?: Array<{ id: number; name: string }>
}

interface Props {
  scope: TraceScope
  product: TraceProduct | null
  canReadBatches: boolean
  canVoid: boolean
  canReadRevisions: boolean
  onOpenChange: (open: boolean) => void
  /** After a void, so stock counts elsewhere refresh. */
  onInventoryChanged?: () => void
}

const VOID_REASONS: ReasonOption[] = [
  { value: 'invalid_stock', label: '库存内容失效' },
  { value: 'imported_by_mistake', label: '误导入' },
  { value: 'supplier_recall', label: '上游召回' },
  { value: 'other', label: '其他' },
]

const FIELD_LABEL: Record<keyof GVCommercialSnapshot, string> = {
  name: '名称',
  price: '价格',
  originalPrice: '划线价',
  validityDays: '有效天数',
  status: '状态',
  fulfillmentType: '交付方式',
  inventoryMode: '库存模式',
  isDefault: '默认规格',
  autoProvision: '自动开通',
  externalSkuId: '上游 SKU',
}

/** Batch traceability + commercial revision history for one product, merchant or admin scope. */
export default function ProductTraceSheet({
  scope,
  product,
  canReadBatches,
  canVoid,
  canReadRevisions,
  onOpenChange,
  onInventoryChanged,
}: Props) {
  const [tab, setTab] = useState<'batches' | 'revisions'>('batches')
  const [batchId, setBatchId] = useState<string | null>(null)

  useEffect(() => {
    setTab(canReadBatches ? 'batches' : 'revisions')
    setBatchId(null)
  }, [product?.id, canReadBatches])

  return (
    <SideSheet
      open={product !== null}
      onOpenChange={onOpenChange}
      testId="product-trace-sheet"
      title={product?.name ?? ''}
      description="库存批次与规格商业配置的变更记录"
    >
      {product && (
        <Tabs value={tab} onValueChange={(v) => { setTab(v as typeof tab); setBatchId(null) }}>
          <TabsList>
            {canReadBatches && <TabsTrigger value="batches">库存批次</TabsTrigger>}
            {canReadRevisions && <TabsTrigger value="revisions">规格修订</TabsTrigger>}
          </TabsList>
          {canReadBatches && (
            <TabsContent value="batches">
              {batchId ? (
                <BatchDetail
                  scope={scope}
                  productId={product.id}
                  batchId={batchId}
                  offerName={(id) => product.offers?.find((o) => o.id === id)?.name}
                  canVoid={canVoid}
                  onBack={() => setBatchId(null)}
                  onVoided={onInventoryChanged}
                />
              ) : (
                <BatchList scope={scope} product={product} onOpen={setBatchId} />
              )}
            </TabsContent>
          )}
          {canReadRevisions && (
            <TabsContent value="revisions">
              <RevisionHistory scope={scope} product={product} />
            </TabsContent>
          )}
        </Tabs>
      )}
    </SideSheet>
  )
}

function StockBar({ batch }: { batch: GVInventoryBatch }) {
  const total = Math.max(batch.importedCount, 1)
  const seg = (n: number) => `${(n / total) * 100}%`
  return (
    <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-[var(--color-background)]" aria-hidden="true">
      <span className="bg-[var(--color-primary)]" style={{ width: seg(batch.soldCount) }} />
      <span className="bg-[var(--color-success)]" style={{ width: seg(batch.availableCount) }} />
      <span className="bg-[var(--color-text-muted)] opacity-50" style={{ width: seg(batch.voidCount) }} />
    </div>
  )
}

function BatchList({ scope, product, onOpen }: { scope: TraceScope; product: TraceProduct; onOpen: (id: string) => void }) {
  const list = useCursorList<GVInventoryBatch>(
    `${scope}:batches:${product.id}`,
    ({ cursor, signal }) => listInventoryBatches(scope, product.id, { cursor, signal }),
  )
  if (list.forbidden) return <ForbiddenNotice what="库存批次" />
  if (list.error) return <Notice tone="danger" role="alert" title="加载库存批次失败">{list.error}</Notice>
  if (list.loading && list.items.length === 0) return <Loading />
  if (list.items.length === 0) {
    return <p className="py-6 text-center text-xs text-[var(--color-text-muted)]">还没有可追溯的导入批次。功能上线前导入的库存不归属任何批次。</p>
  }
  return (
    <div className="space-y-2" data-testid="inventory-batch-list">
      <div className="flex gap-3 text-[11px] text-[var(--color-text-muted)]">
        <Legend className="bg-[var(--color-primary)]" label="已售" />
        <Legend className="bg-[var(--color-success)]" label="可售" />
        <Legend className="bg-[var(--color-text-muted)] opacity-50" label="已作废" />
      </div>
      {list.items.map((b) => (
        <button
          key={b.id}
          type="button"
          onClick={() => onOpen(b.id)}
          className="w-full rounded-xl border border-[var(--color-border)] p-3 text-left transition-colors hover:bg-[var(--color-background)] cursor-pointer"
          data-testid={`inventory-batch-${b.id}`}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold">{product.offers?.find((o) => o.id === b.offerId)?.name ?? `规格 #${b.offerId}`}</div>
              <div className="text-[11px] text-[var(--color-text-muted)]">
                {formatDateTime(b.createdAt)} 导入 {b.importedCount} 件{b.actorUserId !== null ? ` · U${b.actorUserId}` : ''}
              </div>
            </div>
            <div className="shrink-0 text-right text-xs tabular-nums">
              <span className="font-semibold text-[var(--color-success-text)]">{b.availableCount}</span>
              <span className="text-[var(--color-text-muted)]"> 可售 / {b.soldCount} 已售</span>
            </div>
          </div>
          <StockBar batch={b} />
        </button>
      ))}
      <LoadMore hasNextPage={list.hasNextPage} loadingMore={list.loadingMore} onLoadMore={list.loadMore} />
    </div>
  )
}

function BatchDetail({
  scope,
  productId,
  batchId,
  offerName,
  canVoid,
  onBack,
  onVoided,
}: {
  scope: TraceScope
  productId: number
  batchId: string
  offerName: (offerId: number) => string | undefined
  canVoid: boolean
  onBack: () => void
  onVoided?: () => void
}) {
  const showToast = useAppStore((s) => s.showToast)
  const [detail, setDetail] = useState<GVInventoryBatchDetail | null>(null)
  const [orders, setOrders] = useState<GVInventoryBatchDetail['orders']>([])
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [voiding, setVoiding] = useState(false)
  const [reasonCode, setReasonCode] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<GovernanceFailure | null>(null)
  const intentKey = useRef(new IntentKey())
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setError(null)
    getInventoryBatch(scope, productId, batchId, { signal: controller.signal })
      .then((d) => {
        if (controller.signal.aborted) return
        setDetail(d)
        setOrders(d.orders)
      })
      .catch((err) => { if (!controller.signal.aborted) setError(classifyGovernanceError(err, '加载批次详情失败').message) })
    return () => controller.abort()
  }, [scope, productId, batchId, generation])

  async function loadMoreOrders() {
    if (!detail?.pageInfo.nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const next = await getInventoryBatch(scope, productId, batchId, { cursor: detail.pageInfo.nextCursor })
      setDetail(next)
      setOrders((prev) => [...prev, ...next.orders])
    } catch (err) {
      showToast(classifyGovernanceError(err, '加载失败').message, 'error')
    } finally {
      setLoadingMore(false)
    }
  }

  async function submitVoid() {
    if (!detail || !reasonCode || !note.trim() || submitting) return
    const input = { reasonCode, note: note.trim() }
    const key = intentKey.current.for({ batchId, ...input })
    setSubmitting(true)
    setFailure(null)
    try {
      const result = await voidInventoryBatch(scope, productId, batchId, input, key)
      intentKey.current.reset()
      setDetail({ ...detail, batch: result.batch })
      setVoiding(false)
      setReasonCode('')
      setNote('')
      showToast(result.replayed ? '该作废已执行过，未重复处理' : `已作废 ${result.voidedCount} 件可售库存`)
      onVoided?.()
    } catch (err) {
      const f = classifyGovernanceError(err, '作废失败')
      if (f.kind !== 'unconfirmed') intentKey.current.reset()
      setFailure(f)
      if (f.kind === 'conflict' || f.kind === 'unconfirmed') setGeneration((g) => g + 1)
    } finally {
      setSubmitting(false)
    }
  }

  const back = (
    <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--color-primary)] hover:underline cursor-pointer">
      <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />全部批次
    </button>
  )
  if (error) return <div className="space-y-3">{back}<Notice tone="danger" role="alert" title="加载批次详情失败">{error}</Notice></div>
  if (!detail) return <div className="space-y-3">{back}<Loading /></div>
  const b = detail.batch

  return (
    <div className="space-y-5" data-testid="inventory-batch-detail">
      {back}
      <div className="rounded-xl border border-[var(--color-border)] p-4">
        <div className="text-sm font-bold">{offerName(b.offerId) ?? `规格 #${b.offerId}`}</div>
        <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
          批次 <span className="font-mono">{b.id.slice(0, 8)}</span> · {formatDateTime(b.createdAt)}{b.actorUserId !== null ? ` · 导入人 U${b.actorUserId}` : ''}
        </div>
        <dl className="mt-3 grid grid-cols-4 gap-2 text-center">
          {[
            ['导入', b.importedCount],
            ['可售', b.availableCount],
            ['已售', b.soldCount],
            ['已作废', b.voidCount],
          ].map(([label, n]) => (
            <div key={label as string} className="rounded-lg bg-[var(--color-background)] py-2">
              <dt className="text-[11px] text-[var(--color-text-muted)]">{label}</dt>
              <dd className="text-lg font-bold tabular-nums">{n}</dd>
            </div>
          ))}
        </dl>
        <StockBar batch={b} />
      </div>

      {canVoid && b.availableCount > 0 && !voiding && (
        <button type="button" className="btn-tonal !bg-[var(--color-danger-bg)] !text-[var(--color-danger-text)]" onClick={() => setVoiding(true)} data-testid="inventory-batch-void-start">
          作废剩余 {b.availableCount} 件可售库存
        </button>
      )}
      {voiding && (
        <div className="space-y-3 rounded-xl border border-[var(--color-danger-border)] p-4" data-testid="inventory-batch-void-form">
          <p className="text-xs text-[var(--color-text-muted)]">只作废仍可售的条目，已售订单与交付记录不受影响。作废后不可恢复。</p>
          {failure?.kind === 'conflict' && <ConflictNotice message="批次库存已变化。" />}
          {failure && failure.kind !== 'conflict' && <Notice tone={failure.kind === 'unconfirmed' ? 'warning' : 'danger'} role="alert" title="作废未确认">{failure.message}</Notice>}
          <ReasonFields options={VOID_REASONS} reasonCode={reasonCode} onReasonCodeChange={setReasonCode} note={note} onNoteChange={setNote} disabled={submitting} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary btn-sm" disabled={submitting} onClick={() => setVoiding(false)}>取消</button>
            <button type="button" className="btn-primary btn-sm !bg-[var(--color-danger)] !shadow-none" disabled={submitting || !reasonCode || !note.trim()} onClick={() => void submitVoid()} data-testid="inventory-batch-void-submit">
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}确认作废
            </button>
          </div>
        </div>
      )}

      <div>
        <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">已售订单</h4>
        {orders.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">该批次还没有售出。</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5" data-testid="inventory-batch-orders">
            {orders.map((o) => (
              <li key={o.id} className="rounded-md border border-[var(--color-border)] px-2 py-1 font-mono text-[11px]" title={`订单 ID ${o.id}`}>
                {formatOrderRef(o.orderNo, o.id)}
              </li>
            ))}
          </ul>
        )}
        {detail.pageInfo.hasNextPage && (
          <div className="mt-2">
            <LoadMore hasNextPage loadingMore={loadingMore} onLoadMore={() => void loadMoreOrders()} />
          </div>
        )}
      </div>
    </div>
  )
}

function formatSnapshotValue(key: keyof GVCommercialSnapshot, value: unknown): string {
  if (value === undefined) return '—'
  if (value === null) return '无'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (key === 'price' || key === 'originalPrice') return `${value} 积分`
  return String(value)
}

function RevisionHistory({ scope, product }: { scope: TraceScope; product: TraceProduct }) {
  const offers = product.offers ?? []
  const [offerId, setOfferId] = useState<number | null>(offers[0]?.id ?? null)
  useEffect(() => setOfferId(product.offers?.[0]?.id ?? null), [product.id])

  const list = useCursorList<GVOfferRevision>(
    `${scope}:revisions:${product.id}:${offerId}`,
    ({ cursor, signal }) => listOfferRevisions(scope, product.id, offerId!, { cursor, signal }),
    offerId !== null,
  )

  if (offers.length === 0) return <p className="py-6 text-center text-xs text-[var(--color-text-muted)]">该商品没有规格。</p>

  return (
    <div className="space-y-3" data-testid="offer-revision-history">
      {offers.length > 1 && (
        <label className="block text-xs font-semibold">
          规格
          <select className="input mt-1 py-1.5 text-sm" value={offerId ?? ''} onChange={(e) => setOfferId(Number(e.target.value))}>
            {offers.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
      )}
      {list.forbidden ? (
        <ForbiddenNotice what="规格修订记录" />
      ) : list.error ? (
        <Notice tone="danger" role="alert" title="加载修订记录失败">{list.error}</Notice>
      ) : list.loading && list.items.length === 0 ? (
        <Loading />
      ) : list.items.length === 0 ? (
        <p className="py-6 text-center text-xs text-[var(--color-text-muted)]">没有修订记录。</p>
      ) : (
        <ol className="space-y-2">
          {list.items.map((r) => (
            <li key={r.id} className="rounded-xl border border-[var(--color-border)] p-3" data-testid={`offer-revision-${r.revision}`}>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-bold">第 {r.revision} 次修订</span>
                {r.actorType === 'migration' && <StatusChip status={{ label: '历史基线', tone: 'neutral' }} />}
                {r.actorType === 'system' && <StatusChip status={{ label: '系统同步', tone: 'info' }} />}
                {r.beforeSafe === null && r.actorType !== 'migration' && <StatusChip status={{ label: '初始配置', tone: 'neutral' }} />}
                <span className="text-[11px] text-[var(--color-text-muted)]">
                  {formatDateTime(r.createdAt)}{r.actorUserId !== null ? ` · U${r.actorUserId}` : ''} · {r.reasonCode}
                </span>
              </div>
              {r.actorType === 'migration' ? (
                <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">升级时记录的配置快照，不代表一次真实改价。</p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {r.changedFields.map((f) => {
                    const key = f as keyof GVCommercialSnapshot
                    return (
                      <li key={f} className="flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="w-20 shrink-0 text-[var(--color-text-muted)]">{FIELD_LABEL[key] ?? f}</span>
                        {r.beforeSafe && (
                          <>
                            <span className="line-through text-[var(--color-text-muted)]">{formatSnapshotValue(key, r.beforeSafe[key])}</span>
                            <ArrowRight className="h-3 w-3 text-[var(--color-text-muted)]" aria-hidden="true" />
                          </>
                        )}
                        <span className="font-semibold">{formatSnapshotValue(key, r.afterSafe[key])}</span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
      <LoadMore hasNextPage={list.hasNextPage} loadingMore={list.loadingMore} onLoadMore={list.loadMore} />
    </div>
  )
}

function Legend({ className, label }: { className: string; label: string }) {
  return <span className="inline-flex items-center gap-1"><span className={`h-2 w-2 rounded-full ${className}`} aria-hidden="true" />{label}</span>
}

function Loading() {
  return <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />加载中…</div>
}
