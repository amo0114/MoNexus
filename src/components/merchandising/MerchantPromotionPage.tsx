// T-MERCH-FE-002 — MerchantPromotionPage: standalone, independently-mountable
// page composing PromotionPackagePicker + MerchantCampaignPanel.
//
// It is deliberately NOT wired into App.tsx / MerchantDashboardPage.tsx / any
// shared host — the CMI Integration Owner mounts this page (or its two child
// components) after host release H (PAR-CMI-001 §5.4).
//
// Behaviour:
//  - fetches packages, active merchant products and the campaign list;
//  - the status filter and page are kept in component state AND persisted to
//    sessionStorage so a hard browser refresh (and every list refresh after
//    create/cancel/retry) preserves the current filter/page;
//  - create/cancel/retry are wired with the typed merchant-safe error
//    normalization; the list is reloaded after each mutation keeping
//    filter/page; empty/loading/error states are recoverable.

import { useCallback, useEffect, useState } from 'react'
import type {
  CampaignStatusFilter,
  PromotionCampaignDTO,
  PromotionCreatePayload,
  PromotionPackageDTO,
  PromotionProductOption,
} from '../../types/merchandising'
import {
  cancelPromotionCampaign,
  createPromotionCampaign,
  listPromotionCampaigns,
  listPromotionPackages,
  normalizePromotionError,
  newPromotionIdempotencyKey,
  retryPromotionPayment,
} from '../../api/merchandising'
import { getMerchantProducts } from '../../api/merchant'
import { isKnownCampaignStatus } from './promotionCopy'
import PromotionPackagePicker from './PromotionPackagePicker'
import MerchantCampaignPanel from './MerchantCampaignPanel'
import './merchandising.css'

const STORAGE_FILTER_KEY = 'monexus.merch.promotion.filter'
const STORAGE_PAGE_KEY = 'monexus.merch.promotion.page'
const DEFAULT_PAGE_SIZE = 10

function readStoredFilter(): CampaignStatusFilter {
  try {
    const raw = sessionStorage.getItem(STORAGE_FILTER_KEY)
    if (raw === null) return 'all'
    const parsed: unknown = JSON.parse(raw)
    return parsed === 'all' || isKnownCampaignStatus(parsed as string) ? (parsed as CampaignStatusFilter) : 'all'
  } catch {
    return 'all'
  }
}

function readStoredPage(): number {
  try {
    const raw = sessionStorage.getItem(STORAGE_PAGE_KEY)
    if (raw === null) return 1
    const parsed = Number(JSON.parse(raw))
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1
  } catch {
    return 1
  }
}

async function defaultFetchProducts(): Promise<PromotionProductOption[]> {
  const data = await getMerchantProducts({ status: 'active', pageSize: 100 })
  return data.items.map((p) => ({ id: p.id, name: p.name }))
}

export interface MerchantPromotionPageProps {
  /** Injectable product fetcher (default: active merchant products via API). */
  fetchProducts?: () => Promise<PromotionProductOption[]>
  className?: string
}

