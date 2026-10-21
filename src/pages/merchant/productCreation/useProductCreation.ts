import { useEffect, useRef, useState } from 'react'
import type { CatalogAdapter } from '../../../api/catalog'
import { readinessErrorToIssues } from '../../../api/catalog'
import { getApiErrorMessage } from '../../../api/error'
import type { AvailabilityOffer, PublicationReadiness } from '../../../types/catalog'
import { useAppStore } from '../../../stores/appStore'
import { captureFeedbackOwner } from '../../../lib/completionFeedback'
import { showProductPublished } from '../../../lib/productPublicationFeedback'
import { buildProductDraftRequest, validateCreationStep, type ProductCreationDraft } from './draft'

interface Options {
  adapter: CatalogAdapter
  input: ProductCreationDraft
  publicationStepActive: boolean
  navigate: (path: string) => void
}

export function useProductCreation({ adapter, input, publicationStepActive, navigate }: Options) {
  const showToast = useAppStore(s => s.showToast)
  const { templateKey, form } = input
  const validateStep = (step: number) => validateCreationStep(step, input)
  const [draft, setDraft] = useState<{ id: number } | null>(null)
  const [availabilityOffers, setAvailabilityOffers] = useState<AvailabilityOffer[] | null>(null)
  const [availabilityLoading, setAvailabilityLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [readiness, setReadiness] = useState<PublicationReadiness | null>(null)
  const [readinessLoading, setReadinessLoading] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const publishingRef = useRef(false)

  async function loadAvailabilityOffers(productId: number): Promise<boolean> {
    setAvailabilityLoading(true)
    try {
      const offers = await adapter.listProductOffers(productId)
      setAvailabilityOffers(offers)
      return true
    } catch {
      setAvailabilityOffers(null)
      showToast('草稿已保存，但规格加载失败；请重试后再调整可售量', 'error')
      return false
    } finally {
      setAvailabilityLoading(false)
    }
  }

  /**
   * 保存草稿：原子 create draft Product+Offers（v2）。成功后保留
   * productId，失败保留全部输入并停留当前步。已保存过则幂等直接通过。
   */
  async function saveDraft(): Promise<boolean> {
    if (draft || savingRef.current) return true
    savingRef.current = true
    const firstError = [0, 1, 2, 3].map(v => validateStep(v)).find(Boolean)
    if (firstError || templateKey == null) {
      savingRef.current = false
      showToast(firstError ?? '请选择商品形态', 'error')
      return false
    }
    setSaving(true)
    try {
      const created = await adapter.createProductV2(buildProductDraftRequest({ ...input, templateKey }))
      setDraft({ id: created.id })
      await loadAvailabilityOffers(created.id)
      showToast('草稿已保存，可继续配置可售量')
      return true
    } catch (err) {
      showToast(getApiErrorMessage(err, '草稿保存失败，请重试'), 'error')
      return false
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  async function handleAdjustCapacity(request: { offerId: number; delta: number; reason: string }) {
    const id = draft?.id
    if (id == null) throw new Error('尚未保存草稿')
    await adapter.adjustCapacity(id, request)
    showToast('可售名额已调整')
  }

  async function handleVoidInventory(request: { offerId: number; count: number; reason: string }) {
    const id = draft?.id
    if (id == null) throw new Error('尚未保存草稿')
    await adapter.voidInventory(id, request)
    showToast('交付库存已作废')
  }

  useEffect(() => {
    if (publicationStepActive && draft && !publishing) {
      let cancelled = false
      setReadinessLoading(true)
      adapter.getPublicationReadiness(draft.id)
        .then(r => { if (!cancelled) setReadiness(r) })
        .catch(() => {
          if (!cancelled) {
            setReadiness(null)
            showToast('获取发布检查失败，请重试', 'error')
          }
        })
        .finally(() => { if (!cancelled) setReadinessLoading(false) })
      return () => { cancelled = true }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicationStepActive, draft, publishing])

  async function handlePublish() {
    const id = draft?.id
    if (id == null || publishingRef.current) return
    const isCurrent = captureFeedbackOwner()
    publishingRef.current = true
    setPublishing(true)
    try {
      const result = await adapter.publishProduct(id)
      if (!isCurrent()) return
      if (showProductPublished({ id, name: form.name.trim() }, result, navigate)) navigate('/merchant')
    } catch (err) {
      if (!isCurrent()) return
      const issues = readinessErrorToIssues(err)
      if (issues.length > 0) {
        setReadiness({ ready: false, productId: id, issues })
      }
      showToast(getApiErrorMessage(err, '发布失败，请先解决检查清单中的问题'), 'error')
    } finally {
      publishingRef.current = false
      setPublishing(false)
    }
  }

  return {
    draft, availabilityOffers, availabilityLoading, saving, readiness, readinessLoading, publishing,
    saveDraft, loadAvailabilityOffers, handleAdjustCapacity, handleVoidInventory, handlePublish,
  }
}
