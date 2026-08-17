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
  const publishingRef = useRef(false)
  const loadGuard = useRef(createLatestRequestGuard()).current
  const targetId = target?.id ?? null

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
    if (!open || targetId == null) {
      loadGuard.invalidate()
      setLoadState('idle')
      setReadiness(null)
      setPublishing(false)
      publishingRef.current = false
      return
    }
    void loadReadiness(targetId)
    return () => {
      loadGuard.invalidate()
    }
  }, [open, targetId, loadGuard])

  async function handlePublish() {
    if (!target || readiness?.ready !== true || publishingRef.current) return
    publishingRef.current = true
    setPublishing(true)
    try {
      const result = await publishAdminProduct(target.id)
      await onPublished({ id: result.id, name: target.name, status: result.status })
      onClose()
    } catch (error) {
      const status = httpStatus(error)
      if (status === 422 || getApiErrorCode(error) === 'PRODUCT_NOT_READY') {
        const fallback = readinessErrorToIssues(error)
        if (fallback.length > 0) {
          setReadiness({ ready: false, productId: target.id, issues: fallback })
          setLoadState('loaded')
        }
        await loadReadiness(target.id)
      } else if (status === 409) {
        showToast(getApiErrorMessage(error, '商品状态已变化，请刷新后重试'), 'error')
        await loadReadiness(target.id)
      } else {
        showToast(getApiErrorMessage(error, '发布失败，请稍后重试'), 'error')
      }
    } finally {
      publishingRef.current = false
      setPublishing(false)
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

          {loadState === 'loaded' && readiness && (
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
            {(loadState === 'error' || (loadState === 'loaded' && readiness?.ready !== true)) && target && (
              <button
                type="button"
                className="btn-secondary px-4 py-2"
                data-testid="admin-publication-retry"
                disabled={publishing || loadState === 'loading'}
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
