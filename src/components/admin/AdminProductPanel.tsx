import { useEffect, useRef, useState } from 'react'
import { RotateCcw, Search } from 'lucide-react'
import {
  getAdminProducts,
  archiveAdminProduct,
  unpublishAdminProduct,
  type AdminProductListItem,
  type AdminProductsPaged,
  type ListAdminProductsParams,
} from '../../api/admin'
import AdminPagination from './AdminPagination'
import { getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import { createLatestRequestGuard } from '../../utils/latestRequest'
import ConfirmDialog from '../ui/ConfirmDialog'
import AdminFakaImportPreview from '../catalog/AdminFakaImportPreview'
import AdminProductPublicationDialog, {
  type AdminPublicationTarget,
} from '../catalog/AdminProductPublicationDialog'
import AdminOfferManagerModal from '../catalog/AdminOfferManagerModal'
import AdminFakaSyncDialog from '../catalog/AdminFakaSyncDialog'
import AdminSourceDescriptionDialog from '../catalog/AdminSourceDescriptionDialog'
import AdminInventoryImportPreview, {
  type AdminInventoryTarget,
} from '../catalog/AdminInventoryImportPreview'
import AdminPanelHeader from './AdminPanelHeader'
import AdminAssurancePanel from '../catalog/AdminAssurancePanel'
import AdminProductTable from './productPanel/AdminProductTable'
import ProductCapacityDialog from './productPanel/ProductCapacityDialog'

interface Props {
  active?: boolean
}

export default function AdminProductPanel({ active = true }: Props) {
  const showToast = useAppStore((s) => s.showToast)
  const [products, setProducts] = useState<AdminProductListItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [loading, setLoading] = useState(true)
  const [assuranceProductId, setAssuranceProductId] = useState<number | null>(null)
  const [productsRefreshError, setProductsRefreshError] = useState(false)
  const [productsReloading, setProductsReloading] = useState(false)

  // Draft filter inputs
  const [qInput, setQInput] = useState('')
  const [statusInput, setStatusInput] = useState<'' | 'draft' | 'active' | 'inactive'>('')
  const [archivedInput, setArchivedInput] = useState<'exclude' | 'only' | 'all'>('exclude')

  // Applied filter snapshot
  const [appliedFilter, setAppliedFilter] = useState<{
    q: string
    status: '' | 'draft' | 'active' | 'inactive'
    archived: 'exclude' | 'only' | 'all'
  }>({
    q: '',
    status: '',
    archived: 'exclude',
  })

  const [inventoryTarget, setInventoryTarget] = useState<AdminInventoryTarget | null>(null)

  // FakaBridge capacity edit (admin only)
  const [fakaCapProduct, setFakaCapProduct] = useState<AdminProductListItem | null>(null)

  // FakaBridge mandatory preview → idempotent confirm.
  const [showFakaImport, setShowFakaImport] = useState(false)
  const [publicationTarget, setPublicationTarget] = useState<AdminPublicationTarget | null>(null)
  const [unpublishingProductIds, setUnpublishingProductIds] = useState<Set<number>>(new Set())
  const [offerProduct, setOfferProduct] = useState<AdminProductListItem | null>(null)
  const [syncProduct, setSyncProduct] = useState<AdminProductListItem | null>(null)
  const [sourceDescriptionProduct, setSourceDescriptionProduct] = useState<AdminProductListItem | null>(null)

  // ConfirmDialog states
  const [unpublishTarget, setUnpublishTarget] = useState<AdminProductListItem | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<AdminProductListItem | null>(null)
  const [archiving, setArchiving] = useState(false)

  const unpublishingRef = useRef<Set<number>>(new Set())
  const productsReloadGuard = useRef(createLatestRequestGuard()).current

  async function reloadProducts(
    targetPage: number = page,
    targetFilter = appliedFilter,
  ): Promise<AdminProductsPaged> {
    const canCommit = productsReloadGuard.begin()
    setProductsReloading(true)
    setLoading(true)
    try {
      const params: ListAdminProductsParams = {
        page: targetPage,
        pageSize,
        archived: targetFilter.archived,
      }
      if (targetFilter.status) {
        params.status = targetFilter.status
      }
      if (targetFilter.q.trim()) {
        params.q = targetFilter.q.trim()
      }

      const data = await getAdminProducts(params)
      if (!canCommit()) {
        const stale = new Error('stale-products-reload')
        stale.name = 'StaleProductsReloadError'
        throw stale
      }

      // Check if deletion/archive/restore caused current page to be empty:
      // "归档、恢复或删除导致当前页为空：回退到最后一个有效页，禁止停留在幽灵空页"
      if (data.items.length === 0 && targetPage > 1) {
        const lastValidPage = Math.max(1, Math.ceil(data.total / data.pageSize))
        if (lastValidPage < targetPage) {
          setPage(lastValidPage)
          return await reloadProducts(lastValidPage, targetFilter)
        }
      }

      setProducts(data.items)
      setTotal(data.total)
      setPage(data.page)
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
    void reloadProducts(page, appliedFilter).catch((err) => {
      if (err instanceof Error && err.name === 'StaleProductsReloadError') return
      showToast(getApiErrorMessage(err, '加载失败'), 'error')
    })
    return () => {
      productsReloadGuard.invalidate()
      setProductsReloading(false)
    }
  }, [active])

  function handleQuery() {
    const nextFilter = {
      q: qInput.trim(),
      status: statusInput,
      archived: archivedInput,
    }
    setAppliedFilter(nextFilter)
    setPage(1)
    void reloadProducts(1, nextFilter).catch((err) => {
      if (!(err instanceof Error && err.name === 'StaleProductsReloadError')) {
        showToast(getApiErrorMessage(err, '查询失败'), 'error')
      }
    })
  }

  function handleReset() {
    setQInput('')
    setStatusInput('')
    setArchivedInput('exclude')
    const defaultFilter = {
      q: '',
      status: '' as const,
      archived: 'exclude' as const,
    }
    setAppliedFilter(defaultFilter)
    setPage(1)
    void reloadProducts(1, defaultFilter).catch((err) => {
      if (!(err instanceof Error && err.name === 'StaleProductsReloadError')) {
        showToast(getApiErrorMessage(err, '重置失败'), 'error')
      }
    })
  }

  function handlePageChange(newPage: number) {
    if (newPage === page) return
    setPage(newPage)
    void reloadProducts(newPage, appliedFilter).catch((err) => {
      if (!(err instanceof Error && err.name === 'StaleProductsReloadError')) {
        showToast(getApiErrorMessage(err, '翻页失败'), 'error')
      }
    })
  }

  function triggerSafeReload(targetPage: number = page) {
    void reloadProducts(targetPage, appliedFilter).catch((err) => {
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
    let res: AdminProductsPaged | undefined
    setPage(1)
    try {
      res = await reloadProducts(1, appliedFilter)
    } catch (err) {
      if (!(err instanceof Error && err.name === 'StaleProductsReloadError')) {
        showToast(getApiErrorMessage(err, '加载失败'), 'error')
      }
    }
    const imported = res?.items?.find((item) => item.id === result.productId)
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
      <AdminPanelHeader
        title="商品与库存"
        description="管理平台自营与入驻商家商品、定价及交付配置"
        actions={
          <div className="flex gap-2 flex-wrap items-center">
            <a
              href="/admin/products/new"
              className="btn-secondary btn-sm text-xs px-3 py-1.5 cursor-pointer no-underline"
              data-testid="admin-platform-product-open"
            >
              新建平台商品
            </a>
            <button
              type="button"
              className="btn-primary btn-sm text-xs px-3 py-1.5 cursor-pointer"
              data-testid="admin-faka-import-open"
              onClick={() => setShowFakaImport(true)}
            >
              从 Xboard 导入套餐
            </button>
          </div>
        }
      />
      <form
        onSubmit={(e) => {
          e.preventDefault()
          handleQuery()
        }}
        data-testid="admin-products-filter-form"
        className="card p-3 flex flex-wrap items-center gap-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg text-xs"
      >
        <div className="flex items-center gap-2 flex-grow sm:flex-grow-0 sm:w-64">
          <label htmlFor="admin-products-search-input" className="sr-only">
            搜索商品
          </label>
          <div className="relative w-full">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-muted)] pointer-events-none" />
            <input
              id="admin-products-search-input"
              type="text"
              placeholder="按商品名称或 ID 搜索"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              className="input pl-8 py-1.5 text-xs w-full"
              data-testid="admin-products-search-input"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="admin-products-status-filter" className="text-xs font-medium text-[var(--color-text-muted)] shrink-0">
            状态:
          </label>
          <select
            id="admin-products-status-filter"
            value={statusInput}
            onChange={(e) => setStatusInput(e.target.value as '' | 'draft' | 'active' | 'inactive')}
            className="input py-1.5 text-xs"
            data-testid="admin-products-status-filter"
          >
            <option value="">全部状态</option>
            <option value="draft">草稿</option>
            <option value="active">已上架</option>
            <option value="inactive">已下架</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="admin-products-archived-filter" className="text-xs font-medium text-[var(--color-text-muted)] shrink-0">
            归档:
          </label>
          <select
            id="admin-products-archived-filter"
            value={archivedInput}
            onChange={(e) => setArchivedInput(e.target.value as 'exclude' | 'only' | 'all')}
            className="input py-1.5 text-xs"
            data-testid="admin-products-archived-filter"
          >
            <option value="exclude">隐藏已归档</option>
            <option value="only">仅已归档</option>
            <option value="all">全部</option>
          </select>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <button
            type="submit"
            className="btn-primary btn-sm text-xs flex items-center gap-1 cursor-pointer disabled:opacity-50"
            disabled={productsReloading}
            data-testid="admin-products-search-btn"
          >
            <Search className="w-3.5 h-3.5" />
            <span>查询</span>
          </button>
          <button
            type="button"
            onClick={handleReset}
            className="btn-secondary btn-sm text-xs flex items-center gap-1 cursor-pointer disabled:opacity-50"
            disabled={productsReloading}
            data-testid="admin-products-reset-btn"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>重置</span>
          </button>
        </div>
      </form>
      <AdminAssurancePanel productId={assuranceProductId} />
      <AdminProductTable
        products={products}
        loading={loading}
        hasActiveFilter={Boolean(
          appliedFilter.q || appliedFilter.status || appliedFilter.archived !== 'exclude',
        )}
        releaseGate={{
          blocked: productsRefreshError,
          pendingIds: unpublishingProductIds,
        }}
        onOpenPublication={openPublication}
        onRequestUnpublish={setUnpublishTarget}
        onRequestArchive={setArchiveTarget}
        onOpenInventoryImport={setInventoryTarget}
        onOpenAssurance={setAssuranceProductId}
        onOpenOffers={setOfferProduct}
        onOpenFakaCapacity={setFakaCapProduct}
        onOpenFakaSync={setSyncProduct}
        onOpenSourceDescription={setSourceDescriptionProduct}
        onMutationSettled={() => triggerSafeReload()}
        onResetFilters={handleReset}
      />

      <AdminPagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={handlePageChange}
        testId="admin-products-pagination"
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
      <ProductCapacityDialog
        product={fakaCapProduct}
        onClose={() => setFakaCapProduct(null)}
        onSaved={() => triggerSafeReload()}
      />

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
      <AdminSourceDescriptionDialog
        product={sourceDescriptionProduct}
        onClose={() => setSourceDescriptionProduct(null)}
        onApplied={triggerSafeReload}
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
