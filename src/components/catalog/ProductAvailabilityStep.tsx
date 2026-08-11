import { useEffect, useId, useState } from 'react'
import { ArchiveRestore, Minus, PackageOpen, Plus } from 'lucide-react'
import {
  getCapacityLabel,
  getOfferActionLabel,
  getOfferAvailabilityAction,
} from '../../api/catalog'
import type {
  AvailabilityOffer,
  CapacityAdjustRequest,
  VoidInventoryRequest,
} from '../../types/catalog'

interface Props {
  /** The product's Offers — the ONLY operation targets (never Product.stock). */
  offers: AvailabilityOffer[]
  /** Offer-scoped capacity adjustment callback (instant_fixed/manual_service limited). */
  onAdjustCapacity?: (request: CapacityAdjustRequest) => Promise<void> | void
  /** Offer-scoped inventory void callback (instant_inventory). */
  onVoidInventory?: (request: VoidInventoryRequest) => Promise<void> | void
  /** Open the delivery-inventory import flow for a specific Offer. */
  onOpenImport?: (offerId: number) => void
  /** Product-level aggregate of available instant-inventory units (display only). */
  productAvailableStock?: number
  /** External busy state (e.g. parent background refresh). */
  busy?: boolean
  disabled?: boolean
}

/**
 * Offer-first availability step (T-CAT-FE-001A primitive, spec §8.1 / D-CAT-12).
 *
 * Every availability mutation is Offer-scoped and mutually exclusive:
 * - instant_inventory  → import / void delivery inventory;
 * - limited non-instant → capacity adjustment;
 * - unlimited           → no restock action.
 *
 * The step never treats `Product.stock` as an operation target; with multiple
 * Offers the user selects the target Offer first. Duplicate submits are
 * guarded by a local in-flight state.
 */
