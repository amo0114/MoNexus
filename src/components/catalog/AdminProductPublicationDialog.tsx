import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  getAdminProductReadiness,
  publishAdminProduct,
  type AdminProductReadiness,
  type AdminProductStatus,
} from '../../api/admin'
import { readinessErrorToIssues } from '../../api/catalog'
import { getApiErrorCode, getApiErrorMessage } from '../../api/error'
import { useAppStore } from '../../stores/appStore'
import { createLatestRequestGuard } from '../../utils/latestRequest'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/Dialog'
import ProductPublicationChecklist from './ProductPublicationChecklist'

export type AdminPublicationOrigin = 'xboard-import' | 'product-list'

export type AdminPublicationTarget = {
  id: number
  name: string
  offers?: Array<{ id: number; name: string }>
  origin: AdminPublicationOrigin
}

type LoadState = 'idle' | 'loading' | 'loaded' | 'error'

interface Props {
  open: boolean
  target: AdminPublicationTarget | null
  onClose: () => void
  onPublished: (result: {
    id: number
    name: string
    status: AdminProductStatus
  }) => void | Promise<void>
}

function httpStatus(error: unknown): number | undefined {
  const status = (error as { response?: { status?: unknown } } | undefined)?.response?.status
  return typeof status === 'number' ? status : undefined
}

