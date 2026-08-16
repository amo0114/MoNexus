import DOMPurify from 'dompurify'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Upload } from 'lucide-react'
import {
  getAdminFakaCatalog,
  importAdminFakaPlan,
  previewAdminFakaPlan,
  type AdminFakaCatalogPlan,
  type AdminFakaImportPreview as FakaPreview,
  type AdminFakaImportRequest,
} from '../../api/admin'
import { getApiErrorCode, getApiErrorMessage } from '../../api/error'
import { uploadImage } from '../../api/uploads'
import { useAppStore } from '../../stores/appStore'
import type { CategoryRegistryItem } from '../../types/catalog'
import { newIdempotencyKey } from '../../utils/idempotencyKey'
import { createLatestRequestGuard } from '../../utils/latestRequest'
import SafeImage from '../ui/SafeImage'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'
import ProductCategorySelect from './ProductCategorySelect'
import { catalogGovernanceApi } from '../../api/catalogGovernance'
import { isCoverIssue, projectCatalogIssue } from './catalogIssueMessages'

interface Props {
  open: boolean
  onClose: () => void
  onImported: (productId: number) => void | Promise<void>
}

type OfferRow = { selected: boolean; pricePoints: string; sku: string; offerName: string }
type CoverMode = 'category_default' | 'uploaded'

const PERIOD_LABELS: Record<string, string> = {
  monthly: '月付', quarterly: '季付', half_yearly: '半年付', yearly: '年付',
  two_yearly: '两年付', three_yearly: '三年付', onetime: '流量包', reset_traffic: '重置包',
}