export default function ProductAvailabilityStep({
  offers,
  onAdjustCapacity,
  onVoidInventory,
  onOpenImport,
  productAvailableStock,
  busy = false,
  disabled = false,
}: Props) {
  const capacityId = useId()
  const capacityDeltaId = useId()
  const reasonId = useId()
  const voidCountId = useId()
  const voidReasonId = useId()

  const [selectedOfferId, setSelectedOfferId] = useState<number | null>(null)
  const [capacityDelta, setCapacityDelta] = useState('')
  const [capacityReason, setCapacityReason] = useState('')
  const [voidCount, setVoidCount] = useState('')
  const [voidReason, setVoidReason] = useState('')
  const [submitting, setSubmitting] = useState<'capacity' | 'void' | null>(null)

  // Keep a valid selection when the offers list refreshes.
  useEffect(() => {
    setSelectedOfferId((current) => {
      if (current != null && offers.some((offer) => offer.id === current)) return current
      return offers[0]?.id ?? null
    })
  }, [offers])

  const selectedOffer = offers.find((offer) => offer.id === selectedOfferId) ?? offers[0] ?? null
  const action = selectedOffer ? getOfferAvailabilityAction(selectedOffer) : null
  const anyBusy = busy || submitting != null
  const lock = disabled || anyBusy

  function resetForms() {
    setCapacityDelta('')
    setCapacityReason('')
    setVoidCount('')
    setVoidReason('')
  }

  async function handleCapacity(event: React.FormEvent) {
    event.preventDefault()
    if (!selectedOffer || !onAdjustCapacity) return
    const delta = Number(capacityDelta)
    if (capacityDelta.trim() === '' || !Number.isInteger(delta) || delta === 0) return
    const reason = capacityReason.trim()
    if (!reason) return
    const current = selectedOffer.stock ?? selectedOffer.availableStock ?? 0
    if (current + delta < 0) return

    setSubmitting('capacity')
    try {
      await onAdjustCapacity({ offerId: selectedOffer.id, delta, reason })
      setCapacityDelta('')
      setCapacityReason('')
    } catch {
      // Parent owns the user-facing error toast. Preserve inputs for retry.
    } finally {
      setSubmitting(null)
    }
  }

  async function handleVoid(event: React.FormEvent) {
    event.preventDefault()
    if (!selectedOffer || !onVoidInventory) return
    const count = Number(voidCount)
    if (voidCount.trim() === '' || !Number.isInteger(count) || count <= 0) return
    const reason = voidReason.trim()
    if (!reason) return

    setSubmitting('void')
    try {
      await onVoidInventory({ offerId: selectedOffer.id, count, reason })
      setVoidCount('')
      setVoidReason('')
    } catch {
      // Parent owns the user-facing error toast. Preserve inputs for retry.
    } finally {
      setSubmitting(null)
    }
  }

  const capacityLabel = selectedOffer ? getCapacityLabel(selectedOffer.deliveryMode) : '名额'
  const delta = Number(capacityDelta)
  const validDelta = capacityDelta.trim() !== '' && Number.isInteger(delta) && delta !== 0
  const currentStock = action === 'inventory'
    ? (selectedOffer?.availableStock ?? selectedOffer?.stock ?? 0)
    : (selectedOffer?.stock ?? selectedOffer?.availableStock ?? 0)
  const wouldBecomeNegative = validDelta && currentStock + delta < 0

  return (
    <section
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      data-testid="product-availability-step"
      aria-label="可售量配置"
    >
      <h3 className="flex items-center gap-2 font-heading text-sm font-bold text-[var(--color-text)] mb-1">
        <PackageOpen className="w-4 h-4 text-[var(--color-text-muted)]" />
        可售量
      </h3>
      <p className="text-xs text-[var(--color-text-muted)] mb-4">
        保存草稿后独立补充可售量；每次操作都明确指定规格，不以商品总库存作为操作对象。
      </p>

      {offers.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]" data-testid="availability-empty">
          请先添加规格。
        </p>
      ) : (
        <>
          <div className="mb-4">
            <label htmlFor={capacityId} className="block text-xs font-bold text-[var(--color-text-muted)] mb-1.5 uppercase tracking-wider">
              目标规格
            </label>
            <select
              id={capacityId}
              className="input appearance-none cursor-pointer"
              value={selectedOffer?.id ?? ''}
              onChange={(event) => {
                setSelectedOfferId(event.target.value === '' ? null : Number(event.target.value))
                resetForms()
              }}
              disabled={lock}
              data-testid="availability-offer-select"
            >
              {offers.map((offer) => (
                <option key={offer.id} value={offer.id}>
                  {offer.name}（{getOfferActionLabel(getOfferAvailabilityAction(offer))}
                  {offer.status === 'inactive' ? ' · 已下架' : ''}）
                </option>
              ))}
            </select>
          </div>

          {!selectedOffer ? null : action === 'none' ? (
            <p className="text-sm text-[var(--color-text-muted)]" data-testid="availability-none">
              该规格不限量，无需补充库存。
            </p>
          ) : action === 'capacity' ? (
            <form className="space-y-4" onSubmit={handleCapacity} data-testid="availability-capacity-form">
              <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-3">
                <div className="text-xs font-medium text-[var(--color-text-muted)]">当前剩余{capacityLabel}</div>
                <div className="mt-1 font-mono text-2xl font-bold text-[var(--color-text)]" data-testid="availability-current-stock">
                  {currentStock}
                </div>
              </div>

              <div>
                <label htmlFor={capacityDeltaId} className="block text-sm font-bold text-[var(--color-text)] mb-1.5">
                  调整数量 <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  {validDelta && delta < 0 ? (
                    <Minus className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-danger)] pointer-events-none" />
                  ) : (
                    <Plus className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-cta)] pointer-events-none" />
                  )}
                  <input
                    id={capacityDeltaId}
                    type="number"
                    step="1"
                    required
                    className="input pl-9 font-mono"
                    placeholder="例如：10 或 -2"
                    value={capacityDelta}
                    onChange={(event) => setCapacityDelta(event.target.value)}
                    disabled={lock}
                    data-testid="availability-capacity-delta"
                  />
                </div>
                <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">正数补充，负数减少，不可为 0。</p>
                {validDelta && (
                  <p className={`mt-1.5 text-xs font-medium ${wouldBecomeNegative ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}>
                    调整后剩余：{currentStock + delta} 个{capacityLabel}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor={reasonId} className="block text-sm font-bold text-[var(--color-text)] mb-1.5">
                  调整原因 <span className="text-red-500">*</span>
                </label>
                <textarea
                  id={reasonId}
                  required
                  maxLength={500}
                  className="input min-h-[72px] resize-y"
                  placeholder="说明本次名额调整的原因"
                  value={capacityReason}
                  onChange={(event) => setCapacityReason(event.target.value)}
                  disabled={lock}
                  data-testid="availability-capacity-reason"
                />
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  className="btn-primary px-5 py-2"
                  disabled={lock || !validDelta || wouldBecomeNegative || !capacityReason.trim() || !onAdjustCapacity}
                  data-testid="availability-capacity-submit"
                >
                  {submitting === 'capacity' ? '提交中…' : `调整${capacityLabel}`}
                </button>
              </div>
            </form>
          ) : (
            <div className="space-y-4" data-testid="availability-inventory">
              <p className="text-xs text-[var(--color-text-muted)]">
                即时库存按「一个交付单元对应一位买家」管理。导入走独立交付库存流程；作废按规格执行。
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="availability-inventory-totals">
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-3">
                  <div className="text-xs font-medium text-[var(--color-text-muted)]">当前规格可用交付库存</div>
                  <div className="mt-1 font-mono text-2xl font-bold text-[var(--color-text)]" data-testid="availability-offer-stock">
                    {currentStock}
                  </div>
                </div>
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-4 py-3">
                  <div className="text-xs font-medium text-[var(--color-text-muted)]">商品交付库存汇总</div>
                  <div className="mt-1 font-mono text-2xl font-bold text-[var(--color-text)]" data-testid="availability-product-stock">
                    {productAvailableStock ?? '—'}
                  </div>
                </div>
              </div>

              {onOpenImport && (
                <button
                  type="button"
                  className="btn-secondary px-5 py-2"
                  onClick={() => onOpenImport(selectedOffer.id)}
                  disabled={lock}
                  data-testid="availability-open-import"
                >
                  <ArchiveRestore className="w-4 h-4" />
                  导入交付库存
                </button>
              )}

              {onVoidInventory && (
                <form className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-4" onSubmit={handleVoid}>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <div className="flex-1">
                      <label htmlFor={voidCountId} className="block text-sm font-bold text-[var(--color-text)] mb-1.5">
                        作废数量 <span className="text-red-500">*</span>
                      </label>
                      <input
                        id={voidCountId}
                        type="number"
                        step="1"
                        min="1"
                        required
                        className="input font-mono"
                        placeholder="0"
                        value={voidCount}
                        onChange={(event) => setVoidCount(event.target.value)}
                        disabled={lock}
                        data-testid="availability-void-count"
                      />
                    </div>
                    <div className="flex-[2]">
                      <label htmlFor={voidReasonId} className="block text-sm font-bold text-[var(--color-text)] mb-1.5">
                        作废原因 <span className="text-red-500">*</span>
                      </label>
                      <input
                        id={voidReasonId}
                        type="text"
                        required
                        maxLength={500}
                        className="input"
                        placeholder="如：库存失效"
                        value={voidReason}
                        onChange={(event) => setVoidReason(event.target.value)}
                        disabled={lock}
                        data-testid="availability-void-reason"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      className="btn-secondary px-5 py-2"
                      disabled={
                        lock ||
                        !onVoidInventory ||
                        voidCount.trim() === '' ||
                        !Number.isInteger(Number(voidCount)) ||
                        Number(voidCount) <= 0 ||
                        !voidReason.trim()
                      }
                      data-testid="availability-void-submit"
                    >
                      {submitting === 'void' ? '提交中…' : '作废交付库存'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
