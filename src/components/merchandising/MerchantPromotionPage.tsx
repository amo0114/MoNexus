// T-MERCH-FE-002 — MerchantPromotionPage: standalone, independently-mountable
// page composing PromotionPackagePicker + MerchantCampaignPanel.
//
// Mounted at /merchant/promotions; ?view=records opens the unfiltered list.
//
// Behaviour:
//  - fetches packages, active merchant products and the campaign list;
//  - the status filter and page are kept in component state AND persisted to
//    sessionStorage so a hard browser refresh (and every list refresh after
//    create/cancel/retry) preserves the current filter/page;
//  - create/cancel/retry are wired with the typed merchant-safe error
//    normalization; the list is reloaded after each mutation keeping
//    filter/page; empty/loading/error states are recoverable.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { captureFeedbackOwner, showCompletionActivity } from '../../lib/completionFeedback'
import { useAppStore } from '../../stores/appStore'
import { useAuthStore } from '../../stores/authStore'
import { getMe } from '../../api/auth'
import { getAuthSessionContext } from '../../auth/sessionContext'
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
import { promotionCompletion } from './promotionFeedback'
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

export default function MerchantPromotionPage(props: MerchantPromotionPageProps) {
  const authEpoch = useAuthStore((state) => state.authEpoch)
  const userId = useAuthStore((state) => state.user?.id)
  const sessionId = useAuthStore((state) => state.sessionId)
  return <MerchantPromotionContent key={`${authEpoch}:${userId}:${sessionId}`} {...props} />
}

