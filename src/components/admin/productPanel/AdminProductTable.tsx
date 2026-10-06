import {
  Archive,
  Package,
  Pencil,
  RotateCcw,
  Upload,
} from 'lucide-react'
import {
  archiveAdminProduct,
  restoreAdminProduct,
  type AdminProductListItem,
} from '../../../api/admin'
import { getApiErrorMessage } from '../../../api/error'
import { useAppStore } from '../../../stores/appStore'
import { TableSkeleton } from '../../ui/Skeleton'
import EmptyState from '../../ui/EmptyState'
import type { AdminInventoryTarget } from '../../catalog/AdminInventoryImportPreview'
import type { AdminPublicationTarget } from '../../catalog/AdminProductPublicationDialog'
import AdminActionMenu, { type AdminActionMenuItem } from '../AdminActionMenu'
import type { ReleaseGate } from './types'

function adminProductStatusLabel(status: string): string {
  if (status === 'draft') return '草稿'
  if (status === 'active') return '已发布'
  if (status === 'inactive') return '已下架'
  return '状态未知'
}

function shouldShowSourceDescriptionAction(product: AdminProductListItem): boolean {
  if (product.fakaCapacity) return true
  if (product.fakaBridge) return true
  const offers = product.offers ?? []
  if (offers.some((offer) => Boolean(offer.externalIntegration) || Boolean(offer.fakaCapacity))) {
    return true
  }
  return product.fakaBridge === undefined && product.fakaCapacity === undefined
}

export interface AdminProductTableProps {
  products: AdminProductListItem[]
  loading: boolean
  /** 生效筛选（applied filter）非默认值时为 true，用于空态文案分支 */
  hasActiveFilter: boolean
  /** 列表状态变更门控：刷新失败与下架进行中的商品 */
  releaseGate: ReleaseGate
  onOpenPublication: (product: AdminProductListItem, origin: AdminPublicationTarget['origin']) => void
  onRequestUnpublish: (product: AdminProductListItem) => void
  onRequestArchive: (product: AdminProductListItem) => void
  onOpenInventoryImport: (target: AdminInventoryTarget) => void
  onOpenAssurance: (productId: number) => void
  onOpenOffers: (product: AdminProductListItem) => void
  onOpenFakaCapacity: (product: AdminProductListItem) => void
  onOpenFakaSync: (product: AdminProductListItem) => void
  onOpenSourceDescription: (product: AdminProductListItem) => void
  /** 行内状态变更（恢复）成功后，请求父层按当前生效筛选安全刷新 */
  onMutationSettled: () => void
  /** 空态「清空筛选条件」：等价原 handleReset */
  onResetFilters: () => void
}

