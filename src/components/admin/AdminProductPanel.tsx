import { useEffect, useRef, useState } from 'react'
import {
  Package,
  Pencil,
  Archive,
  RefreshCw,
  RotateCcw,
  Upload,
} from 'lucide-react'
import {
  getAdminProducts,
  archiveAdminProduct,
  restoreAdminProduct,
  setAdminFakaCapacity,
  unpublishAdminProduct,
  type AdminProductListItem,
} from '../../api/admin'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import { createLatestRequestGuard } from '../../utils/latestRequest'
import { TableSkeleton } from '../ui/Skeleton'
import EmptyState from '../ui/EmptyState'
import ConfirmDialog from '../ui/ConfirmDialog'
import { Dialog, DialogContent, DialogTitle } from '../ui/Dialog'
import AdminPlatformProductWizard from '../catalog/AdminPlatformProductWizard'
import AdminFakaImportPreview from '../catalog/AdminFakaImportPreview'
import AdminProductPublicationDialog, {
  type AdminPublicationTarget,
} from '../catalog/AdminProductPublicationDialog'
import AdminProductEditDialog from '../catalog/AdminProductEditDialog'
import AdminOfferManagerModal from '../catalog/AdminOfferManagerModal'
import AdminFakaSyncDialog from '../catalog/AdminFakaSyncDialog'
import AdminInventoryImportPreview, {
  type AdminInventoryTarget,
} from '../catalog/AdminInventoryImportPreview'

interface Props {
  active?: boolean
}

function adminProductStatusLabel(status: string): string {
  if (status === 'draft') return '草稿'
  if (status === 'active') return '已发布'
  if (status === 'inactive') return '已下架'
  return '状态未知'
}