function MerchantPromotionContent({
  fetchProducts = defaultFetchProducts,
  className = '',
}: MerchantPromotionPageProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const viewRecords = new URLSearchParams(location.search).get('view') === 'records'
  const recordsRef = useRef<HTMLDivElement>(null)
  const focusRecords = useRef(viewRecords)
  const mounted = useRef(false)
  const listRequest = useRef(0)
  const actionInFlight = useRef<number | null>(null)
  const [packages, setPackages] = useState<PromotionPackageDTO[]>([])
  const [products, setProducts] = useState<PromotionProductOption[]>([])
  const [packagesLoading, setPackagesLoading] = useState(true)
  const [packagesError, setPackagesError] = useState<string | null>(null)

  const [campaigns, setCampaigns] = useState<PromotionCampaignDTO[]>([])
  const [total, setTotal] = useState(0)
  const [statusFilter, setStatusFilter] = useState<CampaignStatusFilter>(() => viewRecords ? 'all' : readStoredFilter())
  const [page, setPage] = useState<number>(() => viewRecords ? 1 : readStoredPage())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionBusyId, setActionBusyId] = useState<number | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; listRequest.current++ }
  }, [])

  useEffect(() => {
    if (!viewRecords) return
    setStatusFilter('all')
    setPage(1)
    focusRecords.current = true
  }, [location.key, viewRecords])

  useEffect(() => {
    if (!focusRecords.current || packagesLoading || loading || statusFilter !== 'all' || page !== 1) return
    focusRecords.current = false
    recordsRef.current?.scrollIntoView({ block: 'start' })
    recordsRef.current?.focus({ preventScroll: true })
  }, [packagesLoading, loading, statusFilter, page, location.key])

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
    const isCurrent = captureFeedbackOwner()
    setPackagesLoading(true)
    setPackagesError(null)
    Promise.all([listPromotionPackages(), fetchProducts()])
      .then(([pkg, prod]) => {
        if (!mounted || !isCurrent()) return
        setPackages(pkg)
        setProducts(prod)
      })
      .catch((e) => {
        if (mounted && isCurrent()) setPackagesError(normalizePromotionError(e).message)
      })
      .finally(() => {
        if (mounted && isCurrent()) setPackagesLoading(false)
      })
    return () => {
      mounted = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reload the campaign list, preserving the current filter/page.
  const reload = useCallback(async () => {
    const request = ++listRequest.current
    const isOwner = captureFeedbackOwner()
    const isCurrent = () => mounted.current && isOwner() && request === listRequest.current
    setLoading(true)
    setLoadError(null)
    try {
      const data = await listPromotionCampaigns({
        status: statusFilter,
        page,
        pageSize: DEFAULT_PAGE_SIZE,
      })
      if (isCurrent()) {
        setCampaigns(data.items)
        setTotal(data.total)
      }
    } catch (e) {
      if (isCurrent()) setLoadError(normalizePromotionError(e).message)
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [statusFilter, page, location.key])
  const reloadRef = useRef(reload)

  useEffect(() => {
    reloadRef.current = reload
    void reload()
    return () => { listRequest.current++ }
  }, [reload])

  function notifyResult(campaign: PromotionCampaignDTO) {
    // This page already has persistent desktop results. Only mobile adds an island.
    if (!window.matchMedia('(max-width: 767px)').matches || !useAppStore.getState().islandNoticeAvailable) return
    showCompletionActivity({
      ...promotionCompletion(campaign),
      groupKey: `merchant-promotion:${campaign.id}`,
      actionLabel: '查看推广列表',
      onAction: () => navigate('/merchant/promotions?view=records'),
    })
  }

  function handleFilterChange(filter: CampaignStatusFilter) {
    setStatusFilter(filter)
    setPage(1)
  }

  function handlePageChange(next: number) {
    if (next < 1) return
    setPage(next)
  }

  async function handleCreate(payload: PromotionCreatePayload, idempotencyKey: string) {
    const isCurrent = captureFeedbackOwner()
    const campaign = await createPromotionCampaign(payload, idempotencyKey)
    // Creation is already authoritative once POST succeeds. A failed list
    // calibration must not turn that successful mutation into a retry prompt
    // (and accidentally suggest that the merchant should submit it again).
    if (mounted.current && isCurrent()) {
      notifyResult(campaign)
      void reloadRef.current()
    }
    return campaign
  }

  async function handleCancel(campaign: PromotionCampaignDTO) {
    if (actionInFlight.current !== null) return
    actionInFlight.current = campaign.id
    const isCurrent = captureFeedbackOwner()
    setActionBusyId(campaign.id)
    setActionError(null)
    try {
      const result = await cancelPromotionCampaign(campaign.id, newPromotionIdempotencyKey())
      if (!mounted.current || !isCurrent()) return
      notifyResult(result)
      await reloadRef.current()
    } catch (e) {
      if (mounted.current && isCurrent()) setActionError(normalizePromotionError(e).message)
    } finally {
      actionInFlight.current = null
      setActionBusyId(null)
    }
  }

  async function handleRetryPayment(campaign: PromotionCampaignDTO) {
    if (actionInFlight.current !== null) return
    actionInFlight.current = campaign.id
    const isCurrent = captureFeedbackOwner()
    setActionBusyId(campaign.id)
    setActionError(null)
    try {
      const result = await retryPromotionPayment(campaign.id, newPromotionIdempotencyKey())
      if (!mounted.current || !isCurrent()) return
      if (result.status === 'payment_failed') setActionError('积分余额不足，推广尚未扣费，请补充积分后重试。')
      notifyResult(result)
      if (result.status === 'active' || result.status === 'scheduled') {
        const context = getAuthSessionContext(useAuthStore.getState())
        if (context) {
          void getMe().then(user => {
            if (isCurrent()) useAuthStore.getState().setUser(user, context)
          }).catch(() => {
            if (mounted.current && isCurrent()) setActionError('推广已扣费，但余额刷新失败，请刷新页面。')
          })
        }
      }
      await reloadRef.current()
    } catch (e) {
      if (mounted.current && isCurrent()) setActionError(normalizePromotionError(e).message)
    } finally {
      actionInFlight.current = null
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

      <div ref={recordsRef} tabIndex={-1} aria-label="推广记录" className="scroll-mt-[calc(var(--navbar-h)+1rem)] focus:outline-none" data-testid="merchant-promotion-records">
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
    </div>
  )
}