export default function MerchantPromotionPage({
  fetchProducts = defaultFetchProducts,
  className = '',
}: MerchantPromotionPageProps) {
  const [packages, setPackages] = useState<PromotionPackageDTO[]>([])
  const [products, setProducts] = useState<PromotionProductOption[]>([])
  const [packagesLoading, setPackagesLoading] = useState(true)
  const [packagesError, setPackagesError] = useState<string | null>(null)

  const [campaigns, setCampaigns] = useState<PromotionCampaignDTO[]>([])
  const [total, setTotal] = useState(0)
  const [statusFilter, setStatusFilter] = useState<CampaignStatusFilter>(readStoredFilter)
  const [page, setPage] = useState<number>(readStoredPage)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionBusyId, setActionBusyId] = useState<number | null>(null)

  // Persist filter/page so a hard refresh keeps them (SPEC "刷新列表保留当前
  // filter/page"). Harmless in jsdom/private mode (wrapped in try/catch).
  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_FILTER_KEY, JSON.stringify(statusFilter))
    } catch {
      /* ignore quota/private-mode failures */
    }
  }, [statusFilter])
  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_PAGE_KEY, JSON.stringify(page))
    } catch {
      /* ignore */
    }
  }, [page])

  // Initial load of packages + products.
  useEffect(() => {
    let mounted = true
    setPackagesLoading(true)
    setPackagesError(null)
    Promise.all([listPromotionPackages(), fetchProducts()])
      .then(([pkg, prod]) => {
        if (!mounted) return
        setPackages(pkg)
        setProducts(prod)
      })
      .catch((e) => {
        if (mounted) setPackagesError(normalizePromotionError(e).message)
      })
      .finally(() => {
        if (mounted) setPackagesLoading(false)
      })
    return () => {
      mounted = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reload the campaign list, preserving the current filter/page.
  const reload = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const data = await listPromotionCampaigns({
        status: statusFilter,
        page,
        pageSize: DEFAULT_PAGE_SIZE,
      })
      setCampaigns(data.items)
      setTotal(data.total)
    } catch (e) {
      setLoadError(normalizePromotionError(e).message)
    } finally {
      setLoading(false)
    }
  }, [statusFilter, page])

  useEffect(() => {
    void reload()
  }, [reload])

  function handleFilterChange(filter: CampaignStatusFilter) {
    setStatusFilter(filter)
    setPage(1)
  }

  function handlePageChange(next: number) {
    if (next < 1) return
    setPage(next)
  }

  async function handleCreate(payload: PromotionCreatePayload, idempotencyKey: string) {
    const campaign = await createPromotionCampaign(payload, idempotencyKey)
    // Creation is already authoritative once POST succeeds. A failed list
    // calibration must not turn that successful mutation into a retry prompt
    // (and accidentally suggest that the merchant should submit it again).
    void reload()
    return campaign
  }

  async function handleCancel(campaign: PromotionCampaignDTO) {
    setActionBusyId(campaign.id)
    setActionError(null)
    try {
      await cancelPromotionCampaign(campaign.id, newPromotionIdempotencyKey())
      await reload()
    } catch (e) {
      setActionError(normalizePromotionError(e).message)
    } finally {
      setActionBusyId(null)
    }
  }

  async function handleRetryPayment(campaign: PromotionCampaignDTO) {
    setActionBusyId(campaign.id)
    setActionError(null)
    try {
      await retryPromotionPayment(campaign.id, newPromotionIdempotencyKey())
      await reload()
    } catch (e) {
      setActionError(normalizePromotionError(e).message)
    } finally {
      setActionBusyId(null)
    }
  }

  return (
    <div className={`merch-promo-page ${className}`.trim()}>
      <h1 className="merch-promo-page-title">推广管理</h1>

      {packagesLoading ? (
        <div className="merch-shelf-empty">加载中…</div>
      ) : packagesError ? (
        <div className="merch-shelf-empty" role="alert">
          <span>{packagesError}</span>
        </div>
      ) : (
        <PromotionPackagePicker
          packages={packages}
          products={products}
          onRequest={handleCreate}
          onCreated={() => {
            // List already reloaded in handleCreate; keep filter/page.
          }}
        />
      )}

      <MerchantCampaignPanel
        campaigns={campaigns}
        total={total}
        page={page}
        pageSize={DEFAULT_PAGE_SIZE}
        statusFilter={statusFilter}
        loading={loading}
        loadError={loadError}
        actionError={actionError}
        actionBusyId={actionBusyId}
        onFilterChange={handleFilterChange}
        onPageChange={handlePageChange}
        onRetryLoad={() => void reload()}
        onCancel={(c) => void handleCancel(c)}
        onRetryPayment={(c) => void handleRetryPayment(c)}
        onDismissActionError={() => setActionError(null)}
      />
    </div>
  )
}