export default function AdminProductPanel({ active = true }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [products, setProducts] = useState<AdminProductListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [productsRefreshError, setProductsRefreshError] = useState(false)
  const [productsReloading, setProductsReloading] = useState(false)
  const [archivedFilter, setArchivedFilter] = useState<'exclude' | 'only' | 'all'>('exclude')

  const [inventoryTarget, setInventoryTarget] = useState<AdminInventoryTarget | null>(null)
  const [showPlatformProduct, setShowPlatformProduct] = useState(false)

  // FakaBridge capacity edit (admin only)
  const [fakaCapProduct, setFakaCapProduct] = useState<AdminProductListItem | null>(null)
  const [fakaCapInput, setFakaCapInput] = useState('')
  const [fakaCapUnlimited, setFakaCapUnlimited] = useState(false)
  const [fakaCapSaving, setFakaCapSaving] = useState(false)

  // FakaBridge mandatory preview → idempotent confirm.
  const [showFakaImport, setShowFakaImport] = useState(false)
  const [publicationTarget, setPublicationTarget] = useState<AdminPublicationTarget | null>(null)
  const [unpublishingProductIds, setUnpublishingProductIds] = useState<Set<number>>(new Set())
  const [editProduct, setEditProduct] = useState<AdminProductListItem | null>(null)
  const [offerProduct, setOfferProduct] = useState<AdminProductListItem | null>(null)
  const [syncProduct, setSyncProduct] = useState<AdminProductListItem | null>(null)

  // ConfirmDialog states
  const [unpublishTarget, setUnpublishTarget] = useState<AdminProductListItem | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<AdminProductListItem | null>(null)
  const [archiving, setArchiving] = useState(false)

  const unpublishingRef = useRef<Set<number>>(new Set())
  const productsReloadGuard = useRef(createLatestRequestGuard()).current

  async function reloadProducts(): Promise<AdminProductListItem[]> {
    const canCommit = productsReloadGuard.begin()
    setProductsReloading(true)
    setLoading(true)
    try {
      const data = await getAdminProducts({ archived: archivedFilter })
      if (!canCommit()) {
        const stale = new Error('stale-products-reload')
        stale.name = 'StaleProductsReloadError'
        throw stale
      }
      setProducts(data)
      setProductsRefreshError(false)
      return data
    } catch (err) {
      if (!canCommit() || (err instanceof Error && err.name === 'StaleProductsReloadError')) {
        const stale =
          err instanceof Error && err.name === 'StaleProductsReloadError'
            ? err
            : Object.assign(new Error('stale-products-reload'), { name: 'StaleProductsReloadError' })
        throw stale
      }
      setProductsRefreshError(true)
      throw err
    } finally {
      if (canCommit()) {
        setLoading(false)
        setProductsReloading(false)
      }
    }
  }

  useEffect(() => {
    if (!active) {
      productsReloadGuard.invalidate()
      setProductsReloading(false)
      return
    }
    void reloadProducts().catch((err) => {
      if (err instanceof Error && err.name === 'StaleProductsReloadError') return
      showToast(getApiErrorMessage(err, '加载失败'), 'error')
    })
    return () => {
      productsReloadGuard.invalidate()
      setProductsReloading(false)
    }
  }, [active, archivedFilter])

  function triggerSafeReload() {
    void reloadProducts().catch((err) => {
      if (!(err instanceof Error && err.name === 'StaleProductsReloadError')) {
        showToast(getApiErrorMessage(err, '加载失败'), 'error')
      }
    })
  }

  function openPublication(product: AdminProductListItem, origin: AdminPublicationTarget['origin']) {
    setPublicationTarget({
      id: product.id,
      name: product.name,
      offers: (product.offers ?? []).map((offer) => ({ id: offer.id, name: offer.name })),
      origin,
    })
  }

  async function handleImportedPlatformProduct(result: {
    productId: number
    productName: string
    origin: 'xboard-import'
  }) {
    let items: AdminProductListItem[] | undefined
    try {
      items = await reloadProducts()
    } catch (err) {
      if (!(err instanceof Error && err.name === 'StaleProductsReloadError')) {
        showToast(getApiErrorMessage(err, '加载失败'), 'error')
      }
    }
    const imported = items?.find((item) => item.id === result.productId)
    setPublicationTarget({
      id: result.productId,
      name: result.productName,
      offers: (imported?.offers ?? []).map((offer) => ({ id: offer.id, name: offer.name })),
      origin: result.origin,
    })
  }

  function releaseUnpublishLock(productId: number) {
    unpublishingRef.current.delete(productId)
    setUnpublishingProductIds(new Set(unpublishingRef.current))
  }

  async function executeUnpublishPlatformProduct(product: AdminProductListItem) {
    if (productsRefreshError || unpublishingRef.current.has(product.id)) return
    unpublishingRef.current.add(product.id)
    setUnpublishingProductIds(new Set(unpublishingRef.current))
    try {
      await unpublishAdminProduct(product.id)
      setUnpublishTarget(null)
    } catch (err) {
      showToast(getApiErrorMessage(err, '下架失败'), 'error')
      releaseUnpublishLock(product.id)
      return
    }
    try {
      await reloadProducts()
      showToast(`“${product.name}”已下架`)
    } catch (err) {
      if (!(err instanceof Error && err.name === 'StaleProductsReloadError')) {
        showToast(`“${product.name}”已下架，但列表刷新失败，请重试`)
      }
    } finally {
      releaseUnpublishLock(product.id)
    }
  }

  async function executeArchiveProduct(product: AdminProductListItem) {
    if (archiving) return
    setArchiving(true)
    try {
      await archiveAdminProduct(product.id)
      showToast('商品已归档')
      setArchiveTarget(null)
    } catch (err) {
      showToast(getApiErrorMessage(err, '归档失败'), 'error')
      return
    } finally {
      setArchiving(false)
    }
    try {
      await reloadProducts()
    } catch (err) {
      if (!(err instanceof Error && err.name === 'StaleProductsReloadError')) {
        showToast(getApiErrorMessage(err, '加载失败'), 'error')
      }
    }
  }

  return (
    <div className="space-y-4">
      {productsRefreshError && (
        <div
          data-testid="admin-products-refresh-error"
          role="alert"
          className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-xs text-red-700 dark:text-red-400 flex items-center justify-between gap-3 flex-wrap"
        >
          <span>商品列表刷新失败，当前展示的可能不是最新状态。</span>
          <button
            type="button"
            data-testid="admin-products-refresh-retry"
            disabled={productsReloading}
            className="btn-secondary btn-sm text-xs px-3 py-1 cursor-pointer disabled:opacity-50"
            onClick={async () => {
              try {
                await reloadProducts()
              } catch (err) {
                if (err instanceof Error && err.name === 'StaleProductsReloadError') return
                showToast(getApiErrorMessage(err, '刷新列表失败'), 'error')
              }
            }}
          >
            刷新列表
          </button>
        </div>
      )}
      <div className="flex justify-between items-center mb-4 gap-3 flex-wrap">
        <h2 className="font-heading text-xl font-bold text-[var(--color-text)]">商品与库存</h2>
        <div className="flex gap-2 flex-wrap items-center">
          <select
            className="input py-1.5 text-xs"
            value={archivedFilter}
            onChange={(event) => setArchivedFilter(event.target.value as 'exclude' | 'only' | 'all')}
            data-testid="admin-products-archived-filter"
          >
            <option value="exclude">隐藏已归档</option>
            <option value="only">仅已归档</option>
            <option value="all">全部</option>
          </select>
          <button
            type="button"
            className="btn-secondary btn-sm text-xs px-3 py-1.5 cursor-pointer"
            data-testid="admin-platform-product-open"
            onClick={() => setShowPlatformProduct(true)}
          >
            新建平台商品
          </button>
          <button
            type="button"
            className="btn-primary btn-sm text-xs px-3 py-1.5 cursor-pointer"
            data-testid="admin-faka-import-open"
            onClick={() => setShowFakaImport(true)}
          >
            从 Xboard 导入套餐
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        {loading && products.length === 0 ? (
          <TableSkeleton />
        ) : (
          <table className="admin-table table-cards">
            <thead>
              <tr>
                <th>商品名称</th>
                <th>状态</th>
                <th>类型</th>
                <th>售价 (积分)</th>
                <th>可售资源</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => {
                const deliveryMode = p.deliveryMode ?? 'instant_inventory'
                const isInstantInventory = deliveryMode === 'instant_inventory'
                const isPlatformOwned = p.merchantId == null
                const isFaka = Boolean(p.fakaBridge || p.fakaCapacity)
                const importableOffers = (p.offers ?? []).filter(
                  (o) =>
                    o.deliveryMode === 'instant_inventory' &&
                    !(Array.isArray(o.deliveryFields) && o.deliveryFields.length > 0),
                )
                const canImport = importableOffers.length > 0
                const available = isInstantInventory ? (p._count?.inventory ?? p.stock) : p.stock
                const fakaCap = p.fakaCapacity
                const stockLabel =
                  isFaka && fakaCap?.source === 'xboard'
                    ? fakaCap.remaining == null
                      ? `Xboard 不限（在用 ${fakaCap.activeUsers ?? 0}）`
                      : `Xboard ${fakaCap.remaining}/${fakaCap.capacityLimit}（在用 ${fakaCap.activeUsers ?? 0}）`
                    : isFaka
                      ? 'Xboard 名额（暂不可读）'
                      : isInstantInventory
                        ? `${available} 个交付单元`
                        : p.stockMode === 'unlimited'
                          ? '不限量'
                          : deliveryMode === 'manual_service'
                            ? `${available} 个服务名额`
                            : `${available} 个可售名额`

                return (
                  <tr key={p.id}>
                    <td data-label="商品名称">
                      <div className="font-bold text-[var(--color-text)]">{p.name}</div>
                      {isFaka && (
                        <div className="text-[10px] text-[var(--color-primary)] mt-0.5">
                          FakaBridge · Xboard
                        </div>
                      )}
                    </td>
                    <td data-label="状态">
                      <span
                        className="inline-flex items-center rounded border border-[var(--color-border)] bg-[var(--color-background)] px-2 py-0.5 text-xs font-bold text-[var(--color-text)]"
                        data-testid={`admin-product-status-${p.id}`}
                      >
                        {p.archivedAt ? '已归档' : adminProductStatusLabel(p.status)}
                      </span>
                    </td>
                    <td data-label="类型">
                      <span className="bg-[var(--color-background)] border border-[var(--color-border)] text-[var(--color-text-muted)] px-2 py-1 rounded text-xs font-bold">
                        {p.type}
                      </span>
                    </td>
                    <td className="font-bold text-[var(--color-text)]" data-label="售价 (积分)">
                      {p.price}
                    </td>
                    <td data-label="可售资源">
                      <span
                        className={`font-bold ${
                          isInstantInventory && available === 0
                            ? 'text-red-500'
                            : 'text-[var(--color-text-muted)]'
                        }`}
                      >
                        {stockLabel}
                      </span>
                    </td>
                    <td className="text-right" data-label="操作">
                      <div className="flex flex-wrap gap-2 justify-end">
                        {isPlatformOwned && !p.archivedAt && p.status === 'draft' && (
                          <button
                            type="button"
                            data-testid={`admin-product-publish-${p.id}`}
                            disabled={productsRefreshError}
                            className="text-[var(--color-cta)] hover:bg-[var(--color-cta)]/10 font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[var(--color-cta)]/25 cursor-pointer inline-flex items-center gap-1 disabled:opacity-50"
                            onClick={() => openPublication(p, 'product-list')}
                          >
                            <Upload className="w-3.5 h-3.5" />
                            发布
                          </button>
                        )}
                        {isPlatformOwned && !p.archivedAt && p.status === 'inactive' && (
                          <button
                            type="button"
                            data-testid={`admin-product-relist-${p.id}`}
                            disabled={productsRefreshError}
                            className="text-[var(--color-cta)] hover:bg-[var(--color-cta)]/10 font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[var(--color-cta)]/25 cursor-pointer inline-flex items-center gap-1 disabled:opacity-50"
                            onClick={() => openPublication(p, 'product-list')}
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            重新上架
                          </button>
                        )}
                        {isPlatformOwned && !p.archivedAt && p.status === 'active' && (
                          <button
                            type="button"
                            data-testid={`admin-product-unpublish-${p.id}`}
                            disabled={productsRefreshError || unpublishingProductIds.has(p.id)}
                            className="text-[var(--color-text)] hover:bg-[var(--color-background)] font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[var(--color-border)] cursor-pointer inline-flex items-center gap-1 disabled:opacity-50"
                            onClick={() => {
                              setUnpublishTarget(p)
                            }}
                          >
                            <Archive className="w-3.5 h-3.5" />
                            {unpublishingProductIds.has(p.id) ? '下架中…' : '下架'}
                          </button>
                        )}
                        {!isPlatformOwned && (
                          <span
                            className="text-xs text-[var(--color-text-muted)] px-1 py-1.5"
                            data-testid={`admin-product-merchant-owned-${p.id}`}
                          >
                            由商家管理
                          </span>
                        )}
                        {isFaka && (
                          <button
                            type="button"
                            data-testid={`admin-faka-capacity-${p.id}`}
                            className="text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[var(--color-primary)]/25 cursor-pointer"
                            onClick={() => {
                              setFakaCapProduct(p)
                              const lim = p.fakaCapacity?.capacityLimit
                              setFakaCapUnlimited(lim == null)
                              setFakaCapInput(lim != null ? String(lim) : '')
                            }}
                          >
                            调整 Xboard 名额
                          </button>
                        )}
                        {canImport ? (
                          <button
                            onClick={() => {
                              setInventoryTarget({
                                id: p.id,
                                name: p.name,
                                offers: importableOffers.map((offer) => ({
                                  id: offer.id,
                                  name: offer.name,
                                  status: offer.status ?? 'active',
                                  isDefault: offer.isDefault,
                                })),
                              })
                            }}
                            data-testid={`admin-import-inventory-${p.id}`}
                            className="text-[var(--color-cta)] hover:bg-[var(--color-cta)]/10 font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[var(--color-cta)]/25 cursor-pointer"
                          >
                            导入交付库存
                          </button>
                        ) : !isFaka ? (
                          <span className="text-xs text-[var(--color-text-muted)]">
                            {p.merchantId ? '由商家调整名额' : '名额由商品配置管理'}
                          </span>
                        ) : null}
                        {isPlatformOwned && (
                          <button
                            type="button"
                            data-testid={`admin-edit-product-${p.id}`}
                            className="text-[var(--color-text)] hover:bg-[var(--color-background)] font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[var(--color-border)] cursor-pointer inline-flex items-center gap-1"
                            onClick={() => setEditProduct(p)}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                            编辑
                          </button>
                        )}
                        {isPlatformOwned && (
                          <button
                            type="button"
                            data-testid={`admin-manage-offers-${p.id}`}
                            className="text-[var(--color-text)] hover:bg-[var(--color-background)] font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[var(--color-border)] cursor-pointer"
                            onClick={() => setOfferProduct(p)}
                          >
                            规格
                          </button>
                        )}
                        {isFaka && (
                          <button
                            type="button"
                            data-testid={`admin-faka-sync-${p.id}`}
                            className="text-[var(--color-primary)] hover:bg-[var(--color-primary)]/10 font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[var(--color-primary)]/25 cursor-pointer inline-flex items-center gap-1"
                            onClick={() => setSyncProduct(p)}
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            同步
                          </button>
                        )}
                        {p.archivedAt ? (
                          <button
                            type="button"
                            data-testid={`admin-restore-product-${p.id}`}
                            className="text-[var(--color-cta)] hover:bg-[var(--color-cta)]/10 font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[var(--color-cta)]/25 cursor-pointer"
                            onClick={async () => {
                              try {
                                await restoreAdminProduct(p.id)
                                showToast('商品已恢复为未上架状态')
                              } catch (err) {
                                showToast(getApiErrorMessage(err, '恢复失败'), 'error')
                                return
                              }
                              triggerSafeReload()
                            }}
                          >
                            恢复
                          </button>
                        ) : (
                          <button
                            type="button"
                            data-testid={`admin-archive-product-${p.id}`}
                            className="text-red-500 hover:bg-red-500/10 font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-red-500/25 cursor-pointer"
                            onClick={() => setArchiveTarget(p)}
                          >
                            归档
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
              {!loading && products.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <EmptyState
                      compact
                      icon={Package}
                      title="暂无商品"
                      description="商品创建后将显示在这里"
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <AdminPlatformProductWizard
        open={showPlatformProduct}
        onClose={() => setShowPlatformProduct(false)}
        onCreated={() => {
          triggerSafeReload()
        }}
      />

      <AdminInventoryImportPreview
        open={inventoryTarget != null}
        product={inventoryTarget}
        onClose={() => setInventoryTarget(null)}
        onImported={() => {
          triggerSafeReload()
        }}
      />

      {/* FakaBridge capacity limit modal */}
      <Dialog
        open={fakaCapProduct != null}
        onOpenChange={(open) => {
          if (!open && !fakaCapSaving) setFakaCapProduct(null)
        }}
      >
        <DialogContent>
          <DialogTitle>调整 Xboard 人数上限</DialogTitle>
          <p className="text-xs text-[var(--color-text-muted)] mb-3">
            设置该套餐在 Xboard 的用户数上限；达到上限后将自动下架对应规格。
          </p>
          {fakaCapProduct?.fakaCapacity && (
            <p className="text-xs text-[var(--color-text-muted)] mb-3">
              当前容量：
              {fakaCapProduct.fakaCapacity.capacityLimit == null
                ? '不限制'
                : `${fakaCapProduct.fakaCapacity.capacityLimit} 人`}
              ，在用 {fakaCapProduct.fakaCapacity.activeUsers ?? 0}
            </p>
          )}
          <label className="flex items-center gap-2 text-sm mb-3 cursor-pointer">
            <input
              type="checkbox"
              checked={fakaCapUnlimited}
              onChange={(e) => setFakaCapUnlimited(e.target.checked)}
              data-testid="admin-faka-cap-unlimited"
            />
            不限制人数
          </label>
          {!fakaCapUnlimited && (
            <input
              type="number"
              min={0}
              className="input font-mono mb-4"
              placeholder="人数上限"
              value={fakaCapInput}
              onChange={(e) => setFakaCapInput(e.target.value)}
              data-testid="admin-faka-cap-input"
            />
          )}
          <button
            type="button"
            className="btn-primary w-full cursor-pointer"
            disabled={fakaCapSaving}
            data-testid="admin-faka-cap-save"
            onClick={async () => {
              if (!fakaCapProduct) return
              const limit = fakaCapUnlimited ? null : Number(fakaCapInput)
              if (!fakaCapUnlimited && (!Number.isInteger(limit) || (limit as number) < 0)) {
                showToast('请输入有效的非负整数上限', 'error')
                return
              }
              setFakaCapSaving(true)
              try {
                const fakaOffer = (fakaCapProduct.offers ?? []).find(
                  (o) => o.externalIntegration === 'faka_bridge',
                )
                await setAdminFakaCapacity(fakaCapProduct.id, {
                  offerId: fakaOffer?.id,
                  capacityLimit: limit as number | null,
                })
                showToast('已同步到 Xboard')
                setFakaCapProduct(null)
                triggerSafeReload()
              } catch (err) {
                showToast(getApiErrorMessage(err, '同步失败'), 'error')
              } finally {
                setFakaCapSaving(false)
              }
            }}
          >
            {fakaCapSaving ? '同步中…' : '保存并同步到 Xboard'}
          </button>
        </DialogContent>
      </Dialog>

      <AdminFakaImportPreview
        open={showFakaImport}
        onClose={() => setShowFakaImport(false)}
        onImported={handleImportedPlatformProduct}
      />

      <AdminProductPublicationDialog
        open={publicationTarget != null}
        target={publicationTarget}
        onClose={() => setPublicationTarget(null)}
        onPublished={async ({ name }) => {
          try {
            await reloadProducts()
            showToast(`“${name}”已发布到商城`)
          } catch (err) {
            if (err instanceof Error && err.name === 'StaleProductsReloadError') return
            showToast(`“${name}”已发布到商城，但列表刷新失败，请重试`)
            throw new Error('products-refresh-failed')
          }
        }}
      />

      <AdminProductEditDialog
        product={editProduct}
        onClose={() => setEditProduct(null)}
        onSaved={triggerSafeReload}
      />
      <AdminOfferManagerModal
        product={offerProduct}
        onClose={() => setOfferProduct(null)}
        onChanged={triggerSafeReload}
      />
      <AdminFakaSyncDialog
        product={syncProduct}
        onClose={() => setSyncProduct(null)}
        onSynced={triggerSafeReload}
      />

      {/* 商品下架确认弹窗 */}
      <ConfirmDialog
        open={unpublishTarget !== null}
        onOpenChange={(open) => {
          if (!open && !unpublishingProductIds.has(unpublishTarget?.id ?? -1)) {
            setUnpublishTarget(null)
          }
        }}
        title="下架商品"
        description={`确定下架商品「${unpublishTarget?.name}」？下架后商品将从商城隐藏，已有订单和可售资源不会删除。`}
        confirmLabel={unpublishTarget && unpublishingProductIds.has(unpublishTarget.id) ? '下架中…' : '确认下架'}
        tone="danger"
        loading={unpublishTarget ? unpublishingProductIds.has(unpublishTarget.id) : false}
        onConfirm={async () => {
          if (unpublishTarget) {
            await executeUnpublishPlatformProduct(unpublishTarget)
          }
        }}
        testId="admin-unpublish-product-confirm-dialog"
      />

      {/* 商品归档确认弹窗 */}
      <ConfirmDialog
        open={archiveTarget !== null}
        onOpenChange={(open) => {
          if (!open && !archiving) setArchiveTarget(null)
        }}
        title="归档商品"
        description={`确定归档「${archiveTarget?.name}」？商品将从商城和管理默认列表隐藏，历史订单与快照保留，不会永久删除。`}
        confirmLabel={archiving ? '归档中…' : '确认归档'}
        tone="danger"
        loading={archiving}
        onConfirm={async () => {
          if (archiveTarget) {
            await executeArchiveProduct(archiveTarget)
          }
        }}
        testId="admin-archive-product-confirm-dialog"
      />
    </div>
  )
}
