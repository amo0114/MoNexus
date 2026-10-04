import { AlertTriangle, Package, Plus, Search } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ConfigRegistry } from '../../../types/config'
import type { MerchantProduct } from '../../../types/merchant'
import EmptyState from '../../ui/EmptyState'
import { TableSkeleton } from '../../ui/Skeleton'
import { PaginationControls, Th } from './MerchantPanelPrimitives'

export interface MerchantProductsPanelProps {
  products: MerchantProduct[]
  loading: boolean
  productPage: number
  productTotal: number
  setProductPage: (page: number) => void
  productSearch: string
  setProductSearch: (value: string) => void
  productStatusFilter: string
  setProductStatusFilter: (value: string) => void
  productTypeFilter: string
  setProductTypeFilter: (value: string) => void
  productModeFilter: string
  setProductModeFilter: (value: string) => void
  productLowStockOnly: boolean
  setProductLowStockOnly: (value: boolean) => void
  registry: ConfigRegistry | null
  /** 上架/下架进行中的商品 id；guard 与请求编排仍由父层持有。 */
  publishingProductIds: ReadonlySet<number>
  onToggleProductStatus: (product: MerchantProduct) => void
  onCreateProduct: () => void
  onEditProduct: (productId: number) => void
  onManageAvailability: (product: MerchantProduct) => void
  onManageInventory: (product: MerchantProduct) => void
  onAdjustCapacity: (product: MerchantProduct) => void
  onViewInventoryLog: (product: MerchantProduct) => void
  onManageOffers: (product: MerchantProduct) => void
}

function isInstantInventoryProduct(product: MerchantProduct) {
  // 兼容早期商品：服务端在未返回 deliveryMode 时默认按即时库存处理。
  return (product.deliveryMode ?? 'instant_inventory') === 'instant_inventory'
}

function getAvailabilityLabel(product: MerchantProduct) {
  if (isInstantInventoryProduct(product)) return '交付库存'
  if (product.stockMode === 'unlimited') return '不限量'
  return product.deliveryMode === 'manual_service'
    ? '服务名额'
    : '可售名额'
}

function getOfferAvailabilityLabel(offer: NonNullable<MerchantProduct['offers']>[number]) {
  if (offer.deliveryMode === 'instant_inventory') {
    return `交付库存 ${offer.availableStock ?? '—'}`
  }
  if (offer.stockMode === 'unlimited') return '不限量'
  return offer.deliveryMode === 'manual_service'
    ? `服务名额 ${offer.stock}`
    : `可售名额 ${offer.stock}`
}

function StatusPill({ kind }: { kind: 'active' | 'inactive' }) {
  const styles: Record<typeof kind, { bg: string; text: string; border: string; label: string }> = {
    active:   { bg: 'bg-[var(--color-cta)]/10',          text: 'text-[var(--color-cta)]',          border: 'border-[var(--color-cta)]/25',          label: '上架中' },
    inactive: { bg: 'bg-[var(--color-text-muted)]/10',   text: 'text-[var(--color-text-muted)]',   border: 'border-[var(--color-text-muted)]/25',   label: '未上架' },
  }
  const s = styles[kind]
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold border ${s.bg} ${s.text} ${s.border}`}>
      {s.label}
    </span>
  )
}

interface LinkActionProps {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  testId?: string
}

function LinkAction({ children, onClick, disabled, testId }: LinkActionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={`text-[var(--color-primary)] hover:underline text-sm mr-3 last:mr-0 cursor-pointer btn-sm ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      {children}
    </button>
  )
}