function existingProductId(error: unknown): number | null {
  const details = (error as any)?.response?.data?.error?.details
  if (!Array.isArray(details)) return null
  const raw = details.find((item) => item?.field === 'existingProductId')?.message
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/** T-CAT-FE-004: mandatory preview, registered cover, source-bound idempotent confirm. */
export default function AdminFakaImportPreview({ open, onClose, onImported }: Props) {
  const showToast = useAppStore((state) => state.showToast)
  const [catalog, setCatalog] = useState<AdminFakaCatalogPlan[]>([])
  const [categories, setCategories] = useState<CategoryRegistryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [planId, setPlanId] = useState<number | null>(null)
  const [productName, setProductName] = useState('')
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [rows, setRows] = useState<Record<string, OfferRow>>({})
  const [coverMode, setCoverMode] = useState<CoverMode>('category_default')
  const [uploadedObjectKey, setUploadedObjectKey] = useState<string | null>(null)
  const [uploadedPreviewUrl, setUploadedPreviewUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  // Category id → canonical default-cover URL (for instant preview / pre-
  // preview missing-cover action, AC-UX-012).
  const [categoryCoverMap, setCategoryCoverMap] = useState<Record<number, string | null>>({})
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<FakaPreview | null>(null)
  const [previewRequest, setPreviewRequest] = useState<AdminFakaImportRequest | null>(null)
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [conflictProductId, setConflictProductId] = useState<number | null>(null)
  const previewGuard = useRef(createLatestRequestGuard()).current
  const coverInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) {
      previewGuard.invalidate()
      return
    }
    let cancelled = false
    setLoading(true)
    setCatalog([])
    setCategories([])
    setCategoryCoverMap({})
    setPlanId(null)
    setProductName('')
    setCategoryId(null)
    setRows({})
    // The uploaded-cover draft survives a temporary close/reopen (D-UX-13,
    // T-UX-004): it is only cleared on explicit cancel or confirm success.
    setPreview(null)
    setPreviewRequest(null)
    setIdempotencyKey(null)
    setConflictProductId(null)
    Promise.all([
      getAdminFakaCatalog(),
      catalogGovernanceApi.listCategories({ status: 'active', page: 1, pageSize: 100 }),
    ])
      .then(([catalogResult, categoryResult]) => {
        if (cancelled) return
        setCatalog(catalogResult.plans ?? [])
        setCategories(categoryResult.items)
        setCategoryCoverMap(
          Object.fromEntries(
            categoryResult.items.map(item => [item.id, item.defaultCoverUrl]),
          ),
        )
      })
      .catch((error) => {
        if (cancelled) return
        setCatalog([])
        setCategories([])
        setCategoryCoverMap({})
        showToast(getApiErrorMessage(error, '加载 Xboard 导入数据失败'), 'error')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => {
      cancelled = true
      previewGuard.invalidate()
    }
  }, [open, previewGuard, showToast])

  function invalidatePreview() {
    previewGuard.invalidate()
    setPreviewing(false)
    setPreview(null)
    setPreviewRequest(null)
    setIdempotencyKey(null)
    setConflictProductId(null)
  }

  /** Clear the uploaded-cover draft — only on explicit cancel or confirm success. */
  function clearDraft() {
    setUploadedObjectKey(null)
    setUploadedPreviewUrl(null)
    setUploadError(null)
    setCoverMode('category_default')
  }

  function choosePlan(nextPlanId: number | null) {
    invalidatePreview()
    setPlanId(nextPlanId)
    const plan = catalog.find((item) => item.plan_id === nextPlanId)
    setProductName(plan?.name ?? '')
    const nextRows: Record<string, OfferRow> = {}
    for (const period of plan?.periods ?? []) {
      const named = plan?.named_skus?.find((item) => item.period === period.period)
      nextRows[period.period] = {
        selected: true,
        pricePoints: String(Math.max(1, Math.round(period.price * 100))),
        sku: named?.sku ?? period.sku_alias,
        offerName: PERIOD_LABELS[period.period] ?? period.period,
      }
    }
    setRows(nextRows)
  }

  function updateRow(period: string, patch: Partial<OfferRow>) {
    invalidatePreview()
    setRows((current) => ({ ...current, [period]: { ...current[period]!, ...patch } }))
  }

  function buildRequest(): AdminFakaImportRequest | null {
    if (planId == null || categoryId == null) {
      showToast('请选择 Xboard 套餐和商品分类', 'error')
      return null
    }
    if (coverMode === 'uploaded' && !uploadedObjectKey) {
      showToast('请先上传封面图片', 'error')
      return null
    }
    const offers = []
    for (const [period, row] of Object.entries(rows)) {
      if (!row.selected) continue
      const pricePoints = Number(row.pricePoints)
      if (!Number.isInteger(pricePoints) || pricePoints <= 0) {
        showToast(`周期 ${period} 的积分售价无效`, 'error')
        return null
      }
      if (!row.offerName.trim()) {
        showToast(`周期 ${period} 的规格名称不能为空`, 'error')
        return null
      }
      offers.push({
        period,
        ...(row.sku.trim() ? { sku: row.sku.trim() } : {}),
        offerName: row.offerName.trim(),
        pricePoints,
      })
    }
    if (offers.length === 0) {
      showToast('请至少选择一个周期规格', 'error')
      return null
    }
    return {
      planId,
      categoryId,
      ...(productName.trim() ? { productName: productName.trim() } : {}),
      cover: coverMode === 'uploaded'
        ? { mode: 'uploaded', objectKey: uploadedObjectKey! }
        : { mode: 'category_default' },
      offers,
    }
  }

  async function runPreview() {
    const request = buildRequest()
    if (!request) return
    const canCommit = previewGuard.begin()
    setPreviewing(true)
    try {
      const result = await previewAdminFakaPlan(request)
      if (!canCommit()) return
      setPreview(result)
      setPreviewRequest(request)
      setIdempotencyKey(newIdempotencyKey())
    } catch (error) {
      if (canCommit()) showToast(getApiErrorMessage(error, 'Xboard 预览失败'), 'error')
    } finally {
      if (canCommit()) setPreviewing(false)
    }
  }

  async function confirm() {
    if (!preview?.canConfirm || !previewRequest || !idempotencyKey) return
    setConfirming(true)
    setConflictProductId(null)
    try {
      const result = await importAdminFakaPlan(
        { ...previewRequest, sourceHash: preview.sourceHash },
        idempotencyKey,
      )
      showToast(result.replayed
        ? `幂等重放：商品 #${result.productId} 已存在，未重复创建`
        : `已创建 Xboard 商品草稿 #${result.productId}（${result.offerCount ?? preview.offers.length} 个规格）`)
      clearDraft()
      await onImported(result.productId)
      onClose()
    } catch (error) {
      const code = getApiErrorCode(error)
      if (code === 'FAKA_SOURCE_CHANGED') {
        invalidatePreview()
        showToast('Xboard 套餐已变化，请重新预览', 'error')
      } else {
        const productId = existingProductId(error)
        if (productId != null) setConflictProductId(productId)
        showToast(getApiErrorMessage(error, 'Xboard 导入失败'), 'error')
      }
    } finally {
      setConfirming(false)
    }
  }

  const safeRichDescription = useMemo(() => DOMPurify.sanitize(preview?.richDescription ?? '', {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['img', 'style', 'script', 'iframe', 'object', 'form'],
  }), [preview?.richDescription])

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !confirming) onClose() }}>
      <DialogContent className="max-w-3xl max-h-[92dvh] overflow-y-auto" data-testid="admin-faka-import-preview">
        <DialogTitle>从 Xboard 导入套餐</DialogTitle>
        <DialogDescription>
          必须先预览净化后的商品、规格与封面；确认时会重读 Xboard 并以数据库唯一约束裁决。
        </DialogDescription>
        {loading ? (
          <p className="mt-5 text-sm text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 inline animate-spin" /> 正在加载…</p>
        ) : (
          <div className="mt-5 space-y-5">
            <div>
              <label htmlFor="admin-faka-plan" className="block text-sm font-bold mb-1.5">Xboard 套餐 *</label>
              <select id="admin-faka-plan" className="input" value={planId ?? ''}
                onChange={(event) => choosePlan(Number(event.target.value) || null)}
                data-testid="admin-faka-import-plan" disabled={confirming}>
                <option value="">请选择</option>
                {catalog.map((plan) => (
                  <option key={plan.plan_id} value={plan.plan_id}>
                    #{plan.plan_id} {plan.name}{!plan.sell ? ' · 停售' : ''} · {plan.periods.length} 周期
                  </option>
                ))}
              </select>
            </div>
            {planId != null && (
              <>
                <div>
                  <label htmlFor="admin-faka-name" className="block text-sm font-bold mb-1.5">商品名称</label>
                  <input id="admin-faka-name" className="input" value={productName}
                    onChange={(event) => { invalidatePreview(); setProductName(event.target.value) }}
                    data-testid="admin-faka-import-name" disabled={confirming} />
                </div>
                <ProductCategorySelect categories={categories} value={categoryId}
                  onChange={(next) => { invalidatePreview(); setCategoryId(next) }} disabled={confirming} />
                <fieldset className="space-y-3">
                  <legend className="text-sm font-bold">封面来源 *</legend>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name="faka-cover" checked={coverMode === 'category_default'}
                      onChange={() => { invalidatePreview(); setUploadError(null); setCoverMode('category_default') }} />
                    使用分类默认封面（预览时校验）
                  </label>
                  {coverMode === 'category_default' && categoryId != null && (
                    categoryCoverMap[categoryId] ? (
                      <div className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] p-3">
                        <SafeImage src={categoryCoverMap[categoryId]!} alt="分类默认封面预览" className="w-16 h-16 object-cover rounded-lg" data-testid="admin-faka-category-cover-preview" />
                        <span className="text-sm text-[var(--color-text-muted)]">将使用该分类的默认封面。</span>
                      </div>
                    ) : (
                      <div className="rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/10 p-3 text-sm" data-testid="admin-faka-cover-missing">
                        <p className="text-[var(--color-text)]">所选分类还没有默认封面。</p>
                        <p className="text-xs text-[var(--color-text-muted)] mt-1">可切换上方「上传平台托管封面」，或在分类管理中为该分类设置默认封面。</p>
                      </div>
                    )
                  )}
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name="faka-cover" checked={coverMode === 'uploaded'}
                      onChange={() => { invalidatePreview(); setUploadError(null); setCoverMode('uploaded') }} />
                    上传平台托管封面
                  </label>
                  {coverMode === 'uploaded' && (
                    <div className="rounded-lg border border-[var(--color-border)] p-3">
                      <button
                        type="button"
                        className="btn-secondary inline-flex items-center gap-2"
                        disabled={uploading || confirming}
                        aria-busy={uploading}
                        aria-describedby={`admin-faka-cover-help${uploadError ? ' admin-faka-cover-error' : ''}`}
                        onClick={() => coverInputRef.current?.click()}
                      >
                        {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                        {uploading ? '上传中…' : '选择本地图片'}
                      </button>
                      <input
                        id="admin-faka-cover-file"
                        ref={coverInputRef}
                        type="file"
                        className="hidden"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        disabled={uploading || confirming}
                        aria-label="上传商品封面"
                        aria-busy={uploading}
                        aria-invalid={Boolean(uploadError)}
                        aria-describedby={`admin-faka-cover-help${uploadError ? ' admin-faka-cover-error' : ''}`}
                        onChange={async (event) => {
                          const file = event.target.files?.[0]
                          event.target.value = ''
                          if (!file) return
                          setUploading(true)
                          setUploadError(null)
                          try {
                            const result = await uploadImage(file)
                            invalidatePreview()
                            setUploadedObjectKey(result.key)
                            setUploadedPreviewUrl(result.url)
                          } catch (error) {
                            const message = getApiErrorMessage(error, '封面上传失败')
                            setUploadError(message)
                            showToast(message, 'error')
                          } finally {
                            setUploading(false)
                          }
                        }}
                      />
                      <p id="admin-faka-cover-help" className="mt-2 text-xs text-[var(--color-text-muted)]">
                        PNG / JPEG / WebP / GIF，最大 5MB
                      </p>
                      {uploadError && (
                        <p id="admin-faka-cover-error" role="alert" className="mt-2 text-xs text-[var(--color-danger)]">
                          {uploadError}
                        </p>
                      )}
                      {uploadedPreviewUrl && <SafeImage src={uploadedPreviewUrl} alt="已上传封面" className="mt-3 w-28 h-28 rounded-lg object-cover" data-testid="admin-faka-uploaded-cover-preview" />}
                    </div>
                  )}
                </fieldset>
                <section className="space-y-3" data-testid="admin-faka-import-periods">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold">规格（周期）</h3>
                    <button type="button" className="text-xs text-[var(--color-primary)] underline"
                      onClick={() => {
                        invalidatePreview()
                        setRows((current) => {
                          const allSelected = Object.values(current).every((row) => row.selected)
                          return Object.fromEntries(Object.entries(current).map(([key, row]) => [key, { ...row, selected: !allSelected }]))
                        })
                      }}>全选/反选</button>
                  </div>
                  {Object.entries(rows).map(([period, row]) => (
                    <div key={period} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] p-3 space-y-3">
                      <label className="flex items-center gap-2 text-sm font-bold">
                        <input type="checkbox" checked={row.selected} onChange={(event) => updateRow(period, { selected: event.target.checked })} />
                        {PERIOD_LABELS[period] ?? period} <span className="font-normal text-[var(--color-text-muted)]">({period})</span>
                      </label>
                      {row.selected && <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <input aria-label={`${period} 规格名`} className="input" value={row.offerName}
                          onChange={(event) => updateRow(period, { offerName: event.target.value })} />
                        <input aria-label={`${period} 积分售价`} type="number" min="1" className="input font-mono" value={row.pricePoints}
                          onChange={(event) => updateRow(period, { pricePoints: event.target.value })} />
                        <input aria-label={`${period} externalSku`} className="input font-mono" value={row.sku}
                          onChange={(event) => updateRow(period, { sku: event.target.value })} />
                      </div>}
                    </div>
                  ))}
                </section>
              </>
            )}

            {preview && (
              <section className="rounded-xl border border-[var(--color-border)] p-4 space-y-4" data-testid="admin-faka-preview-result">
                <div className="flex items-start gap-4">
                  {preview.cover && <SafeImage src={preview.cover.imageUrl} alt="导入封面预览" className="w-24 h-24 object-cover rounded-lg" />}
                  <div>
                    <h3 className="font-bold text-lg">{preview.productName}</h3>
                    <p className="text-sm text-[var(--color-text-muted)]">{preview.plainDescription}</p>
                    <p className="text-xs mt-2">名额：{preview.capacity.remaining == null ? '不限' : preview.capacity.remaining}；在用 {preview.capacity.activeUsers}</p>
                  </div>
                </div>
                {safeRichDescription && <div className="prose prose-sm max-w-none" data-testid="admin-faka-rich-preview"
                  dangerouslySetInnerHTML={{ __html: safeRichDescription }} />}
                <ul className="text-sm space-y-1">
                  {preview.offers.map((offer) => <li key={offer.sku}>{offer.offerName} · {offer.pricePoints} 积分 · {offer.sku}</li>)}
                </ul>
                {preview.issues.length > 0 && <ul className="text-sm space-y-1" data-testid="admin-faka-preview-issues">
                  {preview.issues.map((issue, index) => {
                    const projected = projectCatalogIssue(issue)
                    return (
                      <li key={`${issue.code}-${index}`} data-code={issue.code} data-action={projected.action}>
                        {projected.message}
                      </li>
                    )
                  })}
                </ul>}
              </section>
            )}

            {conflictProductId != null && (
              <button type="button" className="btn-secondary w-full" data-testid="admin-faka-existing-product"
                onClick={async () => { await onImported(conflictProductId); onClose() }}>
                查看已存在商品 #{conflictProductId}
              </button>
            )}
            <div className="flex justify-end gap-3">
              <button type="button" className="btn-secondary" onClick={() => { clearDraft(); onClose() }} disabled={confirming}>取消</button>
              {!preview ? (
                <button type="button" className="btn-primary" onClick={runPreview}
                  disabled={previewing || uploading || confirming || planId == null}
                  data-testid="admin-faka-import-preview-submit">
                  {previewing ? <Loader2 className="w-4 h-4 animate-spin" /> : '预览导入结果'}
                </button>
              ) : (
                <button type="button" className="btn-primary" onClick={confirm}
                  disabled={confirming || !preview.canConfirm}
                  data-testid="admin-faka-import-submit">
                  {confirming ? <Loader2 className="w-4 h-4 animate-spin" /> : '确认导入商品草稿'}
                </button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