export default function AdminProductTable({
  products,
  loading,
  hasActiveFilter,
  releaseGate,
  onOpenPublication,
  onRequestUnpublish,
  onRequestArchive,
  onOpenInventoryImport,
  onOpenAssurance,
  onOpenOffers,
  onOpenFakaCapacity,
  onOpenFakaSync,
  onOpenSourceDescription,
  onMutationSettled,
  onResetFilters,
}: AdminProductTableProps) {
  const showToast = useAppStore((s) => s.showToast)

  return (
    <div className="overflow-x-auto">
      {loading && products.length === 0 ? (
        <TableSkeleton />
      ) : (
        <table className="admin-table table-cards">
          <thead>
            <tr>
              <th>商品名称</th>
              <th>状态</th>
              <th>分类</th>
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
                    <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
                      {isPlatformOwned ? '平台自营' : `商家 #${p.merchantId}`}
                    </div>
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
                  <td data-label="分类">
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
                          disabled={releaseGate.blocked}
                          className="text-[var(--color-cta)] hover:bg-[var(--color-cta)]/10 font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[var(--color-cta)]/25 cursor-pointer inline-flex items-center gap-1 disabled:opacity-50"
                          onClick={() => onOpenPublication(p, 'product-list')}
                        >
                          <Upload className="w-3.5 h-3.5" />
                          发布
                        </button>
                      )}
                      {isPlatformOwned && !p.archivedAt && p.status === 'inactive' && (
                        <button
                          type="button"
                          data-testid={`admin-product-relist-${p.id}`}
                          disabled={releaseGate.blocked}
                          className="text-[var(--color-cta)] hover:bg-[var(--color-cta)]/10 font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[var(--color-cta)]/25 cursor-pointer inline-flex items-center gap-1 disabled:opacity-50"
                          onClick={() => onOpenPublication(p, 'product-list')}
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          重新上架
                        </button>
                      )}
                      {isPlatformOwned && !p.archivedAt && p.status === 'active' && (
                        <button
                          type="button"
                          data-testid={`admin-product-unpublish-${p.id}`}
                          disabled={releaseGate.blocked || releaseGate.pendingIds.has(p.id)}
                          className="text-[var(--color-text)] hover:bg-[var(--color-background)] font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[var(--color-border)] cursor-pointer inline-flex items-center gap-1 disabled:opacity-50"
                          onClick={() => {
                            onRequestUnpublish(p)
                          }}
                        >
                          <Archive className="w-3.5 h-3.5" />
                          {releaseGate.pendingIds.has(p.id) ? '下架中…' : '下架'}
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
                      {canImport ? (
                        <button
                          onClick={() => {
                            onOpenInventoryImport({
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
                        <a
                          href={`/admin/products/${p.id}/edit`}
                          data-testid={`admin-edit-product-${p.id}`}
                          className="text-[var(--color-text)] hover:bg-[var(--color-background)] font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-[var(--color-border)] cursor-pointer inline-flex items-center gap-1 no-underline"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                          编辑
                        </a>
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
                            onMutationSettled()
                          }}
                        >
                          恢复
                        </button>
                      ) : (
                        <button
                          type="button"
                          data-testid={`admin-archive-product-${p.id}`}
                          className="text-red-500 hover:bg-red-500/10 font-semibold text-xs px-3 py-1.5 btn-sm rounded-lg transition-colors border border-red-500/25 cursor-pointer"
                          onClick={() => onRequestArchive(p)}
                        >
                          归档
                        </button>
                      )}
                      {(() => {
                        const menuItems: AdminActionMenuItem[] = []
                        menuItems.push({
                          id: `assurance-${p.id}`,
                          label: '保障管理',
                          onClick: () => onOpenAssurance(p.id),
                          testId: `admin-assurance-${p.id}`,
                        })
                        if (isPlatformOwned) {
                          menuItems.push({
                            id: `offers-${p.id}`,
                            label: '规格管理',
                            onClick: () => onOpenOffers(p),
                            testId: `admin-manage-offers-${p.id}`,
                          })
                        }
                        if (isFaka) {
                          menuItems.push({
                            id: `capacity-${p.id}`,
                            label: '调整 Xboard 名额',
                            onClick: () => onOpenFakaCapacity(p),
                            testId: `admin-faka-capacity-${p.id}`,
                          })
                          menuItems.push({
                            id: `sync-${p.id}`,
                            label: '同步 Xboard',
                            onClick: () => onOpenFakaSync(p),
                            testId: `admin-faka-sync-${p.id}`,
                          })
                        }
                        if (shouldShowSourceDescriptionAction(p)) {
                          menuItems.push({
                            id: `source-description-${p.id}`,
                            label: '检查上游介绍',
                            onClick: () => onOpenSourceDescription(p),
                            testId: `admin-source-description-${p.id}`,
                          })
                        }
                        return (
                          <AdminActionMenu
                            items={menuItems}
                            triggerLabel={`商品「${p.name}」更多操作`}
                            triggerTestId={`admin-product-actions-${p.id}`}
                          />
                        )
                      })()}
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
                    title={hasActiveFilter ? '未找到匹配的商品' : '暂无商品'}
                    description={
                      hasActiveFilter ? '尝试调整搜索词或筛选条件' : '商品创建后将显示在这里'
                    }
                    action={
                      hasActiveFilter ? (
                        <button
                          type="button"
                          className="btn-secondary btn-sm text-xs mt-2 cursor-pointer"
                          onClick={onResetFilters}
                          data-testid="admin-products-empty-reset"
                        >
                          清空筛选条件
                        </button>
                      ) : undefined
                    }
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  )
}