export default function MerchantProductsPanel({
  products,
  loading,
  productPage,
  productTotal,
  setProductPage,
  productSearch,
  setProductSearch,
  productStatusFilter,
  setProductStatusFilter,
  productTypeFilter,
  setProductTypeFilter,
  productModeFilter,
  setProductModeFilter,
  productLowStockOnly,
  setProductLowStockOnly,
  registry,
  publishingProductIds,
  onToggleProductStatus,
  onCreateProduct,
  onEditProduct,
  onManageAvailability,
  onManageInventory,
  onAdjustCapacity,
  onViewInventoryLog,
  onManageOffers,
}: MerchantProductsPanelProps) {
  return (
    <div className="fade-in">
      <div className="flex justify-between items-center mb-4">
        <h2 className="font-heading text-xl font-bold text-[var(--color-text)]">商品管理</h2>
        <button
          className="btn-primary px-3 py-1.5 text-sm btn-sm"
          onClick={onCreateProduct}
        >
          <Plus className="w-4 h-4" /> 新建商品
        </button>
      </div>

      {/* 筛选栏 */}
      <div className="flex flex-wrap items-center gap-3 mb-5" data-testid="merchant-product-filters">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] pointer-events-none" />
          <input
            type="text"
            placeholder="搜索商品名称..."
            className="input pl-9 py-2"
            value={productSearch}
            onChange={(e) => setProductSearch(e.target.value)}
            data-testid="merchant-product-search"
          />
        </div>
        <select
          className="input py-2 w-auto appearance-none cursor-pointer"
          value={productStatusFilter}
          onChange={(e) => { setProductStatusFilter(e.target.value); setProductPage(1); }}
          aria-label="按状态筛选"
          data-testid="merchant-product-status-filter"
        >
          <option value="">全部状态</option>
          <option value="active">上架中</option>
          <option value="inactive">未上架</option>
        </select>
        <select
          className="input py-2 w-auto appearance-none cursor-pointer"
          value={productTypeFilter}
          onChange={(e) => { setProductTypeFilter(e.target.value); setProductPage(1); }}
          aria-label="按类型筛选"
          data-testid="merchant-product-type-filter"
        >
          <option value="">全部类型</option>
          {registry?.productTypes?.map((pt) => (
            <option key={pt.value} value={pt.value}>{pt.label}</option>
          ))}
        </select>
        <select
          className="input py-2 w-auto appearance-none cursor-pointer"
          value={productModeFilter}
          onChange={(e) => { setProductModeFilter(e.target.value); setProductPage(1); }}
          aria-label="按发货模式筛选"
          data-testid="merchant-product-mode-filter"
        >
          <option value="">全部发货模式</option>
          {registry?.deliveryModes?.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-[var(--color-text)] cursor-pointer select-none whitespace-nowrap">
          <input
            type="checkbox"
            checked={productLowStockOnly}
            onChange={(e) => { setProductLowStockOnly(e.target.checked); setProductPage(1); }}
            className="w-4 h-4 cursor-pointer accent-[var(--color-primary)]"
            data-testid="merchant-product-lowstock-toggle"
          />
          仅看低库存
        </label>
      </div>
      <div className="overflow-x-auto">
        {loading && products.length === 0 ? (
          <TableSkeleton />
        ) : (
        <table className="table-cards w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-[var(--color-border)]">
              <Th>ID</Th>
              <Th>名称</Th>
              <Th>价格</Th>
              <Th>可售资源/销量</Th>
              <Th>状态</Th>
              <Th align="right">操作</Th>
            </tr>
          </thead>
          <tbody>
            {!loading && products.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState compact icon={Package} title="暂无商品" description="点击右上角「新建商品」上架第一个商品" />
                </td>
              </tr>
            ) : (
              products.map((p) => {
                // P4a：按「该商品是否存在对应类型的规格」判定入口——每个规格
                // 有独立 deliveryMode，混合规格商品可能同时需要交付库存导入与
                // 名额调整。只看商品级投影（= 默认规格的模式）会让另一半规格
                // 永远无法管理。offers 缺失时回落到商品级投影（旧行为）。
                const rowOffers = p.offers ?? []
                const inventoryManaged = rowOffers.length > 0
                  ? rowOffers.some(o => o.deliveryMode === 'instant_inventory')
                  : isInstantInventoryProduct(p)
                const capacityManaged = rowOffers.length > 0
                  ? rowOffers.some(o => o.deliveryMode !== 'instant_inventory' && o.stockMode === 'limited')
                  : (!isInstantInventoryProduct(p) && p.stockMode === 'limited')
                const stockCount = inventoryManaged
                  ? (p.availableStock ?? p._count?.inventory ?? p.stock)
                  : p.stock
                const threshold = registry?.inventory?.lowStockThreshold
                const isLowStock = p.lowStock ?? (
                  inventoryManaged &&
                  typeof threshold === 'number' &&
                  stockCount <= threshold
                )
                return (
                  <tr key={p.id} className="border-b border-[var(--color-border)] hover:bg-[var(--color-background)] transition-colors">
                    <td className="py-3 px-2 text-sm text-[var(--color-text-muted)]" data-label="ID">{p.id}</td>
                    <td className="py-3 px-2 text-sm font-medium text-[var(--color-text)]" data-label="名称">{p.name}</td>
                    <td className="py-3 px-2 text-sm text-[var(--color-text)]" data-label="价格">{p.price}</td>
                    <td className="py-3 px-2 text-sm text-[var(--color-text-muted)]" data-label="可售资源/销量">
                      {rowOffers.length > 0 ? (
                        <div className="space-y-1" data-testid={`merchant-product-availability-${p.id}`}>
                          {inventoryManaged && (
                            <div className="font-medium text-[var(--color-text)]">
                              商品交付库存汇总：{p.availableStock ?? stockCount}
                            </div>
                          )}
                          {rowOffers.map((offer) => (
                            <div key={offer.id} className="text-xs">
                              <span className="font-medium text-[var(--color-text)]">{offer.name}</span>：{getOfferAvailabilityLabel(offer)}
                            </div>
                          ))}
                          <div className="text-xs">商品累计已售：{p.sales}</div>
                        </div>
                      ) : (
                        <span className="whitespace-nowrap">
                          {getAvailabilityLabel(p)}{' '}
                          {p.stockMode !== 'unlimited' && stockCount}
                          {' / 已售 '}{p.sales}
                        </span>
                      )}
                      {isLowStock && (
                        <span
                          className="inline-flex items-center gap-1 ml-2 px-2 py-0.5 rounded text-xs font-bold border bg-[var(--color-danger)]/10 text-[var(--color-danger)] border-[var(--color-danger)]/25"
                          data-testid={`low-stock-badge-${p.id}`}
                        >
                          <AlertTriangle className="w-3 h-3" /> 低库存
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-2 text-sm" data-label="状态">
                      <StatusPill kind={p.status === 'active' ? 'active' : 'inactive'} />
                    </td>
                    <td className="py-3 px-2 text-right whitespace-nowrap" data-label="操作">
                      {rowOffers.length > 0 && (
                        <LinkAction onClick={() => onManageAvailability(p)}>
                          管理可售资源
                        </LinkAction>
                      )}
                      {inventoryManaged && (
                        <LinkAction onClick={() => onManageInventory(p)}>
                          管理交付库存
                        </LinkAction>
                      )}
                      {capacityManaged && (
                        <LinkAction onClick={() => onAdjustCapacity(p)}>
                          {p.deliveryMode === 'manual_service' ? '调整服务名额' : '调整可售名额'}
                        </LinkAction>
                      )}
                      {(inventoryManaged || capacityManaged) && (
                        <LinkAction onClick={() => onViewInventoryLog(p)}>
                          可售资源记录
                        </LinkAction>
                      )}
                      <LinkAction onClick={() => onEditProduct(p.id)}>
                        编辑
                      </LinkAction>
                      <LinkAction onClick={() => onManageOffers(p)}>
                        规格管理
                      </LinkAction>
                      <LinkAction
                        onClick={() => onToggleProductStatus(p)}
                        disabled={publishingProductIds.has(p.id)}
                        testId={`merchant-product-toggle-status-${p.id}`}
                      >
                        {p.status === 'active' ? '下架' : '上架'}
                      </LinkAction>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
        )}
      </div>
      <PaginationControls page={productPage} total={productTotal} setPage={setProductPage} testId="merchant-product-pagination" />
    </div>
  )
}