export default function AdminProductPublicationDialog({
  open,
  target,
  onClose,
  onPublished,
}: Props) {
  const showToast = useAppStore((state) => state.showToast)
  const [loadState, setLoadState] = useState<LoadState>('idle')
  const [readiness, setReadiness] = useState<AdminProductReadiness | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [publishSucceeded, setPublishSucceeded] = useState(false)
  const publishingRef = useRef(false)
  const requestGen = useRef(0)
  const loadGuard = useRef(createLatestRequestGuard()).current
  const targetId = target?.id ?? null

  function isCurrent(generation: number): boolean {
    return requestGen.current === generation
  }

  const offerNames = useMemo(() => {
    const names = new Map<number, string>()
    for (const offer of target?.offers ?? []) {
      if (Number.isInteger(offer.id) && offer.name) names.set(offer.id, offer.name)
    }
    return names
  }, [target?.offers])

  async function loadReadiness(productId: number) {
    const canCommit = loadGuard.begin()
    setLoadState('loading')
    setReadiness(null)
    try {
      const result = await getAdminProductReadiness(productId)
      if (!canCommit()) return
      setReadiness(result)
      setLoadState('loaded')
    } catch {
      if (!canCommit()) return
      setReadiness(null)
      setLoadState('error')
    }
  }

  useEffect(() => {
    requestGen.current += 1
    publishingRef.current = false
    setPublishing(false)
    setPublishSucceeded(false)
    if (!open || targetId == null) {
      loadGuard.invalidate()
      setLoadState('idle')
      setReadiness(null)
      return
    }
    void loadReadiness(targetId)
    return () => {
      loadGuard.invalidate()
    }
  }, [open, targetId, loadGuard])

  async function finishPublished(generation: number, payload: {
    id: number
    name: string
    status: AdminProductStatus
  }) {
    await onPublished(payload)
    if (!isCurrent(generation)) return
    onClose()
  }

  async function handlePublish() {
    if (!target || readiness?.ready !== true || publishingRef.current || publishSucceeded) return
    const generation = requestGen.current
    const payload = { id: target.id, name: target.name }
    publishingRef.current = true
    setPublishing(true)
    let wrote = false
    try {
      const result = await publishAdminProduct(payload.id)
      if (!isCurrent(generation)) return
      wrote = true
      try {
        await finishPublished(generation, { ...payload, status: result.status })
      } catch {
        if (isCurrent(generation)) setPublishSucceeded(true)
      }
    } catch (error) {
      if (!isCurrent(generation) || wrote) return
      const status = httpStatus(error)
      if (status === 422 || getApiErrorCode(error) === 'PRODUCT_NOT_READY') {
        const fallback = readinessErrorToIssues(error)
        if (fallback.length > 0) {
          setReadiness({ ready: false, productId: payload.id, issues: fallback })
          setLoadState('loaded')
        }
        await loadReadiness(payload.id)
      } else if (status === 409) {
        showToast(getApiErrorMessage(error, '商品状态已变化，请刷新后重试'), 'error')
        await loadReadiness(payload.id)
      } else {
        showToast(getApiErrorMessage(error, '发布失败，请稍后重试'), 'error')
      }
    } finally {
      if (isCurrent(generation)) {
        publishingRef.current = false
        setPublishing(false)
      }
    }
  }

  async function retryPublishedRefresh() {
    if (!target || !publishSucceeded) return
    const generation = requestGen.current
    setPublishing(true)
    try {
      await finishPublished(generation, {
        id: target.id,
        name: target.name,
        status: 'active',
      })
    } catch {
      // Parent keeps the distinct refresh-failed toast; stay open for another retry.
    } finally {
      if (isCurrent(generation)) setPublishing(false)
    }
  }

  const imported = target?.origin === 'xboard-import'
  const title = imported ? '商品已导入，准备发布' : `发布「${target?.name ?? '商品'}」`
  const description = imported
    ? `“${target?.name ?? ''}”已保存为草稿。发布前会读取服务端检查结果。`
    : `发布前会读取“${target?.name ?? ''}”的服务端检查结果。`
  const errorCopy = imported
    ? '商品已导入并保存为草稿，发布检查暂时失败。可重试或稍后在商品列表继续。'
    : '发布检查暂时失败。可重试或稍后处理。'

  return (
    <Dialog
      open={open && target != null}
      onOpenChange={(next) => {
        if (!next && !publishing) onClose()
      }}
    >
      <DialogContent className="max-w-lg" data-testid="admin-publication-dialog">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>

        <div className="mt-5 space-y-4">
          {loadState === 'loading' && (
            <p
              className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]"
              data-testid="admin-publication-loading"
            >
              <Loader2 className="w-4 h-4 animate-spin" />
              正在获取发布检查…
            </p>
          )}

          {loadState === 'error' && (
            <p
              className="rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-sm text-[var(--color-text)]"
              data-testid="admin-publication-error"
            >
              {errorCopy}
            </p>
          )}

          {publishSucceeded && (
            <p
              className="rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-sm text-[var(--color-text)]"
              data-testid="admin-publication-refresh-error"
            >
              已发布到商城，但商品列表刷新失败。请重试刷新，不要再次发布。
            </p>
          )}

          {loadState === 'loaded' && readiness && !publishSucceeded && (
            <ProductPublicationChecklist
              issues={readiness.issues}
              ready={readiness.ready}
              onPublish={() => { void handlePublish() }}
              publishing={publishing}
              offerNames={offerNames}
              publishLabel="发布到商城"
            />
          )}

          <div className="flex flex-wrap justify-end gap-2">
            {publishSucceeded && (
              <button
                type="button"
                className="btn-primary px-4 py-2"
                data-testid="admin-publication-refresh-list"
                disabled={publishing}
                onClick={() => { void retryPublishedRefresh() }}
              >
                {publishing ? '刷新中…' : '刷新列表'}
              </button>
            )}
            {(loadState === 'error' || (loadState === 'loaded' && readiness?.ready !== true && !publishSucceeded)) && target && (
              <button
                type="button"
                className="btn-secondary px-4 py-2"
                data-testid="admin-publication-retry"
                disabled={publishing}
                onClick={() => { void loadReadiness(target.id) }}
              >
                重新检查
              </button>
            )}
            <button
              type="button"
              className="btn-secondary px-4 py-2"
              data-testid="admin-publication-later"
              disabled={publishing}
              onClick={onClose}
            >
              稍后处理
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
